import { describe, expect, it } from "vitest";
import { type LatLon, bearingDeg, destinationPoint, haversineKm } from "../../shared/geo.ts";
import type { RunwayEnd } from "../data/importRunways.ts";
import { RUNWAY_ENDS, runwayEndsFor } from "../data/runways.ts";
import {
  APPROACH_END_WINDOW_DEG,
  APPROACH_MAX_DISTANCE_KM,
  DEPARTURE_MAX_DISTANCE_KM,
  DEPARTURE_SECTOR_DEG,
  MIN_TOLERANCE_DEG,
  SCORE_DISTANCE_WEIGHT,
  runwayBearingDeg,
  runwayCandidates,
  selectRunway,
  toleranceDeg,
} from "./runway.ts";

/** 進入で使う昇降率（降下中）と、出発で使う昇降率（上昇中） */
const DESCENDING_FPM = -700;
const CLIMBING_FPM = 1500;

function endOf(icao: string, ident: string): RunwayEnd {
  const end = RUNWAY_ENDS.find((other) => other.icao === icao && other.ident === ident);
  if (!end) {
    throw new Error(`${icao} ${ident} が RUNWAY_ENDS に無い`);
  }
  return end;
}

/** 滑走路の真方位（自端 → 対向端）。見つからなければ落とす */
function trueBearingOf(end: RunwayEnd): number {
  const bearing = runwayBearingDeg(end, RUNWAY_ENDS);
  if (bearing === undefined) {
    throw new Error(`${end.icao} ${end.ident} の対向端が無い`);
  }
  return bearing;
}

const normalizeDeg = (deg: number): number => ((deg % 360) + 360) % 360;

/**
 * 進入してくる機体を**合成**する（AC-P2-25 / 27）。
 *
 * - 滑走路端から「進入方向の逆向き（真方位 + 180°）± spreadDeg」に distanceKm だけ離れた点に機体を置く。
 * - 進行方向は「滑走路の真方位 + headingOffDeg」。`windowDeg` を渡したときだけ
 *   「機体 → 滑走路端」の方位を基準にずらす（滑走路端の方向の窓 ±20° を境界で試すため）。
 *
 * 使うのは src/shared/geo.ts の destinationPoint / bearingDeg だけで、候補条件・許容ズレ・採点式は
 * 参照しない（参照すると推定式の再実装になり、テストが自己言及になる）。
 * 機体を**滑走路端の座標を基準に**置くので、スナップショットの絶対精度には依存しない（AC-P2-27）。
 */
function approachingAircraft(
  end: RunwayEnd,
  args: { distanceKm: number; headingOffDeg?: number; spreadDeg?: number; windowDeg?: number },
): { position: LatLon; trackDeg: number } {
  const bearing = trueBearingOf(end);
  const position = destinationPoint(end, bearing + 180 + (args.spreadDeg ?? 0), args.distanceKm);
  const trackDeg =
    args.windowDeg === undefined
      ? bearing + (args.headingOffDeg ?? 0)
      : bearingDeg(position, end) + args.windowDeg;
  return { position, trackDeg: normalizeDeg(trackDeg) };
}

/**
 * 出発していく機体を合成する。滑走路端から「離陸方向（真方位）± sectorDeg」に distanceKm だけ離れた点に置き、
 * 進行方向は滑走路の真方位から headingOffDeg だけずらす。合成に使うのは destinationPoint だけ。
 */
function departingAircraft(
  end: RunwayEnd,
  args: { distanceKm: number; sectorDeg?: number; headingOffDeg?: number },
): { position: LatLon; trackDeg: number } {
  const bearing = trueBearingOf(end);
  return {
    position: destinationPoint(end, bearing + (args.sectorDeg ?? 0), args.distanceKm),
    trackDeg: normalizeDeg(bearing + (args.headingOffDeg ?? 0)),
  };
}

/** 進入の候補（既定では 12 端すべてを渡す） */
function arrivalCandidates(aircraft: { position: LatLon; trackDeg: number }, ends: readonly RunwayEnd[] = RUNWAY_ENDS) {
  return runwayCandidates({ ...aircraft, verticalRateFpm: DESCENDING_FPM, phase: "arrival" }, ends);
}

/** 出発の候補（既定では 12 端すべてを渡す） */
function departureCandidates(
  aircraft: { position: LatLon; trackDeg: number },
  ends: readonly RunwayEnd[] = RUNWAY_ENDS,
) {
  return runwayCandidates({ ...aircraft, verticalRateFpm: CLIMBING_FPM, phase: "departure" }, ends);
}

const identsOf = (candidates: { end: RunwayEnd }[]): string[] => candidates.map((candidate) => candidate.end.ident);

describe("AC-P2-22: 許容ズレ = max(3, 20 − 距離km × 0.4)", () => {
  it.each([
    [0, 20],
    [10, 16],
    [30, 8],
    [42.5, 3],
    [60, 3],
  ])("%skm で %s°", (distanceKm, expected) => {
    expect(toleranceDeg(distanceKm)).toBeCloseTo(expected, 10);
  });

  it(`下限は ${MIN_TOLERANCE_DEG}°（どれだけ遠くてもこれ以上は狭めない）`, () => {
    expect(toleranceDeg(42.4)).toBeGreaterThan(MIN_TOLERANCE_DEG);
    expect(toleranceDeg(42.6)).toBe(MIN_TOLERANCE_DEG);
    expect(toleranceDeg(1000)).toBe(MIN_TOLERANCE_DEG);
  });
});

describe("runwayBearingDeg: 真方位は自端 → 対向端の座標から計算する", () => {
  it("RJTT 22 は約 215°、対向の 04 は約 35°（互いに約 180° 違う）", () => {
    expect(trueBearingOf(endOf("RJTT", "22"))).toBeCloseTo(214.9, 1);
    expect(trueBearingOf(endOf("RJTT", "04"))).toBeCloseTo(34.9, 1);
  });

  it("対向端が渡された配列に無ければ undefined（例外にしない）", () => {
    expect(runwayBearingDeg(endOf("RJTT", "22"), [endOf("RJTT", "22")])).toBeUndefined();
  });
});

describe("AC-P2-20: 進入の候補条件", () => {
  it("延長線上を滑走路端へ真っ直ぐ降りてくる機体は候補になる", () => {
    const candidates = arrivalCandidates(approachingAircraft(endOf("RJTT", "22"), { distanceKm: 10 }));
    expect(identsOf(candidates)).toEqual(["22"]);
    expect(candidates[0]?.distanceKm).toBeCloseTo(10, 3);
    expect(candidates[0]?.headingOffDeg).toBeCloseTo(0, 3);
  });

  it("降下していなければ（昇降率 −200fpm ちょうど）候補は無い", () => {
    const aircraft = approachingAircraft(endOf("RJTT", "22"), { distanceKm: 10 });
    expect(runwayCandidates({ ...aircraft, verticalRateFpm: -200, phase: "arrival" }, RUNWAY_ENDS)).toEqual([]);
    expect(
      identsOf(runwayCandidates({ ...aircraft, verticalRateFpm: -200.1, phase: "arrival" }, RUNWAY_ENDS)),
    ).toEqual(["22"]);
  });

  it("上昇中の機体は進入の候補にならない", () => {
    const aircraft = approachingAircraft(endOf("RJTT", "22"), { distanceKm: 10 });
    expect(runwayCandidates({ ...aircraft, verticalRateFpm: CLIMBING_FPM, phase: "arrival" }, RUNWAY_ENDS)).toEqual([]);
  });

  it(`滑走路端の方向が進行方向の ±${APPROACH_END_WINDOW_DEG}° ちょうどまでは候補（以内が条件）`, () => {
    // 延長線から 18° 外した位置に置き、進行方向を「機体 → 滑走路端」からさらに ±20° ずらす。
    // こうすると方位のズレは 2° 前後（許容内）のまま、滑走路端の方向だけを境界へ寄せられる。
    for (const [spreadDeg, windowDeg] of [
      [18, -APPROACH_END_WINDOW_DEG],
      [-18, APPROACH_END_WINDOW_DEG],
    ]) {
      const aircraft = approachingAircraft(endOf("RJTT", "22"), { distanceKm: 5, spreadDeg, windowDeg });
      expect(identsOf(arrivalCandidates(aircraft))).toEqual(["22"]);
    }
  });

  it(`滑走路端の方向が進行方向から ${APPROACH_END_WINDOW_DEG}° を超えると候補から外れる`, () => {
    for (const [spreadDeg, windowDeg] of [
      [18, -(APPROACH_END_WINDOW_DEG + 0.1)],
      [-18, APPROACH_END_WINDOW_DEG + 0.1],
    ]) {
      const aircraft = approachingAircraft(endOf("RJTT", "22"), { distanceKm: 5, spreadDeg, windowDeg });
      expect(arrivalCandidates(aircraft)).toEqual([]);
    }
  });

  it(`距離 ${APPROACH_MAX_DISTANCE_KM}km を超えると候補にならない`, () => {
    // 境界ちょうどの点は測地線の往復で 1e-13 程度の誤差が出るので、内側・外側 0.1km で境界の位置を示す
    expect(identsOf(arrivalCandidates(approachingAircraft(endOf("RJTT", "22"), { distanceKm: 34.9 })))).toEqual(["22"]);
    expect(arrivalCandidates(approachingAircraft(endOf("RJTT", "22"), { distanceKm: 35.1 }))).toEqual([]);
  });

  it("方位のズレが許容（10km なら 16°）に達すると候補から外れる", () => {
    const end = endOf("RJTT", "22");
    const on = destinationPoint(end, trueBearingOf(end) + 180, 10);
    for (const off of [15.99, -15.99]) {
      const aircraft = { position: on, trackDeg: normalizeDeg(trueBearingOf(end) + off) };
      expect(identsOf(arrivalCandidates(aircraft))).toEqual(["22"]);
    }
    for (const off of [16.01, -16.01]) {
      const aircraft = { position: on, trackDeg: normalizeDeg(trueBearingOf(end) + off) };
      expect(arrivalCandidates(aircraft)).toEqual([]);
    }
  });
});

describe("AC-P2-21: 出発の候補条件", () => {
  it("離陸方向の延長線上を上昇していく機体は候補になる", () => {
    const candidates = departureCandidates(departingAircraft(endOf("RJTT", "16L"), { distanceKm: 8 }));
    expect(identsOf(candidates)[0]).toBe("16L");
  });

  it("上昇していなければ（昇降率 +200fpm ちょうど）候補は無い", () => {
    const aircraft = departingAircraft(endOf("RJTT", "16L"), { distanceKm: 8 });
    expect(runwayCandidates({ ...aircraft, verticalRateFpm: 200, phase: "departure" }, RUNWAY_ENDS)).toEqual([]);
    expect(
      identsOf(runwayCandidates({ ...aircraft, verticalRateFpm: 200.1, phase: "departure" }, RUNWAY_ENDS))[0],
    ).toBe("16L");
  });

  it("降下中の機体は出発の候補にならない", () => {
    const aircraft = departingAircraft(endOf("RJTT", "16L"), { distanceKm: 8 });
    expect(runwayCandidates({ ...aircraft, verticalRateFpm: DESCENDING_FPM, phase: "departure" }, RUNWAY_ENDS)).toEqual(
      [],
    );
  });

  it(`滑走路端から見て離陸方向 ±${DEPARTURE_SECTOR_DEG}° までは候補（以内が条件）`, () => {
    // +35° ちょうどは destinationPoint の逆算がそのまま効くので境界そのものを置ける。
    // −35° ちょうどは往復の丸め誤差で「35° より大きい」側に落ちるため、内側は 34.9° で示す。
    expect(
      identsOf(departureCandidates(departingAircraft(endOf("RJTT", "16L"), { distanceKm: 5, sectorDeg: DEPARTURE_SECTOR_DEG }))),
    ).toContain("16L");
    expect(
      identsOf(
        departureCandidates(departingAircraft(endOf("RJTT", "16L"), { distanceKm: 5, sectorDeg: -(DEPARTURE_SECTOR_DEG - 0.1) })),
      ),
    ).toContain("16L");
  });

  it(`滑走路端から見て離陸方向 ${DEPARTURE_SECTOR_DEG}° を超えると候補から外れる`, () => {
    for (const sectorDeg of [DEPARTURE_SECTOR_DEG + 0.2, -(DEPARTURE_SECTOR_DEG + 0.2)]) {
      const candidates = departureCandidates(departingAircraft(endOf("RJTT", "16L"), { distanceKm: 5, sectorDeg }));
      expect(identsOf(candidates)).not.toContain("16L");
    }
  });

  it(`距離 ${DEPARTURE_MAX_DISTANCE_KM}km を超えると候補にならない`, () => {
    expect(identsOf(departureCandidates(departingAircraft(endOf("RJTT", "16L"), { distanceKm: 24.9 })))).toEqual([
      "16L",
    ]);
    expect(departureCandidates(departingAircraft(endOf("RJTT", "16L"), { distanceKm: 25.1 }))).toEqual([]);
  });

  it("進入より遠くまで見ない（進入なら候補になる 30km でも出発では候補にならない）", () => {
    const end = endOf("RJTT", "16L");
    expect(identsOf(arrivalCandidates(approachingAircraft(end, { distanceKm: 30 })))).toContain("16L");
    expect(departureCandidates(departingAircraft(end, { distanceKm: 30 }))).toEqual([]);
  });
});

describe("AC-P2-23: 採点 = 方位のズレ + 距離km × 0.3", () => {
  it("採点の昇順に並び、最小のものが選ばれる", () => {
    // 羽田 23 の延長線 19.9km（spec §6.2-6 の SKY706）。22 も候補に入るが、採点で 23 が勝つ
    const aircraft = approachingAircraft(endOf("RJTT", "23"), { distanceKm: 19.9, windowDeg: 0 });
    const candidates = arrivalCandidates(aircraft);
    expect(identsOf(candidates)).toEqual(["23", "22"]);
    expect(candidates[0]!.score).toBeLessThan(candidates[1]!.score);
    expect(selectRunway({ ...aircraft, verticalRateFpm: DESCENDING_FPM, phase: "arrival" }, RUNWAY_ENDS)).toEqual(
      candidates[0],
    );
  });

  it("採点はズレと距離から決まる（距離の重み 0.3）", () => {
    const candidates = arrivalCandidates(approachingAircraft(endOf("RJTT", "23"), { distanceKm: 19.9 }));
    for (const candidate of candidates) {
      expect(candidate.score).toBeCloseTo(candidate.headingOffDeg + candidate.distanceKm * SCORE_DISTANCE_WEIGHT, 10);
    }
  });

  it("候補が無ければ selectRunway は undefined", () => {
    const aircraft = approachingAircraft(endOf("RJTT", "22"), { distanceKm: 35.1 });
    expect(selectRunway({ ...aircraft, verticalRateFpm: DESCENDING_FPM, phase: "arrival" }, RUNWAY_ENDS)).toBeUndefined();
  });
});

/**
 * AC-P2-25 / 26 / 27: 公示された 5 ケースの判別テスト。
 *
 * **入力は合成であり、実測の生値ではない。** docs/spec.md §6.2-6 / §6.5 の表に残っているのは
 * 便名・高度・推定結果・距離・ズレだけで、緯度・経度・進行方向・昇降率は残っていない。
 * そこで「距離とズレの両方が公示されている 5 行」について、公示された滑走路端を基準に
 * 「進入方向の逆向きに距離 d」の点へ機体を置き、進行方向を「滑走路の真方位 + Δ」にして合成した。
 *
 * このテストが主張できるのは「公示された 5 ケースが候補条件を通り、採点式が **12 本ある滑走路端の中から**
 * 公示どおりの 1 本を選ぶこと」。羽田は 16L/16R/34L/34R と 04/22・05/23 が近い方位で並ぶので、
 * 実質的な判別テストになる。**実測の生データとの一致や、ズレの数値そのものの再現は主張できない。**
 * 機体は滑走路端の座標を基準に置くので、スナップショット（OurAirports）の絶対精度にも依存しない。
 */
describe("AC-P2-25: 公示された 5 ケース（合成入力）", () => {
  it("12 本の滑走路端を渡している（羽田 8 ＋ 成田 4）", () => {
    expect(RUNWAY_ENDS).toHaveLength(12);
    expect(runwayEndsFor("RJTT")).toHaveLength(8);
    expect(runwayEndsFor("RJAA")).toHaveLength(4);
  });

  it.each([
    ["ANA642", "22", 1.0, 0.3],
    ["JAL38", "22", 10.7, 0.1],
    ["SKY706", "23", 19.9, 1.0],
    ["ANA862", "22", 21.5, 0.2],
  ] as const)("%s（%s 進入・%skm・ズレ %s°）は 12 本の中から公示どおりの端を選ぶ", (_name, ident, distanceKm, delta) => {
    const aircraft = approachingAircraft(endOf("RJTT", ident), { distanceKm, headingOffDeg: delta });
    const best = selectRunway({ ...aircraft, verticalRateFpm: DESCENDING_FPM, phase: "arrival" }, RUNWAY_ENDS);
    expect(best?.end).toEqual(endOf("RJTT", ident));
    expect(best?.distanceKm).toBeCloseTo(distanceKm, 2);
    expect(best?.headingOffDeg).toBeCloseTo(delta, 2);
  });

  it("AC-P2-26: SKY102（31.8km・ズレ +12.6°）は許容ズレ 7.28° を超えるので RWY23 が候補にならない", () => {
    const end = endOf("RJTT", "23");
    const aircraft = approachingAircraft(end, { distanceKm: 31.8, headingOffDeg: 12.6 });
    const candidates = arrivalCandidates(aircraft);
    expect(toleranceDeg(haversineKm(aircraft.position, end))).toBeCloseTo(7.28, 2);
    expect(identsOf(candidates)).not.toContain("23");
    // このケースは他の端も条件を通らないので、滑走路は決まらない（誤判定を出さない）
    expect(candidates).toEqual([]);
  });

  it("AC-P2-26 の対照: 同じ 31.8km でもズレが許容内（7.2°）なら RWY23 が候補になる", () => {
    const aircraft = approachingAircraft(endOf("RJTT", "23"), { distanceKm: 31.8, headingOffDeg: 7.2 });
    expect(identsOf(arrivalCandidates(aircraft))).toContain("23");
  });
});

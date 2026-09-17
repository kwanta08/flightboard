import { describe, expect, it } from "vitest";
import { type LatLon, bearingDeg, crossTrackKm, destinationPoint, haversineKm } from "../../shared/geo.ts";
import type { RunwayEnd } from "../data/importRunways.ts";
import { RUNWAY_ENDS, runwayEndsFor } from "../data/runways.ts";
import {
  APPROACH_END_WINDOW_DEG,
  APPROACH_MAX_DISTANCE_KM,
  DEPARTURE_MAX_DISTANCE_KM,
  DEPARTURE_SECTOR_DEG,
  DEPARTURE_TRACK_MAX_KM,
  DEPARTURE_TRACK_MAX_XTK_KM,
  MIN_TOLERANCE_DEG,
  RUNWAY_SIDE_MARGIN_KM,
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

/**
 * 滑走路の真方位（自端 → 対向端）を**テスト側で**計算する。
 * 実装の `runwayBearingDeg` は使わない（AC-P2-25 の「ヘルパが使ってよいのは bearingDeg / haversineKm /
 * destinationPoint だけ」という制約。実装を呼ぶと、対向端の探索が退行しても
 * 機体を同じ誤った線上に置いてしまい、テストが緑のまま素通りする）。
 */
function trueBearingOf(end: RunwayEnd): number {
  return bearingDeg(end, endOf(end.icao, end.oppositeIdent));
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

/** 対向端（テスト側で引く。実装の探索が退行しても同じ誤りを再現しないため） */
const oppositeOf = (end: RunwayEnd): RunwayEnd => endOf(end.icao, end.oppositeIdent);

type Aircraft = { position: LatLon; trackDeg: number };

/** 進入の選択（12 端すべてを渡す）。track は単独の組が航跡に影響されないことを見るために渡す */
function arrivalSelection(aircraft: Aircraft, track?: readonly LatLon[]) {
  return selectRunway({ ...aircraft, verticalRateFpm: DESCENDING_FPM, phase: "arrival", track }, RUNWAY_ENDS);
}

/** 出発の選択（12 端すべてを渡す）。track を渡さなければ Phase 2 と同じ入力 */
function departureSelection(aircraft: Aircraft, track?: readonly LatLon[]) {
  return selectRunway({ ...aircraft, verticalRateFpm: CLIMBING_FPM, phase: "departure", track }, RUNWAY_ENDS);
}

/**
 * 出発機の合成航跡の 1 点。**滑走路上には置かない**（地上滑走中の位置は航跡に入らないので、
 * 航跡の最初の点は「最初の空中の位置通報」になる。plan §「出発の基準点としきい値の導出」の前提の訂正）。
 * 対向端を基準に、離陸方向へ alongKm（負なら対向端の手前）進み、中心線から offsetKm だけ横へずらす。
 * 使うのは destinationPoint だけ（実装側の関数を経由すると自己参照になる）。
 */
function departureTrackPoint(end: RunwayEnd, args: { alongKm: number; offsetKm?: number }): LatLon {
  const bearing = trueBearingOf(end);
  const onCenterline = destinationPoint(oppositeOf(end), bearing, args.alongKm);
  return args.offsetKm === undefined ? onCenterline : destinationPoint(onCenterline, bearing + 90, args.offsetKm);
}

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
    expect(runwayBearingDeg(endOf("RJTT", "22"), RUNWAY_ENDS)).toBeCloseTo(214.9, 1);
    expect(runwayBearingDeg(endOf("RJTT", "04"), RUNWAY_ENDS)).toBeCloseTo(34.9, 1);
  });

  it("12 端すべてを渡しても、対向端は同じ空港の中から引く（RJAA 16L → 約 150°）", () => {
    // 退行の形: 対向端の探索から icao の一致が落ちると、RJAA 16L の対向「34R」が
    // RUNWAY_ENDS で先に並ぶ RJTT 34R に解決され、真方位が「成田 → 羽田」の約 241° になる。
    const narita16L = endOf("RJAA", "16L");
    expect(runwayBearingDeg(narita16L, RUNWAY_ENDS)).toBeCloseTo(150.1, 1);
    expect(bearingDeg(narita16L, endOf("RJTT", "34R"))).toBeCloseTo(240.8, 1);
  });

  it("12 端すべてで、同じ空港の oppositeIdent へ向いた方位と一致する", () => {
    expect(RUNWAY_ENDS).toHaveLength(12);
    for (const end of RUNWAY_ENDS) {
      // 期待値はテスト側で引いた対向端（icao と oppositeIdent の両方で一致するもの）から直接計算する
      expect(runwayBearingDeg(end, RUNWAY_ENDS)).toBe(bearingDeg(end, endOf(end.icao, end.oppositeIdent)));
    }
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
    // 外側は他の境界（35.1km / 20.1°）と同じ 0.1 のはみ出しで示す
    for (const sectorDeg of [DEPARTURE_SECTOR_DEG + 0.1, -(DEPARTURE_SECTOR_DEG + 0.1)]) {
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
    // selectRunway の戻りは RunwayCandidate に runway / decided / capConfidence を足した形なので、
    // 候補そのものとは toEqual で一致しない（P1b の戻り型変更。AC-P3-06）。採点で選んだ端が同じことを見る
    const selection = selectRunway({ ...aircraft, verticalRateFpm: DESCENDING_FPM, phase: "arrival" }, RUNWAY_ENDS);
    expect(selection?.end).toEqual(candidates[0]!.end);
    expect(selection?.score).toBe(candidates[0]!.score);
  });

  it("採点はズレと距離から決まる（距離の重み 0.3）", () => {
    const candidates = arrivalCandidates(approachingAircraft(endOf("RJTT", "23"), { distanceKm: 19.9 }));
    for (const candidate of candidates) {
      expect(candidate.score).toBeCloseTo(candidate.headingOffDeg + candidate.distanceKm * SCORE_DISTANCE_WEIGHT, 10);
    }
  });

  it("採点の値は公示値から独立に決まる（SKY706: 1.0° + 19.9km × 0.3 = 6.97）", () => {
    // 期待値は spec §6.2-6 の公示値（19.9km・ズレ 1.0°）と §10.2 の式だけから出す（実装の定数を使わない）
    const aircraft = approachingAircraft(endOf("RJTT", "23"), { distanceKm: 19.9, headingOffDeg: 1.0 });
    const best = selectRunway({ ...aircraft, verticalRateFpm: DESCENDING_FPM, phase: "arrival" }, RUNWAY_ENDS);
    expect(best?.end.ident).toBe("23");
    expect(best?.score).toBeCloseTo(6.97, 6);
  });

  it("距離の重みが順位を決める（ズレは大きいが近い端が、ズレは小さいが遠い端に勝つ）", () => {
    // 成田の平行滑走路 34L / 34R は真方位が約 1.05° しか違わないので、同じ機体が両方の候補になる。
    // 34L の延長線 28km・ズレ +2.0° に置くと、34R はズレが約 0.95° と小さい代わりに約 4.1km 遠い。
    // 距離の項の差（約 4.1 × 0.3 = 1.23）がズレの差（約 1.05）を上回るので、近い 34L が勝つ。
    const aircraft = approachingAircraft(endOf("RJAA", "34L"), { distanceKm: 28, headingOffDeg: 2 });
    const candidates = arrivalCandidates(aircraft);
    expect(identsOf(candidates)).toEqual(["34L", "34R"]);
    expect(candidates[0]!.headingOffDeg).toBeGreaterThan(candidates[1]!.headingOffDeg);
    expect(candidates[0]!.distanceKm).toBeLessThan(candidates[1]!.distanceKm);
    expect(candidates[0]!.score).toBeCloseTo(2 + 28 * 0.3, 6); // 10.4
    // 距離の重みが 0 ならズレだけの順になり、順位は入れ替わる（＝この並びは重みが決めている）
    expect([...candidates].sort((a, b) => a.headingOffDeg - b.headingOffDeg).map((c) => c.end.ident)).toEqual([
      "34R",
      "34L",
    ]);
  });

  it("候補が無ければ selectRunway は undefined", () => {
    const aircraft = approachingAircraft(endOf("RJTT", "22"), { distanceKm: 35.1 });
    expect(selectRunway({ ...aircraft, verticalRateFpm: DESCENDING_FPM, phase: "arrival" }, RUNWAY_ENDS)).toBeUndefined();
  });
});

/**
 * **並行滑走路は「組」にまとめ、L/R は中心線からの横ずれで決める**（AC-P3-01〜06 / 12）。
 *
 * spec §10.2 の採点式 `方位のズレ + 距離km × 0.3`（AC-P2-23）には**横方向のずれが入っていない**。
 * 並行滑走路の端は滑走路軸の方向にも 0.2〜0.5km ずれて並ぶので、距離の項の差が真方位差
 * （羽田 0.02°・成田 1.06°）を上回り、**端ごとの採点では隣の端が先頭に来る**（下の `scoredFirst`）。
 * Phase 2 はこれを「既知の妥協 2」として固定していた（plan v9）。
 *
 * **だから組の規則が要る**: 同じ空港・同じ数字の全端を 1 つの組にまとめ、組の勝敗は最良の端の採点で決め、
 * 組の中の L/R は進入なら現在位置・出発なら航跡の基準点の横ずれで決める。
 * 採点式そのものは変えていないので、`runwayCandidates` の先頭は隣の端のままであることも併せて固定する。
 *
 * 機体の合成に使うのは bearingDeg / haversineKm / destinationPoint / crossTrackKm だけ
 * （実装側の関数を経由すると自己参照になり、判別が退行しても緑のまま素通りする）。
 */
describe("AC-P3-12: 並行滑走路でも正しい端が選ばれる（端ごとの採点は隣の端のまま）", () => {
  it.each([
    { icao: "RJTT", ident: "16L", scoredFirst: "16R" },
    { icao: "RJTT", ident: "34L", scoredFirst: "34R" },
    { icao: "RJAA", ident: "34R", scoredFirst: "34L" },
    // 成田 16L は真方位差が 1.06° あるので端ごとの採点でも自分が勝つ（組の規則で壊れないことを見る）
    { icao: "RJAA", ident: "16L", scoredFirst: "16L" },
  ])("進入: $icao $ident の延長線上 30km（端ごとの採点の先頭は $scoredFirst）", ({ icao, ident, scoredFirst }) => {
    const end = endOf(icao, ident);
    const aircraft = approachingAircraft(end, { distanceKm: 30 });
    const candidates = arrivalCandidates(aircraft);
    expect(identsOf(candidates)[0]).toBe(scoredFirst);

    // 機体は ident の中心線にぴったり乗っていて、隣の中心線からは 1.6km 以上離れている
    const neighbour = candidates.map((candidate) => candidate.end).find((other) => other.ident !== ident)!;
    expect(crossTrackKm(aircraft.position, end, oppositeOf(end))).toBeCloseTo(0, 3);
    expect(crossTrackKm(aircraft.position, neighbour, oppositeOf(neighbour))).toBeGreaterThan(1.6);

    const selection = arrivalSelection(aircraft);
    expect(selection?.end).toEqual(end);
    expect(selection?.runway).toBe(ident);
    expect(selection?.decided).toBe(true);
    // 並行の組は進入でも 1 点の横ずれに依存する（隣の中心線側へ 1.0km ずれれば隣を選ぶ）ので、
    // 確度は中止まり（plan v5 AC-P3-07。組の端が 2 つ以上なら決めても上限を掛ける）
    expect(selection?.capConfidence).toBe(true);
    expect(selection?.sideEvidence).toBe("中心線から 0.0km");
  });

  it("出発: RJTT 34R の延長線上 5km は、航跡があれば 34R が選ばれる（採点の先頭は 34L のまま）", () => {
    const end = endOf("RJTT", "34R");
    const aircraft = departingAircraft(end, { distanceKm: 5 });
    const candidates = departureCandidates(aircraft);
    expect(identsOf(candidates)[0]).toBe("34L");

    const selection = departureSelection(aircraft, [departureTrackPoint(end, { alongKm: 1 })]);
    expect(selection?.end).toEqual(end);
    expect(selection?.runway).toBe("34R");
    expect(selection?.decided).toBe(true);
    // 並行の組は誤判別帯が残るので確度に上限を掛ける（AC-P3-07）
    expect(selection?.capConfidence).toBe(true);
    expect(selection?.sideEvidence).toBe("離陸直後 中心線から 0.0km");
    // 選ばれた端は組内で採点最小の端ではない（AC-P3-10 の「違うことがある」）
    expect(selection?.score).toBeGreaterThan(candidates[0]!.score);
  });

  it("端ごとの採点で隣が勝つ理由は距離の項（採点式は変えていない）", () => {
    const end = endOf("RJTT", "16L");
    const candidates = arrivalCandidates(approachingAircraft(end, { distanceKm: 30 }));
    const intended = candidates.find((candidate) => candidate.end.ident === "16L")!;
    const chosen = candidates[0]!;
    expect(chosen.end.ident).toBe("16R");
    expect(intended.headingOffDeg).toBeCloseTo(0, 3);
    expect(intended.distanceKm).toBeCloseTo(30, 3);
    expect(chosen.headingOffDeg).toBeGreaterThan(intended.headingOffDeg);
    expect(chosen.headingOffDeg).toBeLessThan(1.1);
    expect(chosen.distanceKm).toBeLessThan(intended.distanceKm);
    expect((intended.distanceKm - chosen.distanceKm) * SCORE_DISTANCE_WEIGHT).toBeGreaterThan(
      chosen.headingOffDeg - intended.headingOffDeg,
    );
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

/** 並行の組の「滑走路の端」（組の各端 ∪ それぞれの対向端）。羽田・成田とも同じ 4 つの指示子になる */
const PARALLEL_ENDS = ["16L", "16R", "34L", "34R"] as const;

/** 組の滑走路の端までの最短距離（km）。しきい値をテスト側で測る（実装の組分けは経由しない） */
function nearestRunwayEndKm(point: LatLon, icao: string, idents: readonly string[] = PARALLEL_ENDS): number {
  return Math.min(...idents.map((ident) => haversineKm(point, endOf(icao, ident))));
}

describe("AC-P3-01 / 08: 単独の組（羽田 04 / 22 / 05 / 23）は Phase 2 と同じ", () => {
  it.each(["04", "22", "05", "23"])("進入: %s は ident がそのまま runway になり、判別の行は付かない", (ident) => {
    const end = endOf("RJTT", ident);
    const aircraft = approachingAircraft(end, { distanceKm: 10 });
    const selection = arrivalSelection(aircraft);
    expect(selection?.end).toEqual(end);
    expect(selection?.runway).toBe(ident);
    expect(selection?.decided).toBe(true);
    expect(selection?.capConfidence).toBe(false);
    expect(selection?.sideEvidence).toBeUndefined();
    // 航跡を渡しても渡さなくても同じ（AC-P3-08）
    expect(arrivalSelection(aircraft, [departureTrackPoint(end, { alongKm: 1 })])).toEqual(selection);
  });

  it.each(["04", "22", "05", "23"])("出発: %s は航跡の有無で変わらない", (ident) => {
    const end = endOf("RJTT", ident);
    const aircraft = departingAircraft(end, { distanceKm: 8 });
    const selection = departureSelection(aircraft);
    expect(selection?.end).toEqual(end);
    expect(selection?.runway).toBe(ident);
    expect(selection?.decided).toBe(true);
    expect(selection?.capConfidence).toBe(false);
    expect(selection?.sideEvidence).toBeUndefined();
    expect(departureSelection(aircraft, [departureTrackPoint(end, { alongKm: 1 })])).toEqual(selection);
  });

  it.each([
    ["ANA642", "22", 1.0, 0.3],
    ["JAL38", "22", 10.7, 0.1],
    ["SKY706", "23", 19.9, 1.0],
    ["ANA862", "22", 21.5, 0.2],
  ] as const)("§6.2-6 の公示ケース %s は runway が %s に決まる", (_name, ident, distanceKm, delta) => {
    const aircraft = approachingAircraft(endOf("RJTT", ident), { distanceKm, headingOffDeg: delta });
    const selection = arrivalSelection(aircraft);
    expect(selection?.runway).toBe(ident);
    expect(selection?.decided).toBe(true);
    expect(selection?.sideEvidence).toBeUndefined();
  });
});

describe("AC-P3-04: 進入の L/R は現在位置の横ずれで決める", () => {
  it.each([
    { icao: "RJTT", ident: "16L", neighbour: "16R" },
    { icao: "RJAA", ident: "34L", neighbour: "34R" },
  ])("$icao: 2 本の中心線の真ん中を飛ぶ機体は数字だけ（差が 0.3km 未満）", ({ icao, ident, neighbour }) => {
    const end = endOf(icao, ident);
    const neighbourEnd = endOf(icao, neighbour);
    const bearing = trueBearingOf(end);
    const onFinal = destinationPoint(end, bearing + 180, 10);
    // 隣の中心線までの実分離を測り、その半分だけ隣の側（真方位 + 90°）へずらす
    // （羽田なら横 0.85km ＝ 実分離 1.70km の半分。plan v5 §「進入側にも同じ帯がある」の境界の行）
    const separationKm = crossTrackKm(onFinal, neighbourEnd, oppositeOf(neighbourEnd));
    const position = destinationPoint(onFinal, bearing + 90, separationKm / 2);
    const aircraft = { position, trackDeg: normalizeDeg(bearing) };
    const own = crossTrackKm(position, end, oppositeOf(end));
    const other = crossTrackKm(position, neighbourEnd, oppositeOf(neighbourEnd));
    expect(own).toBeCloseTo(separationKm / 2, 2);
    expect(Math.abs(own - other)).toBeLessThan(RUNWAY_SIDE_MARGIN_KM);

    const selection = arrivalSelection(aircraft);
    expect(selection?.runway).toBe(ident.slice(0, 2));
    expect(selection?.decided).toBe(false);
    expect(selection?.capConfidence).toBe(true);
    expect(selection?.sideEvidence).toBe("L/R は判別できず");
  });

  it.each([
    { icao: "RJTT", ident: "16L", neighbour: "16R", towardNeighbour: -1 },
    { icao: "RJTT", ident: "34L", neighbour: "34R", towardNeighbour: -1 },
    { icao: "RJAA", ident: "16L", neighbour: "16R", towardNeighbour: -1 },
    { icao: "RJAA", ident: "34R", neighbour: "34L", towardNeighbour: 1 },
  ])(
    "インターセプト中（10km・扇形 5〜10°）でも誤った端を選ばない: $icao $ident",
    ({ icao, ident, neighbour, towardNeighbour }) => {
      const end = endOf(icao, ident);
      const neighbourEnd = endOf(icao, neighbour);
      // towardNeighbour の向きが本当に隣の滑走路側かを測って確かめる（符号の取り違えを検出する）
      const towardPosition = approachingAircraft(end, { distanceKm: 10, spreadDeg: 5 * towardNeighbour }).position;
      const awayPosition = approachingAircraft(end, { distanceKm: 10, spreadDeg: -5 * towardNeighbour }).position;
      expect(crossTrackKm(towardPosition, neighbourEnd, oppositeOf(neighbourEnd))).toBeLessThan(
        crossTrackKm(awayPosition, neighbourEnd, oppositeOf(neighbourEnd)),
      );

      // 隣と反対側へ 5°・10°、隣側へ 5°（＝隣の中心線に乗る手前まで）。
      // 隣側へ 10°（＝横 1.74km で隣の中心線に乗る）は誤った端を選ぶ。
      // それは下の「既知の妥協: 並行滑走路の誤判別帯」で現在の挙動として固定している
      for (const spreadDeg of [-5 * towardNeighbour, -10 * towardNeighbour, 5 * towardNeighbour]) {
        const aircraft = approachingAircraft(end, { distanceKm: 10, spreadDeg });
        const selection = arrivalSelection(aircraft);
        expect(selection?.end.icao).toBe(icao);
        // 正しい端が選ばれるか、数字だけに落ちるかのどちらか（誤った端は選ばない）
        expect([ident, ident.slice(0, 2)]).toContain(selection?.runway);
        if (selection?.decided === false) {
          const own = crossTrackKm(aircraft.position, end, oppositeOf(end));
          const other = crossTrackKm(aircraft.position, neighbourEnd, oppositeOf(neighbourEnd));
          expect(Math.abs(own - other)).toBeLessThan(RUNWAY_SIDE_MARGIN_KM);
        }
      }
    },
  );

  it.each([0.3, 0.5])("隣の中心線側へ横 %skm までは正しい端が選ばれる（RJTT 16L・10km）", (offsetKm) => {
    // 帯の手前側の境界。実分離 1.70km の半分（0.85km）− マージン 0.3km の半分 までは決まる
    const end = endOf("RJTT", "16L");
    const bearing = trueBearingOf(end);
    const position = destinationPoint(destinationPoint(end, bearing + 180, 10), bearing + 90, offsetKm);
    const selection = arrivalSelection({ position, trackDeg: normalizeDeg(bearing) });
    expect(selection?.runway).toBe("16L");
    expect(selection?.decided).toBe(true);
  });
});

describe("AC-P3-05: 出発の L/R は航跡の基準点の横ずれで決める", () => {
  it.each([
    { distanceKm: 5, sectorDeg: -10 },
    { distanceKm: 5, sectorDeg: -15 },
    { distanceKm: 8, sectorDeg: -10 },
    { distanceKm: 15, sectorDeg: -5 },
  ])("航跡が無ければ数字だけ: RJTT 34R 出発 $distanceKm km・扇形 $sectorDeg°", ({ distanceKm, sectorDeg }) => {
    const end = endOf("RJTT", "34R");
    const aircraft = departingAircraft(end, { distanceKm, sectorDeg });
    // 出発で現在位置の横ずれを使うと隣の 34L の方が近い（だから出発は航跡の基準点を使う）
    expect(crossTrackKm(aircraft.position, endOf("RJTT", "34L"), endOf("RJTT", "16R"))).toBeLessThan(
      crossTrackKm(aircraft.position, end, oppositeOf(end)),
    );
    for (const track of [undefined, []]) {
      const selection = departureSelection(aircraft, track);
      expect(selection?.runway).toBe("34");
      expect(selection?.decided).toBe(false);
      expect(selection?.capConfidence).toBe(true);
      expect(selection?.sideEvidence).toBe("L/R は判別できず");
    }
  });

  it.each([
    { icao: "RJTT", ident: "16L" },
    { icao: "RJTT", ident: "34R" },
    { icao: "RJAA", ident: "16L" },
    { icao: "RJAA", ident: "34L" },
  ])("対向端の手前 1.0km 〜 先 2.5km・中心線上の基準点なら $icao $ident が選ばれる", ({ icao, ident }) => {
    const end = endOf(icao, ident);
    const aircraft = departingAircraft(end, { distanceKm: 8 });
    for (const alongKm of [-1, 0, 1, 2.5]) {
      const reference = departureTrackPoint(end, { alongKm });
      expect(nearestRunwayEndKm(reference, icao)).toBeLessThanOrEqual(DEPARTURE_TRACK_MAX_KM);
      const selection = departureSelection(aircraft, [reference]);
      expect(selection?.end).toEqual(end);
      expect(selection?.runway).toBe(ident);
      expect(selection?.decided).toBe(true);
      expect(selection?.capConfidence).toBe(true);
      expect(selection?.sideEvidence).toBe("離陸直後 中心線から 0.0km");
    }
  });

  it.each([
    ["16L", "16"],
    ["34R", "34"],
  ])("羽田: 対向端の先 3.5km（3.0km 超え）の基準点では数字だけ（%s → %s）", (ident, number) => {
    const end = endOf("RJTT", ident);
    const reference = departureTrackPoint(end, { alongKm: 3.5 });
    expect(nearestRunwayEndKm(reference, "RJTT")).toBeGreaterThan(DEPARTURE_TRACK_MAX_KM);
    const selection = departureSelection(departingAircraft(end, { distanceKm: 8 }), [reference]);
    expect(selection?.runway).toBe(number);
    expect(selection?.decided).toBe(false);
    expect(selection?.sideEvidence).toBe("L/R は判別できず");
  });

  it("成田は組の 4 端が中心線方向にずれて並ぶので、対向端の先 3.5km でもまだ決まる", () => {
    // しきい値は「組の 4 端のうち最寄り」で測る（AC-P3-05）。RJAA 16L の対向端 34R の先 3.5km でも、
    // 隣の滑走路の端（34L）までは 3.0km 以内しかない
    const end = endOf("RJAA", "16L");
    const reference = departureTrackPoint(end, { alongKm: 3.5 });
    expect(haversineKm(reference, oppositeOf(end))).toBeGreaterThan(DEPARTURE_TRACK_MAX_KM);
    expect(nearestRunwayEndKm(reference, "RJAA")).toBeLessThan(DEPARTURE_TRACK_MAX_KM);
    const selection = departureSelection(departingAircraft(end, { distanceKm: 8 }), [reference]);
    expect(selection?.runway).toBe("16L");
    expect(selection?.decided).toBe(true);
  });

  it.each([
    { offsetKm: 0.2, runway: "16L", decided: true },
    { offsetKm: -0.2, runway: "16L", decided: true },
    { offsetKm: 0.4, runway: "16", decided: false },
    { offsetKm: -0.4, runway: "16", decided: false },
  ])("基準点が中心線から $offsetKm km ずれていると $runway（上限 0.3km）", ({ offsetKm, runway, decided }) => {
    const end = endOf("RJTT", "16L");
    const reference = departureTrackPoint(end, { alongKm: 0, offsetKm });
    expect(crossTrackKm(reference, end, oppositeOf(end))).toBeCloseTo(Math.abs(offsetKm), 2);
    expect(Math.abs(offsetKm) > DEPARTURE_TRACK_MAX_XTK_KM).toBe(!decided);
    const selection = departureSelection(departingAircraft(end, { distanceKm: 8 }), [reference]);
    expect(selection?.runway).toBe(runway);
    expect(selection?.decided).toBe(decided);
  });

  it("基準点は航跡の中で組の端に最も近い点（並び順ではない）", () => {
    const end = endOf("RJTT", "16L");
    const aircraft = departingAircraft(end, { distanceKm: 8 });
    const near = departureTrackPoint(end, { alongKm: 1 });
    const far = departureTrackPoint(end, { alongKm: 12, offsetKm: 2 });
    expect(nearestRunwayEndKm(far, "RJTT")).toBeGreaterThan(DEPARTURE_TRACK_MAX_KM);
    for (const track of [[near, far], [far, near], [far, near, far]]) {
      expect(departureSelection(aircraft, track)?.runway).toBe("16L");
    }
    expect(departureSelection(aircraft, [far])?.runway).toBe("16");
  });
});

describe("AC-P3-06 / 10: 決めないときは数字だけを返し、値は組内で採点最小の端から取る", () => {
  it.each([
    { label: "差 0.4km", overshootKm: 0.05, decided: true },
    { label: "差 0.2km", overshootKm: -0.05, decided: false },
  ])("横ずれの差が $label なら decided = $decided（境界は 0.3km）", ({ overshootKm, decided }) => {
    // 16L の中心線から「実分離の半分 − (0.3/2 ± 0.05)km」だけ 16R 側へずらすと、
    // 2 本の中心線への横ずれの差がちょうど 0.3km ± 0.1km になる
    const end = endOf("RJTT", "16L");
    const neighbourEnd = endOf("RJTT", "16R");
    const bearing = trueBearingOf(end);
    const onFinal = destinationPoint(end, bearing + 180, 10);
    const separationKm = crossTrackKm(onFinal, neighbourEnd, oppositeOf(neighbourEnd));
    const offsetKm = separationKm / 2 - (RUNWAY_SIDE_MARGIN_KM / 2 + overshootKm);
    const position = destinationPoint(onFinal, bearing + 90, offsetKm);
    const own = crossTrackKm(position, end, oppositeOf(end));
    const other = crossTrackKm(position, neighbourEnd, oppositeOf(neighbourEnd));
    expect(Math.abs(other - own)).toBeCloseTo(RUNWAY_SIDE_MARGIN_KM + 2 * overshootKm, 2);
    expect(Math.abs(other - own) >= RUNWAY_SIDE_MARGIN_KM).toBe(decided);

    const selection = arrivalSelection({ position, trackDeg: normalizeDeg(bearing) });
    expect(selection?.decided).toBe(decided);
    expect(selection?.runway).toBe(decided ? "16L" : "16");
  });

  it("決めなかったときの各値は候補の先頭（＝組内で採点最小の端）と同じ", () => {
    const aircraft = departingAircraft(endOf("RJTT", "34R"), { distanceKm: 5, sectorDeg: -10 });
    const candidates = departureCandidates(aircraft);
    expect(identsOf(candidates)[0]).toBe("34L");
    const selection = departureSelection(aircraft);
    expect(selection?.decided).toBe(false);
    expect(selection?.runway).toBe("34");
    expect(selection?.end).toEqual(candidates[0]!.end);
    expect(selection?.score).toBe(candidates[0]!.score);
    expect(selection?.headingOffDeg).toBe(candidates[0]!.headingOffDeg);
    expect(selection?.distanceKm).toBe(candidates[0]!.distanceKm);
    expect(selection?.toleranceDeg).toBe(candidates[0]!.toleranceDeg);
    expect(selection?.runwayBearingDeg).toBe(candidates[0]!.runwayBearingDeg);
  });

  it("組の中では候補条件を通らなかった端も選ばれる（AC-P3-13 (e)）", () => {
    // 25.1km は出発の距離条件（25km 未満）を外れるので 34R は候補にならないが、
    // 約 0.26km 近い 34L は候補になるので組は成立する（AC-P3-01）。航跡の基準点は 34R を指す
    const end = endOf("RJTT", "34R");
    const aircraft = departingAircraft(end, { distanceKm: 25.1 });
    expect(identsOf(departureCandidates(aircraft))).toEqual(["34L"]);

    const selection = departureSelection(aircraft, [departureTrackPoint(end, { alongKm: 1 })]);
    expect(selection?.end).toEqual(end);
    expect(selection?.runway).toBe("34R");
    expect(selection?.decided).toBe(true);
    // 候補でない端にも spec §10.2 と同じ式で値を作る（採点 = ズレ + 距離km × 0.3、許容ズレ = 20 − 距離km × 0.4）
    expect(selection?.distanceKm).toBeCloseTo(25.1, 3);
    expect(selection?.headingOffDeg).toBeCloseTo(0, 3);
    expect(selection?.runwayBearingDeg).toBeCloseTo(trueBearingOf(end), 6);
    expect(selection?.score).toBeCloseTo(25.1 * SCORE_DISTANCE_WEIGHT, 3);
    expect(selection?.toleranceDeg).toBeCloseTo(20 - 25.1 * 0.4, 3);
  });
});

describe("AC-P3-03: 組どうしの比較はその組で最良の端の採点で行う", () => {
  it("同点のときの勝者は Phase 2 と同じく ends の並び順で決まる", () => {
    // 同じ座標に 2 つの空港を置くと、採点が 1 ビットも違わない同点になる（合成。実データでは起きない）。
    // Array#sort は安定なので、Phase 2 の同点処理と同じく先に並ぶ方が勝つ
    const parallel = PARALLEL_ENDS.map((ident) => endOf("RJTT", ident));
    const twin = (icao: string): RunwayEnd[] => parallel.map((end) => ({ ...end, icao }));
    const aircraft = approachingAircraft(endOf("RJTT", "16L"), { distanceKm: 10 });
    const search = { ...aircraft, verticalRateFpm: DESCENDING_FPM, phase: "arrival" } as const;

    const ends = [...twin("ZZZA"), ...twin("ZZZB")];
    expect(runwayCandidates(search, ends)[0]?.end.icao).toBe("ZZZA");
    expect(selectRunway(search, ends)?.end).toEqual({ ...endOf("RJTT", "16L"), icao: "ZZZA" });

    const reversed = [...twin("ZZZB"), ...twin("ZZZA")];
    expect(runwayCandidates(search, reversed)[0]?.end.icao).toBe("ZZZB");
    expect(selectRunway(search, reversed)?.end).toEqual({ ...endOf("RJTT", "16L"), icao: "ZZZB" });
  });
});

/**
 * **既知の妥協: 並行滑走路の誤判別帯**（plan §「既知の妥協: 並行滑走路の誤判別帯」）。
 *
 * **望ましい挙動ではない。1 点の横ずれでは原理的に解けない**（並行滑走路は真方位が同じ
 * ＝羽田 0.02°・成田 1.06° 差なので、進行方向では区別できない）。
 *
 * - 出発: 離陸直後に隣の滑走路側へ旋回した機体の基準点は「隣を直進した機体」と同じ観測になる。
 *   しきい値（DEPARTURE_TRACK_MAX_XTK_KM）を下げても帯は消えない（0.5km で 249 格子点、0.3km で 148 格子点）。
 * - 進入: 隣の中心線側へ横 1.0〜1.2km 以上ずれた機体は隣の端を選ぶ（距離によらない。
 *   実分離 1.70km の半分 ＋ マージン 0.3km）。インターセプト中の機体は普通にこの範囲に入るので**帯は狭くない**。
 *
 * ここでは現在の挙動を固定するだけで、緩和は確度の上限（AC-P3-07。`capConfidence`）だけ。
 * **将来この帯を潰す設計（航跡を 2 点以上使う・ローカライザ確立の判定を入れる など）に変えたら、
 * このテストは意図的に落ちる。**
 */
describe("既知の妥協: 並行滑走路の誤判別帯（現在の挙動の固定。望ましい挙動ではない）", () => {
  it("RJTT 34R の端から 5km・34L 側へ 20° の 1 点だけの航跡では 34L（誤り）を選ぶ", () => {
    const end = endOf("RJTT", "34R");
    const aircraft = departingAircraft(end, { distanceKm: 5, sectorDeg: -20 });
    // その点は 34L の中心線にほぼ乗っていて、組の 4 端のうち最寄りまで 3.0km 以内しかない
    expect(crossTrackKm(aircraft.position, endOf("RJTT", "34L"), endOf("RJTT", "16R"))).toBeLessThan(
      DEPARTURE_TRACK_MAX_XTK_KM,
    );
    expect(nearestRunwayEndKm(aircraft.position, "RJTT")).toBeLessThan(DEPARTURE_TRACK_MAX_KM);

    const selection = departureSelection(aircraft, [aircraft.position]);
    expect(selection?.runway).toBe("34L");
    expect(selection?.decided).toBe(true);
    // 緩和は確度の上限だけ（AC-P3-07。適用は estimate.ts）
    expect(selection?.capConfidence).toBe(true);
  });

  it("v4 の代表点（端から 5km・34L 側へ 15°）は横ずれ 0.40km が上限 0.3km を超えるので数字だけ", () => {
    // plan v3 の表（上限 0.5km）の点。v4 が上限を 0.3km に絞った時点で帯から外れており、
    // v5 が代表点を −20° に取り直した。5km での帯は −18°〜−20° 付近（上のテスト）
    const end = endOf("RJTT", "34R");
    const aircraft = departingAircraft(end, { distanceKm: 5, sectorDeg: -15 });
    expect(crossTrackKm(aircraft.position, endOf("RJTT", "34L"), endOf("RJTT", "16R"))).toBeGreaterThan(
      DEPARTURE_TRACK_MAX_XTK_KM,
    );
    const selection = departureSelection(aircraft, [aircraft.position]);
    expect(selection?.runway).toBe("34");
    expect(selection?.decided).toBe(false);
  });

  it.each([
    { distanceKm: 10, offsetKm: 1.0 },
    { distanceKm: 10, offsetKm: 1.2 },
    { distanceKm: 20, offsetKm: 1.2 },
    { distanceKm: 30, offsetKm: 1.2 },
    { distanceKm: 10, offsetKm: 1.74 },
    { distanceKm: 20, offsetKm: 1.74 },
    { distanceKm: 30, offsetKm: 1.74 },
  ])(
    "進入: RJTT 16L の延長線 $distanceKm km で 16R 側へ横 $offsetKm km ずれた機体は 16R（誤り）を選ぶ",
    ({ distanceKm, offsetKm }) => {
      const end = endOf("RJTT", "16L");
      const neighbourEnd = endOf("RJTT", "16R");
      const bearing = trueBearingOf(end);
      const position = destinationPoint(destinationPoint(end, bearing + 180, distanceKm), bearing + 90, offsetKm);
      // 16L の中心線からは offsetKm、16R の中心線からは（実分離 1.70km − offsetKm）の位置にいる
      expect(crossTrackKm(position, end, oppositeOf(end))).toBeCloseTo(offsetKm, 2);
      expect(crossTrackKm(position, neighbourEnd, oppositeOf(neighbourEnd))).toBeLessThan(offsetKm);

      const selection = arrivalSelection({ position, trackDeg: normalizeDeg(bearing) });
      expect(selection?.runway).toBe("16R");
      expect(selection?.decided).toBe(true);
      // 緩和は確度の上限だけ（AC-P3-07。適用は estimate.ts）
      expect(selection?.capConfidence).toBe(true);
    },
  );
});

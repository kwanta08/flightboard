import { describe, expect, it } from "vitest";
import { confidenceLabel } from "../../shared/estimate.ts";
import { type LatLon, bearingDeg, destinationPoint } from "../../shared/geo.ts";
import type { Airport, Flight } from "../../shared/types.ts";
import { TARGET_AIRPORTS, type TargetAirport, targetAirport } from "../data/airports.ts";
import type { RunwayEnd } from "../data/importRunways.ts";
import { RUNWAY_ENDS, runwayEndsFor } from "../data/runways.ts";
import { applyDisagreementPenalty, buildEstimate } from "./estimate.ts";

function airportOf(icao: string): TargetAirport {
  const airport = targetAirport(icao);
  if (!airport) {
    throw new Error(`${icao} が TARGET_AIRPORTS に無い`);
  }
  return airport;
}

function endOf(icao: string, ident: string): RunwayEnd {
  const end = RUNWAY_ENDS.find((other) => other.icao === icao && other.ident === ident);
  if (!end) {
    throw new Error(`${icao} ${ident} が RUNWAY_ENDS に無い`);
  }
  return end;
}

/**
 * 滑走路の真方位（自端 → 対向端）を**テスト側で**計算する。
 * 実装の `runwayBearingDeg` は使わない（AC-P2-25 のヘルパが使ってよいのは
 * bearingDeg / haversineKm / destinationPoint だけ。実装を呼ぶと、対向端の探索が退行しても
 * 機体を同じ誤った線上に置いてしまい、テストが緑のまま素通りする）。
 */
function trueBearingOf(end: RunwayEnd): number {
  return bearingDeg(end, endOf(end.icao, end.oppositeIdent));
}

const HANEDA = airportOf("RJTT");
const normalizeDeg = (deg: number): number => ((deg % 360) + 360) % 360;

/** adsbdb のルート（判定に使うのは icao だけ） */
const airport = (icao: string): Airport => ({ icao, name: icao });

type FlightOverrides = {
  position?: LatLon;
  altitudeBaroFt?: number | null;
  altitudeGeomFt?: number;
  trackDeg?: number;
  verticalRateFpm?: number;
  route?: { origin: string; destination: string };
};

function flight(overrides: FlightOverrides = {}): Flight {
  const position: Flight["position"] = {
    lat: overrides.position?.lat ?? 35.86,
    lon: overrides.position?.lon ?? 139.9,
    altitudeBaroFt: overrides.altitudeBaroFt === undefined ? 3000 : overrides.altitudeBaroFt,
    onGround: false,
  };
  if (overrides.altitudeGeomFt !== undefined) {
    position.altitudeGeomFt = overrides.altitudeGeomFt;
  }
  const built: Flight = {
    hex: "86e7a0",
    callsign: "ANA245",
    position,
    isMlat: false,
    seenPosSec: 0,
    kind: "passenger",
    source: "adsblol",
  };
  if (overrides.trackDeg !== undefined) {
    built.trackDeg = overrides.trackDeg;
  }
  if (overrides.verticalRateFpm !== undefined) {
    built.verticalRateFpm = overrides.verticalRateFpm;
  }
  if (overrides.route) {
    built.route = {
      origin: airport(overrides.route.origin),
      destination: airport(overrides.route.destination),
      source: "adsbdb",
    };
  }
  return built;
}

/**
 * 滑走路端の延長線上に進入機を**合成**する（AC-P2-25 / 27。runway.test.ts と同じ作り方）。
 * **入力は合成であり、実測の生値ではない**（spec §6.2-6 / §6.5 の表に緯度・経度・進行方向・昇降率は無い）。
 * 使うのは src/shared/geo.ts の destinationPoint / bearingDeg だけで、候補条件・許容ズレ・採点式は参照しない。
 * 機体は滑走路端の座標を基準に置くので、スナップショットの絶対精度には依存しない。
 */
function approaching(
  end: RunwayEnd,
  args: { distanceKm: number; headingOffDeg?: number },
): { position: LatLon; trackDeg: number } {
  const bearing = trueBearingOf(end);
  return {
    position: destinationPoint(end, bearing + 180, args.distanceKm),
    trackDeg: normalizeDeg(bearing + (args.headingOffDeg ?? 0)),
  };
}

/** 離陸方向の延長線上に出発機を合成する（headingOffDeg で離陸後の旋回を表す） */
function departing(
  end: RunwayEnd,
  args: { distanceKm: number; headingOffDeg?: number },
): { position: LatLon; trackDeg: number } {
  const bearing = trueBearingOf(end);
  return {
    position: destinationPoint(end, bearing, args.distanceKm),
    trackDeg: normalizeDeg(bearing + (args.headingOffDeg ?? 0)),
  };
}

/** 空港中心から方位 fromBearing・距離 distanceKm の位置に、空港へ真っ直ぐ向かう機体を置く */
function towardAirport(
  target: TargetAirport,
  args: { fromBearing: number; distanceKm: number },
): { position: LatLon; trackDeg: number } {
  const position = destinationPoint(target, args.fromBearing, args.distanceKm);
  return { position, trackDeg: bearingDeg(position, target) };
}

describe("生成規則: 滑走路が決まった進入", () => {
  const estimate = buildEstimate(
    flight({ ...approaching(endOf("RJTT", "22"), { distanceKm: 10.7, headingOffDeg: 0.1 }), altitudeBaroFt: 1825, verticalRateFpm: -704 }),
  );

  it("phase・空港・滑走路・confidence が入る", () => {
    expect(estimate?.phase).toBe("arrival");
    expect(estimate?.airport).toEqual({ icao: "RJTT", name: "羽田" });
    expect(estimate?.runway).toBe("22");
    expect(estimate?.confidence).toBe(0.9);
  });

  it("AC-P2-54: evidence の書式", () => {
    expect(estimate?.evidence).toEqual(["方位のズレ 0.1°", "滑走路まで 10.7km", "降下中 -704fpm"]);
  });

  it("AC-P2-24: 確度ラベルは confidence から決まる（0.9 → 高）", () => {
    expect(confidenceLabel(estimate?.confidence ?? 0, estimate?.runway !== undefined)).toBe("高");
  });
});

describe("生成規則: 滑走路が決まった出発", () => {
  const estimate = buildEstimate(
    flight({ ...departing(endOf("RJTT", "16L"), { distanceKm: 8 }), altitudeBaroFt: 2500, verticalRateFpm: 1500 }),
  );

  it("phase = departure・滑走路 16L・confidence 0.9", () => {
    expect(estimate?.phase).toBe("departure");
    expect(estimate?.airport).toEqual({ icao: "RJTT", name: "羽田" });
    expect(estimate?.runway).toBe("16L");
    expect(estimate?.confidence).toBe(0.9);
  });

  it("evidence は上昇中を示す", () => {
    expect(estimate?.evidence).toEqual(["方位のズレ 0.0°", "滑走路まで 8.0km", "上昇中 +1500fpm"]);
  });
});

describe("生成規則: 進入・出発だが滑走路が決まらない", () => {
  // 羽田の北東 40km を降下しながら空港へ向かう機体（どの滑走路端も 35km より遠いので候補にならない）
  const far = { ...towardAirport(HANEDA, { fromBearing: 45, distanceKm: 40 }), altitudeBaroFt: 8000, verticalRateFpm: -704 };

  it("幾何のみなら confidence 0.3・滑走路なし・確度ラベルなし", () => {
    const estimate = buildEstimate(flight(far));
    expect(estimate?.phase).toBe("arrival");
    expect(estimate?.airport).toEqual({ icao: "RJTT", name: "羽田" });
    expect(estimate?.runway).toBeUndefined();
    expect(estimate?.confidence).toBe(0.3);
    expect(estimate?.evidence).toEqual(["羽田まで 40.0km", "降下中 -704fpm"]);
    expect(confidenceLabel(estimate?.confidence ?? 0, estimate?.runway !== undefined)).toBeUndefined();
  });

  it("route の裏付けがあれば confidence 0.5", () => {
    const estimate = buildEstimate(flight({ ...far, route: { origin: "RJOO", destination: "RJTT" } }));
    expect(estimate?.confidence).toBe(0.5);
    expect(estimate?.evidence).toEqual(["羽田まで 40.0km", "降下中 -704fpm", "adsbdb: RJTT 着"]);
  });
});

describe("生成規則: 通過（enroute）", () => {
  const estimate = buildEstimate(flight({ altitudeBaroFt: 35000, trackDeg: 180, verticalRateFpm: 0 }));

  it("空港も滑走路も付かず confidence 0.5", () => {
    expect(estimate?.phase).toBe("enroute");
    expect(estimate?.airport).toBeUndefined();
    expect(estimate?.runway).toBeUndefined();
    expect(estimate?.confidence).toBe(0.5);
  });

  it("evidence は巡航高度と水平飛行", () => {
    expect(estimate?.evidence).toEqual(["巡航 35000ft", "水平飛行 0fpm"]);
  });
});

describe("生成規則: 不明（estimate を付けない）", () => {
  it("低高度の水平飛行では undefined", () => {
    expect(buildEstimate(flight({ ...towardAirport(HANEDA, { fromBearing: 45, distanceKm: 20 }), verticalRateFpm: 0 }))).toBeUndefined();
  });

  it("AC-P2-15: 高度・進行方向・昇降率が欠けていても例外を出さず undefined", () => {
    const base = { ...approaching(endOf("RJTT", "22"), { distanceKm: 10 }), altitudeBaroFt: 1825, verticalRateFpm: -704 };
    for (const missing of [
      { altitudeBaroFt: null },
      { trackDeg: undefined },
      { verticalRateFpm: undefined },
      { trackDeg: Number.NaN },
    ]) {
      const broken = flight({ ...base, ...missing });
      expect(() => buildEstimate(broken)).not.toThrow();
      expect(buildEstimate(broken)).toBeUndefined();
    }
  });
});

describe("AC-P2-19: 候補探索は進入・出発のときだけ", () => {
  it("通過では滑走路を決めない（滑走路端の延長線上にいても）", () => {
    // 22 の延長線上 10km だが高度 35,000ft の水平飛行 → enroute なので滑走路は付かない
    const estimate = buildEstimate(
      flight({ ...approaching(endOf("RJTT", "22"), { distanceKm: 10 }), altitudeBaroFt: 35000, verticalRateFpm: 0 }),
    );
    expect(estimate?.phase).toBe("enroute");
    expect(estimate?.runway).toBeUndefined();
  });

  it("不明では estimate 自体が付かない（不明かつ滑走路あり、という状態を作らない）", () => {
    const estimate = buildEstimate(
      flight({ ...approaching(endOf("RJTT", "22"), { distanceKm: 10 }), altitudeBaroFt: 15000, verticalRateFpm: 0 }),
    );
    expect(estimate).toBeUndefined();
  });
});

/**
 * AC-P2-16: 候補探索は「幾何判定の phase が最終的な phase と一致する」ときだけ行う
 * （spec §10.2「第一候補には adsbdb を使い、幾何判定で裏を取る」）。
 * adsbdb のルート取得率は旅客機でほぼ 100%（spec §6.5）なので、route があるだけで滑走路が付くと
 * 「高度が取れないのに RWY22 進入 確度:高」が実運用でほぼ全機に出てしまう。
 * どの機体も羽田 22 の延長線 10km を降下中（幾何が裏を取れれば RWY22 が決まる位置）に置いている。
 */
describe("AC-P2-16: 幾何が裏を取れなければ滑走路を付けない", () => {
  const onFinal = approaching(endOf("RJTT", "22"), { distanceKm: 10 });
  const arrivingAtHaneda = { origin: "RJOO", destination: "RJTT" } as const;

  it("対照: 幾何も進入と言うなら RWY22・確度「高」になる", () => {
    const estimate = buildEstimate(
      flight({ ...onFinal, altitudeBaroFt: 1825, verticalRateFpm: -704, route: arrivingAtHaneda }),
    );
    expect(estimate?.phase).toBe("arrival");
    expect(estimate?.runway).toBe("22");
    expect(estimate?.confidence).toBe(0.9);
    expect(confidenceLabel(estimate?.confidence ?? 0, estimate?.runway !== undefined)).toBe("高");
  });

  it.each([
    ["高度が取れない（気圧高度も GNSS 高度も無い）", { altitudeBaroFt: null }],
    ["昇降率が欠けている", { verticalRateFpm: undefined }],
    ["昇降率が NaN", { verticalRateFpm: Number.NaN }],
    ["進行方向が欠けている", { trackDeg: undefined }],
    ["高度 15,000ft（AC-P2-10 の 10,000ft 未満を満たさない）", { altitudeBaroFt: 15000 }],
  ] as const)("%s 機体では、route があっても滑走路を付けない", (_name, missing) => {
    // 幾何は unknown（AC-P2-15 / AC-P2-10）。route は「羽田着」なので phase は進入のまま
    const estimate = buildEstimate(
      flight({ ...onFinal, altitudeBaroFt: 1825, verticalRateFpm: -704, ...missing, route: arrivingAtHaneda }),
    );
    expect(estimate?.phase).toBe("arrival");
    expect(estimate?.airport).toEqual({ icao: "RJTT", name: "羽田" });
    expect(estimate?.runway).toBeUndefined();
    expect(estimate?.confidence).toBe(0.5);
    expect(confidenceLabel(estimate?.confidence ?? 0, estimate?.runway !== undefined)).toBeUndefined();
    // 滑走路由来の evidence（方位のズレ・滑走路まで）は出ない
    expect(estimate?.evidence.some((line) => line.startsWith("方位のズレ") || line.startsWith("滑走路まで"))).toBe(
      false,
    );
  });

  it("route と幾何が食い違うときも滑走路を付けず、減点する", () => {
    // 成田 16R の延長線 12km を降下中（幾何では成田への進入）だが、adsbdb は「成田発」と言っている
    const onFinal16R = approaching(endOf("RJAA", "16R"), { distanceKm: 12 });
    const base = { ...onFinal16R, altitudeBaroFt: 3000, verticalRateFpm: -704 };
    // 対照: route が幾何と同じ「成田着」なら RWY16R が決まる
    expect(buildEstimate(flight({ ...base, route: { origin: "RJOO", destination: "RJAA" } }))?.runway).toBe("16R");

    const estimate = buildEstimate(flight({ ...base, route: { origin: "RJAA", destination: "RJOO" } }));
    expect(estimate?.phase).toBe("departure");
    expect(estimate?.runway).toBeUndefined();
    expect(estimate?.confidence).toBe(0.3); // 0.5 − 0.2（AC-P2-14 の減点）
    expect(estimate?.evidence).toContain("adsbdb: RJAA 発");
    expect(estimate?.evidence).toContain("幾何判定は 進入");
  });
});

describe("confidence の素点（滑走路が決まったとき）", () => {
  it("ズレ < 2° かつ 距離 < 25km なら 0.9", () => {
    const estimate = buildEstimate(
      flight({ ...approaching(endOf("RJTT", "22"), { distanceKm: 21.5, headingOffDeg: 0.2 }), altitudeBaroFt: 3600, verticalRateFpm: -704 }),
    );
    expect(estimate?.confidence).toBe(0.9);
  });

  it("距離が 25km 以上なら 0.9 にはならない（ズレが許容の半分未満なら 0.6）", () => {
    // 30km・ズレ 1.5°（許容 8° の半分未満）
    const estimate = buildEstimate(
      flight({ ...approaching(endOf("RJTT", "22"), { distanceKm: 30, headingOffDeg: 1.5 }), altitudeBaroFt: 5000, verticalRateFpm: -704 }),
    );
    expect(estimate?.runway).toBe("22");
    expect(estimate?.confidence).toBe(0.6);
    expect(confidenceLabel(estimate?.confidence ?? 0, true)).toBe("中");
  });

  it("ズレが許容の半分以上なら 0.3", () => {
    // 10km・ズレ 10°（許容 16° の半分 8° 以上）
    const estimate = buildEstimate(
      flight({ ...approaching(endOf("RJTT", "22"), { distanceKm: 10, headingOffDeg: 10 }), altitudeBaroFt: 2000, verticalRateFpm: -704 }),
    );
    expect(estimate?.runway).toBe("22");
    expect(estimate?.confidence).toBe(0.3);
    expect(confidenceLabel(estimate?.confidence ?? 0, true)).toBe("低");
  });

  /**
   * 素点の境界（ズレ 2°・距離 25km・許容ズレ × 0.5）で 1 段下がること。
   * 境界ちょうどの値は測地線の往復（destinationPoint → haversineKm）で 1e-12 程度の誤差が乗るので、
   * 他の境界テスト（35.1km / 20.1°）と同じく内側・外側を 0.01° / 0.1km で挟んで示す。
   */
  describe("素点の境界", () => {
    const confidenceAt = (distanceKm: number, headingOffDeg: number): number | undefined =>
      buildEstimate(
        flight({
          ...approaching(endOf("RJTT", "22"), { distanceKm, headingOffDeg }),
          altitudeBaroFt: 3000,
          verticalRateFpm: -704,
        }),
      )?.confidence;

    it.each([
      // 距離 24km（許容 10.4°・その半分 5.2°）で、ズレ 2° を境に 0.9 → 0.6
      ["ズレ 2° の内側（1.99°・24km）", 24, 1.99, 0.9],
      ["ズレ 2° の外側（2.01°・24km）", 24, 2.01, 0.6],
      // ズレ 0.1°（どちらも許容の半分未満）で、距離 25km を境に 0.9 → 0.6
      ["距離 25km の内側（24.9km・0.1°）", 24.9, 0.1, 0.9],
      ["距離 25km の外側（25.1km・0.1°）", 25.1, 0.1, 0.6],
      // 距離 10km なら許容 16°・その半分は 8°。ここを境に 0.6 → 0.3
      ["許容 × 0.5 の内側（7.99°・10km）", 10, 7.99, 0.6],
      ["許容 × 0.5 の外側（8.01°・10km）", 10, 8.01, 0.3],
    ])("%s → %s", (_name, distanceKm, headingOffDeg, expected) => {
      expect(confidenceAt(distanceKm, headingOffDeg)).toBe(expected);
    });
  });
});

describe("AC-P2-14: route の裏付け", () => {
  it("route.origin が対象空港なら出発を第一候補にする（幾何が決めきれなくても）", () => {
    // 低高度の水平飛行（幾何では unknown）だが、adsbdb が羽田発と言っている
    const estimate = buildEstimate(
      flight({ ...towardAirport(HANEDA, { fromBearing: 45, distanceKm: 20 }), verticalRateFpm: 0, route: { origin: "RJTT", destination: "RJOO" } }),
    );
    expect(estimate?.phase).toBe("departure");
    expect(estimate?.airport).toEqual({ icao: "RJTT", name: "羽田" });
    expect(estimate?.confidence).toBe(0.5);
    expect(estimate?.evidence).toContain("adsbdb: RJTT 発");
  });

  it("route.destination が対象空港なら進入を第一候補にする", () => {
    const estimate = buildEstimate(
      flight({ ...towardAirport(HANEDA, { fromBearing: 45, distanceKm: 20 }), verticalRateFpm: 0, route: { origin: "RJOO", destination: "RJTT" } }),
    );
    expect(estimate?.phase).toBe("arrival");
    expect(estimate?.evidence).toContain("adsbdb: RJTT 着");
  });

  it("滑走路の候補探索も route 由来の phase の条件で行う", () => {
    // 羽田 22 の延長線上を降下中（幾何では進入）だが、adsbdb は羽田発と言っている。
    // phase は route 由来の「出発」になる。幾何（進入）と一致しないので候補探索自体が走らず（AC-P2-16）、
    // 仮に走ったとしても出発の条件（上昇中）を満たさないので、いずれにせよ滑走路は決まらない
    const estimate = buildEstimate(
      flight({ ...approaching(endOf("RJTT", "22"), { distanceKm: 12 }), altitudeBaroFt: 3000, verticalRateFpm: -704, route: { origin: "RJTT", destination: "RJOO" } }),
    );
    expect(estimate?.phase).toBe("departure");
    expect(estimate?.runway).toBeUndefined();
    expect(estimate?.confidence).toBe(0.3);
    expect(estimate?.evidence).toContain("adsbdb: RJTT 発");
    expect(estimate?.evidence).toContain("幾何判定は 進入");
  });

  it("対象空港が route に無ければ幾何の判定のまま", () => {
    const estimate = buildEstimate(
      flight({ ...towardAirport(HANEDA, { fromBearing: 45, distanceKm: 40 }), altitudeBaroFt: 8000, verticalRateFpm: -704, route: { origin: "RJOO", destination: "RJCC" } }),
    );
    expect(estimate?.phase).toBe("arrival");
    expect(estimate?.confidence).toBe(0.3);
    expect(estimate?.evidence).not.toContain("adsbdb: RJOO 発");
  });

  it("出発地も到着地も対象空港なら、幾何判定と一致する方を採る", () => {
    const estimate = buildEstimate(
      flight({ ...departing(endOf("RJTT", "16L"), { distanceKm: 8 }), altitudeBaroFt: 2500, verticalRateFpm: 1500, route: { origin: "RJTT", destination: "RJAA" } }),
    );
    expect(estimate?.phase).toBe("departure");
    expect(estimate?.evidence).toContain("adsbdb: RJTT 発");
    expect(estimate?.evidence).not.toContain("幾何判定は 出発");
  });
});

describe("AC-P2-14: 幾何判定との食い違い（confidence を 0.2 引く・下限 0.1）", () => {
  it("phase が食い違えば evidence に両方を残して減点する", () => {
    // 高度 35,000ft の水平飛行（幾何では通過）だが、adsbdb は羽田発と言っている
    const estimate = buildEstimate(
      flight({ altitudeBaroFt: 35000, trackDeg: 180, verticalRateFpm: 0, route: { origin: "RJTT", destination: "RJOO" } }),
    );
    expect(estimate?.phase).toBe("departure");
    expect(estimate?.confidence).toBe(0.3);
    expect(estimate?.evidence).toEqual(["羽田まで 35.9km", "水平飛行 0fpm", "adsbdb: RJTT 発", "幾何判定は 通過"]);
  });

  it("空港が食い違えば減点する（滑走路が決まっていれば 0.9 → 0.7 で確度は「中」）", () => {
    // 羽田 22 へ進入中だが、adsbdb は成田着と言っている
    const estimate = buildEstimate(
      flight({ ...approaching(endOf("RJTT", "22"), { distanceKm: 12, headingOffDeg: 0.4 }), altitudeBaroFt: 3000, verticalRateFpm: -704, route: { origin: "RJOO", destination: "RJAA" } }),
    );
    expect(estimate?.phase).toBe("arrival");
    // 空港は滑走路が決まった側（幾何）を採り、食い違いは evidence と confidence に残す
    expect(estimate?.airport).toEqual({ icao: "RJTT", name: "羽田" });
    expect(estimate?.runway).toBe("22");
    expect(estimate?.confidence).toBe(0.7);
    expect(confidenceLabel(estimate?.confidence ?? 0, true)).toBe("中");
    expect(estimate?.evidence).toContain("adsbdb: RJAA 着");
    expect(estimate?.evidence).toContain("幾何判定は RJTT");
  });

  it("幾何が決めきれない（unknown）ときは食い違いに数えない", () => {
    const estimate = buildEstimate(
      flight({ ...towardAirport(HANEDA, { fromBearing: 45, distanceKm: 20 }), verticalRateFpm: 0, route: { origin: "RJTT", destination: "RJOO" } }),
    );
    expect(estimate?.confidence).toBe(0.5);
    expect(estimate?.evidence.some((line) => line.startsWith("幾何判定は"))).toBe(false);
  });
});

describe("applyDisagreementPenalty: 減点後の値（plan の confidence 表）", () => {
  it.each([
    [0.9, 0.7],
    [0.6, 0.4],
    [0.5, 0.3],
    [0.3, 0.1],
  ])("素点 %s → %s", (raw, penalized) => {
    expect(applyDisagreementPenalty(raw)).toBe(penalized);
  });

  it("下限は 0.1", () => {
    expect(applyDisagreementPenalty(0.2)).toBe(0.1);
    expect(applyDisagreementPenalty(0.1)).toBe(0.1);
    expect(applyDisagreementPenalty(0)).toBe(0.1);
  });
});

/**
 * AC-P2-25: 公示された 4 ケース（合成入力）で、12 本の滑走路端の中から公示どおりの端が選ばれ、
 * 確度ラベルが表（実測の正解例はすべて「高」）と整合すること。
 * **入力は合成であり、実測の生値ではない。**（緯度・経度・進行方向・昇降率は spec に残っていない）
 */
describe("AC-P2-25: 公示された 4 ケースの推定（合成入力）", () => {
  it.each([
    ["ANA642", "22", 200, 1.0, 0.3],
    ["JAL38", "22", 1825, 10.7, 0.1],
    ["SKY706", "23", 3350, 19.9, 1.0],
    ["ANA862", "22", 3600, 21.5, 0.2],
  ] as const)("%s は RJTT RWY%s 進入・確度「高」", (_name, ident, altitudeBaroFt, distanceKm, headingOffDeg) => {
    const estimate = buildEstimate(
      flight({ ...approaching(endOf("RJTT", ident), { distanceKm, headingOffDeg }), altitudeBaroFt, verticalRateFpm: -704 }),
    );
    expect(estimate?.phase).toBe("arrival");
    expect(estimate?.airport).toEqual({ icao: "RJTT", name: "羽田" });
    expect(estimate?.runway).toBe(ident);
    expect(confidenceLabel(estimate?.confidence ?? 0, true)).toBe("高");
    expect(estimate?.evidence.slice(0, 2)).toEqual([
      `方位のズレ ${headingOffDeg.toFixed(1)}°`,
      `滑走路まで ${distanceKm.toFixed(1)}km`,
    ]);
  });

  it("SKY102（31.8km・ズレ +12.6°）では滑走路を決めない（誤判定を出さない）", () => {
    const estimate = buildEstimate(
      flight({ ...approaching(endOf("RJTT", "23"), { distanceKm: 31.8, headingOffDeg: 12.6 }), altitudeBaroFt: 4975, verticalRateFpm: -704 }),
    );
    expect(estimate?.runway).toBeUndefined();
    expect(confidenceLabel(estimate?.confidence ?? 0, estimate?.runway !== undefined)).toBeUndefined();
  });
});

/**
 * review-code-W2-2 の MINOR-2 の回帰。**修正前は離陸直後の機体が「成田 出発」になっていた。**
 *
 * 羽田 22 を離陸して 1km・高度 800ft・+1500fpm で上昇中の機体は、空港中心（ARP）から見ると
 * まだ前方（方位差約 79°）にあるため「羽田から離脱中」と読めず、60km 先の成田が採られていた。
 * phase.ts の基準点を滑走路端にしたので、旋回の向きによらず羽田になる（詳しくは phase.test.ts）。
 */
describe("離陸直後の推定（MINOR-2 の回帰）", () => {
  const justAirborne = (headingOffDeg: number, route?: { origin: string; destination: string }): Flight =>
    flight({
      ...departing(endOf("RJTT", "22"), { distanceKm: 1, headingOffDeg }),
      altitudeBaroFt: 800,
      verticalRateFpm: 1500,
      ...(route ? { route } : {}),
    });

  it.each([
    ["中心線上", 0],
    ["左 25° 旋回", -25],
    ["右 25° 旋回", 25],
  ] as const)("%s でも空港は羽田（成田にならない）", (_name, headingOffDeg) => {
    const estimate = buildEstimate(justAirborne(headingOffDeg));
    expect(estimate?.phase).toBe("departure");
    expect(estimate?.airport).toEqual({ icao: "RJTT", name: "羽田" });
    expect(estimate?.evidence.some((line) => line.includes("成田") || line.includes("RJAA"))).toBe(false);
  });

  it("中心線上なら RWY22 まで決まる（確度「高」）", () => {
    const estimate = buildEstimate(justAirborne(0));
    expect(estimate?.runway).toBe("22");
    expect(estimate?.confidence).toBe(0.9);
    expect(estimate?.evidence).toEqual(["方位のズレ 0.0°", "滑走路まで 1.0km", "上昇中 +1500fpm"]);
  });

  it.each([
    ["左 25° 旋回", -25],
    ["右 25° 旋回", 25],
  ] as const)("%s では滑走路までは決まらないが、羽田 出発として同じ内容になる", (_name, headingOffDeg) => {
    // 旋回で方位のズレ 25° が許容（1km なら 19.6°）を超えるので候補は無い。左右で結果が変わらないことを見る
    const estimate = buildEstimate(justAirborne(headingOffDeg));
    expect(estimate?.runway).toBeUndefined();
    expect(estimate?.confidence).toBe(0.3);
    expect(estimate?.evidence).toEqual(["羽田まで 1.2km", "上昇中 +1500fpm"]);
  });

  it("route が「羽田発」なら食い違いの減点は付かない（0.5 のまま）", () => {
    // 修正前は幾何が成田を指したため「幾何判定は RJAA」が付き 0.5 → 0.3 に減点されていた
    const estimate = buildEstimate(justAirborne(-25, { origin: "RJTT", destination: "RJOO" }));
    expect(estimate?.airport).toEqual({ icao: "RJTT", name: "羽田" });
    expect(estimate?.confidence).toBe(0.5);
    expect(estimate?.evidence).toEqual(["羽田まで 1.2km", "上昇中 +1500fpm", "adsbdb: RJTT 発"]);
  });
});

describe("buildEstimate の引数", () => {
  it("滑走路端を絞れば、その中からしか選ばれない", () => {
    const onFinal = flight({ ...approaching(endOf("RJTT", "22"), { distanceKm: 10 }), altitudeBaroFt: 1825, verticalRateFpm: -704 });
    expect(buildEstimate(onFinal, [])?.runway).toBeUndefined();
    expect(buildEstimate(onFinal)?.runway).toBe("22");
  });

  it("他空港の滑走路端しか渡さなければ、phase は進入のまま runway だけ決まらない", () => {
    const toNarita = flight({ ...approaching(endOf("RJAA", "16R"), { distanceKm: 12 }), altitudeBaroFt: 3000, verticalRateFpm: -704 });
    expect(buildEstimate(toNarita)?.runway).toBe("16R");

    // 空港は両方渡し、滑走路端だけ羽田に絞る。幾何は変わらないので進入・成田のまま滑走路が落ちる
    const narrowed = buildEstimate(toNarita, runwayEndsFor("RJTT"), TARGET_AIRPORTS);
    expect(narrowed?.phase).toBe("arrival");
    expect(narrowed?.airport).toEqual({ icao: "RJAA", name: "成田" });
    expect(narrowed?.runway).toBeUndefined();
    expect(narrowed?.confidence).toBe(0.3);
  });

  it("滑走路端を絞れば、フェーズの基準点もその端に従う", () => {
    // 羽田 22 を離陸して 1km・高度 800ft・+1500fpm で上昇中の機体。
    // 既定の 12 端なら、真後ろにある 22 の端を基準に「羽田から離脱中」＝出発になる。
    // 交差する 16R の端だけに絞ると、基準点は前方（方位差 90° 未満）に残る 16R だけになり、
    // 離脱中が成り立たなくなる（phase.test.ts の「向きの条件を満たす端が 1 つでもあれば」と同じ位置）。
    // ends をフェーズ判定に渡していないと、ここが既定の 12 端のまま「出発」で残る
    const justAirborne = flight({
      ...departing(endOf("RJTT", "22"), { distanceKm: 1 }),
      altitudeBaroFt: 800,
      verticalRateFpm: 1500,
    });
    expect(buildEstimate(justAirborne, RUNWAY_ENDS, [HANEDA])?.phase).toBe("departure");
    expect(buildEstimate(justAirborne, [endOf("RJTT", "16R")], [HANEDA])).toBeUndefined();
  });

  it("対象空港を絞れば、その空港の滑走路端しか見ない", () => {
    const toNarita = flight({ ...approaching(endOf("RJAA", "16R"), { distanceKm: 12 }), altitudeBaroFt: 3000, verticalRateFpm: -704 });
    // 羽田だけを対象にすると、幾何は「羽田へ接近中」（58.5km 先）と読み、成田の 16R は候補に入らない。
    // 絞り込みが効かなければ、羽田の推定に成田の RWY16R が付く（airport と runway が食い違う）
    const hanedaOnly = buildEstimate(toNarita, RUNWAY_ENDS, [HANEDA]);
    expect(hanedaOnly?.phase).toBe("arrival");
    expect(hanedaOnly?.airport).toEqual({ icao: "RJTT", name: "羽田" });
    expect(hanedaOnly?.runway).toBeUndefined();
  });
});

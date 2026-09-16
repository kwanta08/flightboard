import { describe, expect, it } from "vitest";
import { confidenceLabel } from "../../shared/estimate.ts";
import { type LatLon, bearingDeg, destinationPoint } from "../../shared/geo.ts";
import type { Airport, Flight } from "../../shared/types.ts";
import { type TargetAirport, targetAirport } from "../data/airports.ts";
import type { RunwayEnd } from "../data/importRunways.ts";
import { RUNWAY_ENDS } from "../data/runways.ts";
import { applyDisagreementPenalty, buildEstimate } from "./estimate.ts";
import { runwayBearingDeg } from "./runway.ts";

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

/** 滑走路の真方位（自端 → 対向端の座標から計算する） */
function trueBearingOf(end: RunwayEnd): number {
  const bearing = runwayBearingDeg(end, RUNWAY_ENDS);
  if (bearing === undefined) {
    throw new Error(`${end.icao} ${end.ident} の対向端が無い`);
  }
  return bearing;
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

/** 離陸方向の延長線上に出発機を合成する */
function departing(end: RunwayEnd, args: { distanceKm: number }): { position: LatLon; trackDeg: number } {
  const bearing = trueBearingOf(end);
  return { position: destinationPoint(end, bearing, args.distanceKm), trackDeg: normalizeDeg(bearing) };
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
    // phase は route 由来の「出発」になるので、候補探索は出発の条件（上昇中）で行われ、滑走路は決まらない
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

describe("buildEstimate の引数", () => {
  it("滑走路端を絞れば、その中からしか選ばれない", () => {
    const onFinal = flight({ ...approaching(endOf("RJTT", "22"), { distanceKm: 10 }), altitudeBaroFt: 1825, verticalRateFpm: -704 });
    expect(buildEstimate(onFinal, [])?.runway).toBeUndefined();
    expect(buildEstimate(onFinal)?.runway).toBe("22");
  });

  it("対象空港を絞れば、その空港の滑走路端しか見ない", () => {
    const toNarita = flight({ ...approaching(endOf("RJAA", "16R"), { distanceKm: 12 }), altitudeBaroFt: 3000, verticalRateFpm: -704 });
    expect(buildEstimate(toNarita)?.airport?.icao).toBe("RJAA");
    expect(buildEstimate(toNarita, RUNWAY_ENDS, [HANEDA])?.runway).toBeUndefined();
  });
});

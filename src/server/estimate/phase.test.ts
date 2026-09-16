import { describe, expect, it } from "vitest";
import { bearingDeg, destinationPoint } from "../../shared/geo.ts";
import type { Flight } from "../../shared/types.ts";
import { type TargetAirport, TARGET_AIRPORTS, targetAirport } from "../data/airports.ts";
import {
  APPROACH_ANGLE_DEG,
  ENROUTE_ALTITUDE_FT,
  LOW_ALTITUDE_FT,
  VERTICAL_RATE_THRESHOLD_FPM,
  angleDifferenceDeg,
  detectPhase,
  finiteOrUndefined,
} from "./phase.ts";

function airportOf(icao: string): TargetAirport {
  const airport = targetAirport(icao);
  if (!airport) {
    throw new Error(`${icao} が TARGET_AIRPORTS に無い`);
  }
  return airport;
}

const HANEDA = airportOf("RJTT");
const NARITA = airportOf("RJAA");

type FlightOverrides = {
  lat?: number;
  lon?: number;
  altitudeBaroFt?: number | null;
  altitudeGeomFt?: number;
  trackDeg?: number;
  verticalRateFpm?: number;
};

/** 判定に関係する項目だけを差し替えられる機体。省略した項目は「進入でも出発でもない」既定値にする */
function flight(overrides: FlightOverrides = {}): Flight {
  const position: Flight["position"] = {
    lat: overrides.lat ?? 35.86,
    lon: overrides.lon ?? 139.9,
    altitudeBaroFt: overrides.altitudeBaroFt === undefined ? 5000 : overrides.altitudeBaroFt,
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
  return built;
}

/**
 * 空港から方位 fromBearing・距離 distanceKm の位置に機体を置き、「機体 → 空港中心」の方位から
 * offsetDeg だけずらした進行方向を与える（0 = 空港へ真っ直ぐ、90 = 真横、180 = 空港から真っ直ぐ離れる）。
 * 位置と方位の計算には src/shared/geo.ts の関数だけを使い、判定の条件式は参照しない。
 */
function nearAirport(
  airport: TargetAirport,
  args: { fromBearing: number; distanceKm: number; offsetDeg: number },
): { lat: number; lon: number; trackDeg: number } {
  const position = destinationPoint(airport, args.fromBearing, args.distanceKm);
  const trackDeg = (bearingDeg(position, airport) + args.offsetDeg + 360) % 360;
  return { lat: position.lat, lon: position.lon, trackDeg };
}

/** 羽田の北東 20km を、空港へ真っ直ぐ向かって飛ぶ機体 */
const TOWARD_HANEDA = nearAirport(HANEDA, { fromBearing: 45, distanceKm: 20, offsetDeg: 0 });
/** 羽田の北東 20km を、空港から真っ直ぐ離れて飛ぶ機体 */
const AWAY_FROM_HANEDA = nearAirport(HANEDA, { fromBearing: 45, distanceKm: 20, offsetDeg: 180 });

describe("angleDifferenceDeg", () => {
  it("2 つの方位の差を 0〜180° で返す", () => {
    expect(angleDifferenceDeg(10, 10)).toBe(0);
    expect(angleDifferenceDeg(30, 10)).toBe(20);
    expect(angleDifferenceDeg(10, 30)).toBe(20);
    expect(angleDifferenceDeg(0, 180)).toBe(180);
  });

  it("0°/360° をまたいでも最短側で測る", () => {
    expect(angleDifferenceDeg(350, 10)).toBeCloseTo(20, 10);
    expect(angleDifferenceDeg(10, 350)).toBeCloseTo(20, 10);
    expect(angleDifferenceDeg(-10, 350)).toBeCloseTo(0, 10);
  });
});

describe("finiteOrUndefined", () => {
  it("有限の数値だけを通す", () => {
    expect(finiteOrUndefined(0)).toBe(0);
    expect(finiteOrUndefined(-200)).toBe(-200);
    expect(finiteOrUndefined(undefined)).toBeUndefined();
    expect(finiteOrUndefined(null)).toBeUndefined();
    expect(finiteOrUndefined(Number.NaN)).toBeUndefined();
    expect(finiteOrUndefined(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe("AC-P2-10: 進入（高度 < 10,000ft・降下中・対象空港へ接近中）", () => {
  it("接近中なら arrival になり、その空港が付く", () => {
    const result = detectPhase(flight({ ...TOWARD_HANEDA, altitudeBaroFt: 3000, verticalRateFpm: -704 }), [HANEDA]);
    expect(result).toEqual({ phase: "arrival", airport: HANEDA });
  });

  it("接近していても降下していなければ arrival にならない", () => {
    const result = detectPhase(flight({ ...TOWARD_HANEDA, altitudeBaroFt: 3000, verticalRateFpm: 0 }), [HANEDA]);
    expect(result.phase).toBe("unknown");
  });

  it("降下していても空港から離れていく向きなら arrival にならない", () => {
    const result = detectPhase(
      flight({ ...AWAY_FROM_HANEDA, altitudeBaroFt: 3000, verticalRateFpm: -704 }),
      [HANEDA],
    );
    expect(result.phase).toBe("unknown");
  });

  it("接近中の空港が 2 つあれば、機体に近い方を採る", () => {
    // 両空港の北（36.1 / 140.0）から南へ向かう機体。羽田も成田も進行方向の ±90° にあり、成田の方が近い
    const between = flight({ lat: 36.1, lon: 140.0, altitudeBaroFt: 6000, trackDeg: 180, verticalRateFpm: -704 });
    const result = detectPhase(between, TARGET_AIRPORTS);
    expect(result.airport?.icao).toBe("RJAA");
  });
});

describe("AC-P2-11: 出発（高度 < 10,000ft・上昇中・対象空港から離脱中）", () => {
  it("離脱中なら departure になり、その空港が付く", () => {
    const result = detectPhase(
      flight({ ...AWAY_FROM_HANEDA, altitudeBaroFt: 3000, verticalRateFpm: 1500 }),
      [HANEDA],
    );
    expect(result).toEqual({ phase: "departure", airport: HANEDA });
  });

  it("上昇していても空港へ向かっていれば departure にならない", () => {
    const result = detectPhase(flight({ ...TOWARD_HANEDA, altitudeBaroFt: 3000, verticalRateFpm: 1500 }), [HANEDA]);
    expect(result.phase).toBe("unknown");
  });
});

describe("AC-P2-12: 通過（高度 > 20,000ft・水平飛行）", () => {
  it("高度 30,000ft・昇降率 0 なら enroute（空港は付かない）", () => {
    const result = detectPhase(flight({ altitudeBaroFt: 30000, trackDeg: 180, verticalRateFpm: 0 }), TARGET_AIRPORTS);
    expect(result).toEqual({ phase: "enroute" });
  });

  it("高度が足りなければ enroute にならない（15,000ft の水平飛行は unknown）", () => {
    const result = detectPhase(flight({ altitudeBaroFt: 15000, trackDeg: 180, verticalRateFpm: 0 }), TARGET_AIRPORTS);
    expect(result.phase).toBe("unknown");
  });
});

describe("AC-P2-13: どれにも当てはまらなければ unknown", () => {
  it("低高度で水平飛行", () => {
    const result = detectPhase(flight({ ...TOWARD_HANEDA, altitudeBaroFt: 3000, verticalRateFpm: 0 }), [HANEDA]);
    expect(result).toEqual({ phase: "unknown" });
  });

  it("高高度で降下中", () => {
    const result = detectPhase(flight({ ...TOWARD_HANEDA, altitudeBaroFt: 30000, verticalRateFpm: -2000 }), [HANEDA]);
    expect(result).toEqual({ phase: "unknown" });
  });

  it("対象空港が 1 つも無ければ、低高度で降下中でも unknown", () => {
    const result = detectPhase(flight({ ...TOWARD_HANEDA, altitudeBaroFt: 3000, verticalRateFpm: -704 }), []);
    expect(result).toEqual({ phase: "unknown" });
  });
});

describe("AC-P2-15: 欠けている値（例外を出さず unknown）", () => {
  it.each([
    ["高度（気圧高度が null・GNSS 高度なし）", { altitudeBaroFt: null }],
    ["進行方向", { trackDeg: undefined }],
    ["昇降率", { verticalRateFpm: undefined }],
    ["高度が NaN", { altitudeBaroFt: Number.NaN }],
    ["進行方向が NaN", { trackDeg: Number.NaN }],
    ["昇降率が Infinity", { verticalRateFpm: Number.POSITIVE_INFINITY }],
  ] as const)("%s が欠けていても unknown", (_name, missing) => {
    const base = { ...TOWARD_HANEDA, altitudeBaroFt: 3000, verticalRateFpm: -704 };
    expect(() => detectPhase(flight({ ...base, ...missing }), [HANEDA])).not.toThrow();
    expect(detectPhase(flight({ ...base, ...missing }), [HANEDA])).toEqual({ phase: "unknown" });
  });
});

describe("高度は GNSS 優先（aircraftAltitudeFt。spec §11 と揃える）", () => {
  it("気圧高度が 25,000ft でも GNSS 高度が 3,000ft なら進入になる", () => {
    const result = detectPhase(
      flight({ ...TOWARD_HANEDA, altitudeBaroFt: 25000, altitudeGeomFt: 3000, verticalRateFpm: -704 }),
      [HANEDA],
    );
    expect(result.phase).toBe("arrival");
  });

  it("気圧高度が 3,000ft でも GNSS 高度が 25,000ft なら進入にならない", () => {
    const result = detectPhase(
      flight({ ...TOWARD_HANEDA, altitudeBaroFt: 3000, altitudeGeomFt: 25000, verticalRateFpm: -704 }),
      [HANEDA],
    );
    expect(result.phase).toBe("unknown");
  });
});

describe("境界値", () => {
  it(`高度 ${LOW_ALTITUDE_FT}ft ちょうどは進入にならない（未満が条件）`, () => {
    const base = { ...TOWARD_HANEDA, verticalRateFpm: -704 };
    expect(detectPhase(flight({ ...base, altitudeBaroFt: LOW_ALTITUDE_FT }), [HANEDA]).phase).toBe("unknown");
    expect(detectPhase(flight({ ...base, altitudeBaroFt: LOW_ALTITUDE_FT - 0.1 }), [HANEDA]).phase).toBe("arrival");
  });

  it(`高度 ${ENROUTE_ALTITUDE_FT}ft ちょうどは通過にならない（超過が条件）`, () => {
    const base = { trackDeg: 180, verticalRateFpm: 0 };
    expect(detectPhase(flight({ ...base, altitudeBaroFt: ENROUTE_ALTITUDE_FT }), TARGET_AIRPORTS).phase).toBe("unknown");
    expect(detectPhase(flight({ ...base, altitudeBaroFt: ENROUTE_ALTITUDE_FT + 0.1 }), TARGET_AIRPORTS).phase).toBe(
      "enroute",
    );
  });

  it(`昇降率 -${VERTICAL_RATE_THRESHOLD_FPM}fpm ちょうどは降下中でない`, () => {
    const base = { ...TOWARD_HANEDA, altitudeBaroFt: 3000 };
    expect(detectPhase(flight({ ...base, verticalRateFpm: -VERTICAL_RATE_THRESHOLD_FPM }), [HANEDA]).phase).toBe(
      "unknown",
    );
    expect(detectPhase(flight({ ...base, verticalRateFpm: -VERTICAL_RATE_THRESHOLD_FPM - 0.1 }), [HANEDA]).phase).toBe(
      "arrival",
    );
  });

  it(`昇降率 +${VERTICAL_RATE_THRESHOLD_FPM}fpm ちょうどは上昇中でない`, () => {
    const base = { ...AWAY_FROM_HANEDA, altitudeBaroFt: 3000 };
    expect(detectPhase(flight({ ...base, verticalRateFpm: VERTICAL_RATE_THRESHOLD_FPM }), [HANEDA]).phase).toBe(
      "unknown",
    );
    expect(detectPhase(flight({ ...base, verticalRateFpm: VERTICAL_RATE_THRESHOLD_FPM + 0.1 }), [HANEDA]).phase).toBe(
      "departure",
    );
  });

  it(`昇降率 ±${VERTICAL_RATE_THRESHOLD_FPM}fpm ちょうどは水平飛行（高高度なら通過）`, () => {
    const base = { altitudeBaroFt: 30000, trackDeg: 180 };
    expect(detectPhase(flight({ ...base, verticalRateFpm: VERTICAL_RATE_THRESHOLD_FPM }), TARGET_AIRPORTS).phase).toBe(
      "enroute",
    );
    expect(detectPhase(flight({ ...base, verticalRateFpm: -VERTICAL_RATE_THRESHOLD_FPM }), TARGET_AIRPORTS).phase).toBe(
      "enroute",
    );
    expect(
      detectPhase(flight({ ...base, verticalRateFpm: VERTICAL_RATE_THRESHOLD_FPM + 0.1 }), TARGET_AIRPORTS).phase,
    ).toBe("unknown");
  });

  it(`進行方向と空港の方位の差がちょうど ${APPROACH_ANGLE_DEG}° なら、接近中でも離脱中でもない`, () => {
    const across = nearAirport(HANEDA, { fromBearing: 45, distanceKm: 20, offsetDeg: APPROACH_ANGLE_DEG });
    expect(detectPhase(flight({ ...across, altitudeBaroFt: 3000, verticalRateFpm: -704 }), [HANEDA]).phase).toBe(
      "unknown",
    );
    expect(detectPhase(flight({ ...across, altitudeBaroFt: 3000, verticalRateFpm: 1500 }), [HANEDA]).phase).toBe(
      "unknown",
    );
  });

  it(`差が ${APPROACH_ANGLE_DEG}° 未満なら接近中、超えれば離脱中`, () => {
    const almostAcross = nearAirport(HANEDA, { fromBearing: 45, distanceKm: 20, offsetDeg: APPROACH_ANGLE_DEG - 0.1 });
    const justPast = nearAirport(HANEDA, { fromBearing: 45, distanceKm: 20, offsetDeg: APPROACH_ANGLE_DEG + 0.1 });
    expect(detectPhase(flight({ ...almostAcross, altitudeBaroFt: 3000, verticalRateFpm: -704 }), [HANEDA]).phase).toBe(
      "arrival",
    );
    expect(detectPhase(flight({ ...justPast, altitudeBaroFt: 3000, verticalRateFpm: 1500 }), [HANEDA]).phase).toBe(
      "departure",
    );
  });
});

describe("detectPhase の既定の空港", () => {
  it("空港を省略すると TARGET_AIRPORTS（羽田・成田）を見る", () => {
    const toward = nearAirport(NARITA, { fromBearing: 300, distanceKm: 15, offsetDeg: 0 });
    const result = detectPhase(flight({ ...toward, altitudeBaroFt: 3000, verticalRateFpm: -704 }));
    expect(result.airport?.icao).toBe("RJAA");
  });
});

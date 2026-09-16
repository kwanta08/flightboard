import { describe, expect, it } from "vitest";
import { type LatLon, bearingDeg, destinationPoint, haversineKm } from "../../shared/geo.ts";
import type { Flight } from "../../shared/types.ts";
import { type TargetAirport, TARGET_AIRPORTS, targetAirport } from "../data/airports.ts";
import type { RunwayEnd } from "../data/importRunways.ts";
import { RUNWAY_ENDS } from "../data/runways.ts";
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

function endOf(icao: string, ident: string): RunwayEnd {
  const end = RUNWAY_ENDS.find((other) => other.icao === icao && other.ident === ident);
  if (!end) {
    throw new Error(`${icao} ${ident} が RUNWAY_ENDS に無い`);
  }
  return end;
}

/**
 * 滑走路の真方位（自端 → 対向端）を**テスト側で**計算する。
 * 使うのは src/shared/geo.ts の bearingDeg だけで、
 * 実装（runway.ts の runwayBearingDeg）は呼ばない（呼ぶと退行しても同じ誤った線上に機体を置いてしまう）。
 */
function trueBearingOf(end: RunwayEnd): number {
  return bearingDeg(end, endOf(end.icao, end.oppositeIdent));
}

const HANEDA = airportOf("RJTT");
const NARITA = airportOf("RJAA");
const normalizeDeg = (deg: number): number => ((deg % 360) + 360) % 360;

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
 * 基準点（空港中心でも滑走路端でもよい）から方位 fromBearing・距離 distanceKm の位置に機体を置き、
 * 「機体 → 基準点」の方位から offsetDeg だけずらした進行方向を与える
 * （0 = 基準点へ真っ直ぐ、90 = 真横、180 = 基準点から真っ直ぐ離れる）。
 * 位置と方位の計算には src/shared/geo.ts の関数だけを使い、判定の条件式は参照しない。
 */
function nearPoint(
  reference: LatLon,
  args: { fromBearing: number; distanceKm: number; offsetDeg: number },
): { lat: number; lon: number; trackDeg: number } {
  const position = destinationPoint(reference, args.fromBearing, args.distanceKm);
  const trackDeg = (bearingDeg(position, reference) + args.offsetDeg + 360) % 360;
  return { lat: position.lat, lon: position.lon, trackDeg };
}

/** 羽田の北東 20km を、空港へ真っ直ぐ向かって飛ぶ機体 */
const TOWARD_HANEDA = nearPoint(HANEDA, { fromBearing: 45, distanceKm: 20, offsetDeg: 0 });
/** 羽田の北東 20km を、空港から真っ直ぐ離れて飛ぶ機体 */
const AWAY_FROM_HANEDA = nearPoint(HANEDA, { fromBearing: 45, distanceKm: 20, offsetDeg: 180 });

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

  // 基準点は「その空港の滑走路端」なので、境界は端ごとに決まる。羽田の 8 端は互いに最大 3.9km 離れており、
  // 20km 先から見ると端どうしで 10° 以上ずれるため、「すべての端に対してちょうど 90°」という位置は作れない。
  // そこで境界の試験では ends を 1 端（羽田 22）だけに絞り、その 1 点に対する境界を測る。
  describe(`基準点との方位の差の境界（${APPROACH_ANGLE_DEG}°）`, () => {
    const END_22 = endOf("RJTT", "22");

    it("ちょうど 90° なら、接近中でも離脱中でもない", () => {
      const across = nearPoint(END_22, { fromBearing: 45, distanceKm: 20, offsetDeg: APPROACH_ANGLE_DEG });
      expect(
        detectPhase(flight({ ...across, altitudeBaroFt: 3000, verticalRateFpm: -704 }), [HANEDA], [END_22]).phase,
      ).toBe("unknown");
      expect(
        detectPhase(flight({ ...across, altitudeBaroFt: 3000, verticalRateFpm: 1500 }), [HANEDA], [END_22]).phase,
      ).toBe("unknown");
    });

    it("90° 未満なら接近中、超えれば離脱中", () => {
      const almostAcross = nearPoint(END_22, { fromBearing: 45, distanceKm: 20, offsetDeg: APPROACH_ANGLE_DEG - 0.1 });
      const justPast = nearPoint(END_22, { fromBearing: 45, distanceKm: 20, offsetDeg: APPROACH_ANGLE_DEG + 0.1 });
      expect(
        detectPhase(flight({ ...almostAcross, altitudeBaroFt: 3000, verticalRateFpm: -704 }), [HANEDA], [END_22]).phase,
      ).toBe("arrival");
      expect(
        detectPhase(flight({ ...justPast, altitudeBaroFt: 3000, verticalRateFpm: 1500 }), [HANEDA], [END_22]).phase,
      ).toBe("departure");
    });
  });
});

/**
 * 接近中／離脱中は**空港中心（ARP）ではなく、その空港の滑走路端**を基準に測る
 * （review-code-W2-2 の MINOR-2）。
 *
 * ARP を基準にすると、離陸直後の機体は「離脱中」にならない。ARP は滑走路群の中ほどにあり滑走路は 2.5〜4km あるので、
 * 離陸した機体から見て ARP はしばらく真横〜前方に残るためである（下の 1 件目が実際にその位置）。
 * その結果、羽田を出発した機体が「羽田から離脱中ではない」と読まれ、
 * 代わりに 60km 先の成田が「離脱中の空港」として採られていた（＝「成田 出発」と表示されていた）。
 *
 * 機体の合成に使うのは src/shared/geo.ts の bearingDeg / destinationPoint だけで、判定の条件式は参照しない。
 */
describe("接近中／離脱中の基準点は滑走路端（MINOR-2 の回帰）", () => {
  const END_22 = endOf("RJTT", "22");
  const RUNWAY_22_BEARING = trueBearingOf(END_22);
  /** 羽田 22 を離陸し、端から 1km・高度 800ft・+1500fpm で上昇中の機体（旋回角だけを変える） */
  const justAirborne = (turnDeg: number): Flight =>
    flight({
      ...destinationPoint(END_22, RUNWAY_22_BEARING, 1),
      trackDeg: normalizeDeg(RUNWAY_22_BEARING + turnDeg),
      altitudeBaroFt: 800,
      verticalRateFpm: 1500,
    });

  it("この位置では ARP が前方（方位差 90° 未満）にある＝ ARP 基準では離脱中にならない", () => {
    // 基準点を変えた理由そのものを固定する。ARP との方位差は中心線上で約 79°
    const centerline = justAirborne(0);
    const offFromArp = angleDifferenceDeg(
      bearingDeg(centerline.position, HANEDA),
      centerline.trackDeg ?? Number.NaN,
    );
    expect(offFromArp).toBeLessThan(APPROACH_ANGLE_DEG);
    expect(offFromArp).toBeCloseTo(78.9, 0);
  });

  it.each([
    ["中心線上", 0],
    ["左 25° 旋回", -25],
    ["右 25° 旋回", 25],
  ] as const)("%s でも「羽田から離脱中」になる（旋回の向きで変わらない）", (_name, turnDeg) => {
    // 空港も滑走路端も既定（羽田・成田の 12 端）で、成田が採られないことまで見る
    expect(detectPhase(justAirborne(turnDeg))).toEqual({ phase: "departure", airport: HANEDA });
  });

  it("3 つの旋回角で結果が同じ（1 つでもずれたらこの配列が割れる）", () => {
    const results = [0, -25, 25].map((turnDeg) => JSON.stringify(detectPhase(justAirborne(turnDeg))));
    expect(new Set(results).size).toBe(1);
  });

  it("その空港の滑走路端が無ければ空港中心に戻る（端を持たない空港でも動く）", () => {
    // 端を渡さなければ従来どおり ARP 基準。上の機体は ARP が前方なので離脱中にならない
    expect(detectPhase(justAirborne(0), [HANEDA], []).phase).toBe("unknown");
    // ARP 基準そのものは働く（20km 先から空港へ真っ直ぐ降りてくる機体は進入）
    expect(
      detectPhase(flight({ ...TOWARD_HANEDA, altitudeBaroFt: 3000, verticalRateFpm: -704 }), [HANEDA], []),
    ).toEqual({ phase: "arrival", airport: HANEDA });
  });

  it("接近中も同じ基準に揃えた（裏返しの誤りが消える）", () => {
    // 22 に着陸しようとして端を 1.5km 通り過ぎた（まだ接地していない）機体。
    // ARP はもう後方（方位差 約 103°）にあるので ARP 基準では進入でなくなるが、
    // 進行方向には対向端（04）が残っているので、端基準なら進入のままになる
    const overRunway = flight({
      ...destinationPoint(END_22, RUNWAY_22_BEARING, 1.5),
      trackDeg: RUNWAY_22_BEARING,
      altitudeBaroFt: 200,
      verticalRateFpm: -300,
    });
    expect(angleDifferenceDeg(bearingDeg(overRunway.position, HANEDA), RUNWAY_22_BEARING)).toBeGreaterThan(
      APPROACH_ANGLE_DEG,
    );
    expect(detectPhase(overRunway, [HANEDA], []).phase).toBe("unknown");
    expect(detectPhase(overRunway, [HANEDA])).toEqual({ phase: "arrival", airport: HANEDA });
  });

  it("向きの条件を満たす端が 1 つでもあれば、その空港は離脱中（前方に残る端があってもよい）", () => {
    // 羽田は滑走路が交差しているので、22 を離陸した直後の機体のすぐ脇に 16R の端がある。
    // 16R の端は前方（方位差 90° 未満）に残るが、離陸した 22 の端は真後ろにある。
    const centerline = justAirborne(0);
    expect(detectPhase(centerline, [HANEDA], [endOf("RJTT", "16R")]).phase).toBe("unknown");
    expect(detectPhase(centerline, [HANEDA], [END_22]).phase).toBe("departure");
    expect(detectPhase(centerline, [HANEDA], [endOf("RJTT", "16R"), END_22])).toEqual({
      phase: "departure",
      airport: HANEDA,
    });
  });
});

/**
 * 空港どうしを比べる距離は「**向きの条件を満たした基準点（滑走路端）**までの距離」であり、
 * 空港中心（ARP）までの距離ではない（review-code-W2-3 の MINOR-1）。
 *
 * 実在の 2 空港は約 60km 離れていて端の広がりは最大 4km なので、2 つの規則で順位が入れ替わる位置は作れない。
 * そこで**テスト専用の空港と滑走路端**を合成して、規則そのものを固定する
 * （合成に使うのは src/shared/geo.ts の destinationPoint / haversineKm だけ）。
 */
describe("空港どうしの比較は基準点（滑走路端）までの距離で行う", () => {
  const ORIGIN: LatLon = { lat: 35.0, lon: 139.0 };
  /** 機体の真北 km の地点（機体は真北へ飛ぶので、どれも「接近中」側に入る） */
  const north = (km: number): LatLon => destinationPoint(ORIGIN, 0, km);
  /** 端は近い（10km）が ARP は遠い（100km）空港 */
  const NEAR_END: TargetAirport = { icao: "ZZAA", ...north(100) };
  /** ARP は近い（20km）が端は遠い（21km）空港 */
  const NEAR_ARP: TargetAirport = { icao: "ZZBB", ...north(20) };
  const ENDS: readonly RunwayEnd[] = [
    { icao: "ZZAA", ident: "36", ...north(10), oppositeIdent: "18" },
    { icao: "ZZBB", ident: "36", ...north(21), oppositeIdent: "18" },
  ];
  const northbound = flight({ ...ORIGIN, trackDeg: 0, altitudeBaroFt: 3000, verticalRateFpm: -704 });

  it("合成した 2 空港は、端で比べる場合と ARP で比べる場合で近い方が入れ替わる", () => {
    expect(haversineKm(northbound.position, NEAR_END)).toBeCloseTo(100, 3);
    expect(haversineKm(northbound.position, NEAR_ARP)).toBeCloseTo(20, 3);
    expect(haversineKm(northbound.position, ENDS[0])).toBeCloseTo(10, 3);
    expect(haversineKm(northbound.position, ENDS[1])).toBeCloseTo(21, 3);
  });

  it("端が近い方の空港を採る（ARP の遠近では決めない）", () => {
    // ARP で比べれば ZZBB（20km < 100km）だが、基準点＝端で比べるので ZZAA（10km < 21km）になる
    expect(detectPhase(northbound, [NEAR_END, NEAR_ARP], ENDS)).toEqual({ phase: "arrival", airport: NEAR_END });
    // 配列の並び順で決まっていないことも見る
    expect(detectPhase(northbound, [NEAR_ARP, NEAR_END], ENDS)).toEqual({ phase: "arrival", airport: NEAR_END });
  });
});

describe("detectPhase の既定の空港", () => {
  it("空港を省略すると TARGET_AIRPORTS（羽田・成田）を見る", () => {
    const toward = nearPoint(NARITA, { fromBearing: 300, distanceKm: 15, offsetDeg: 0 });
    const result = detectPhase(flight({ ...toward, altitudeBaroFt: 3000, verticalRateFpm: -704 }));
    expect(result.airport?.icao).toBe("RJAA");
  });
});

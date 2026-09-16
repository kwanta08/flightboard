import { describe, expect, it } from "vitest";
import type { Flight } from "../../shared/types.ts";
import { DEFAULT_MAX_EXTRAPOLATION_SEC, extrapolatedPosition, projectPosition } from "./deadReckoning.ts";

// 期待値は手計算: 100kt = 185.2km/h = 0.051444km/s → 20 秒 1.029km、30 秒 1.543km、15 秒 0.7717km
// 緯度 1° = 111.195km（R = 6371km の子午線上）。経度 1° = 111.195 × cos(緯度) km
const KM_PER_DEG_LAT = 111.195;

/** actual が expected の ±percent% に収まる */
function expectWithinPercent(actual: number, expected: number, percent = 1): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual((Math.abs(expected) * percent) / 100);
}

const ORIGIN = { lat: 35.87, lon: 139.93 };
const RECEIVED_AT = 1_700_000_000_000;

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    hex: "86e7a0",
    position: { lat: ORIGIN.lat, lon: ORIGIN.lon, altitudeBaroFt: 10000, onGround: false },
    groundSpeedKt: 100,
    trackDeg: 0,
    isMlat: false,
    seenPosSec: 0,
    kind: "passenger",
    source: "adsblol",
    ...overrides,
  };
}

/** 真北へ進んだ距離（km）を緯度差から換算する */
function northKm(to: { lat: number }, from = ORIGIN): number {
  return (to.lat - from.lat) * KM_PER_DEG_LAT;
}

describe("projectPosition", () => {
  it("真北へ 100kt・20 秒 → 1.029km 北（経度は変わらない）", () => {
    const p = projectPosition(ORIGIN, 100, 0, 20);
    expectWithinPercent(northKm(p), 1.029);
    expect(p.lon).toBeCloseTo(ORIGIN.lon, 9);
  });

  it("真北へ 100kt・30 秒 → 1.543km 北", () => {
    expectWithinPercent(northKm(projectPosition(ORIGIN, 100, 0, 30)), 1.543);
  });

  it("真南（180°）へ 100kt・30 秒 → 1.543km 南", () => {
    expectWithinPercent(-northKm(projectPosition(ORIGIN, 100, 180, 30)), 1.543);
  });

  it("真東へ 100kt・30 秒（緯度 35.87°）→ 経度方向に 1.543km", () => {
    const p = projectPosition(ORIGIN, 100, 90, 30);
    const expectedDeg = 1.543 / (KM_PER_DEG_LAT * Math.cos((35.87 * Math.PI) / 180));
    expectWithinPercent(p.lon - ORIGIN.lon, expectedDeg);
    expect(p.lat).toBeCloseTo(ORIGIN.lat, 5);
  });

  it("0 秒・速度 0 では同じ座標", () => {
    expect(projectPosition(ORIGIN, 100, 45, 0)).toEqual(ORIGIN);
    expect(projectPosition(ORIGIN, 0, 45, 30)).toEqual(ORIGIN);
  });

  it("日付変更線を東へまたいでも折り返さず、経度は 180 を超える（出発点から連続）", () => {
    const from = { lat: 0, lon: 179.99 };
    const p = projectPosition(from, 100, 90, 30);
    expect(p.lon).toBeGreaterThan(180);
    // 赤道上の経度 1° = 111.195km。出発点からの経度差がそのまま 1.543km 分
    expectWithinPercent((p.lon - from.lon) * KM_PER_DEG_LAT, 1.543);
  });

  it("日付変更線を西へまたいでも折り返さず、経度は -180 を下回る（出発点から連続）", () => {
    const from = { lat: 0, lon: -179.99 };
    const p = projectPosition(from, 100, 270, 30);
    expect(p.lon).toBeLessThan(-180);
    expectWithinPercent((from.lon - p.lon) * KM_PER_DEG_LAT, 1.543);
  });
});

describe("extrapolatedPosition（AC-B11）", () => {
  it("上限の既定は 30 秒", () => {
    expect(DEFAULT_MAX_EXTRAPOLATION_SEC).toBe(30);
  });

  it("真北へ 100kt・受信から 20 秒 → 1.029km 北", () => {
    expectWithinPercent(northKm(extrapolatedPosition(makeFlight(), RECEIVED_AT, RECEIVED_AT + 20_000)), 1.029);
  });

  it("真北へ 100kt・受信から 30 秒 → 1.543km 北", () => {
    expectWithinPercent(northKm(extrapolatedPosition(makeFlight(), RECEIVED_AT, RECEIVED_AT + 30_000)), 1.543);
  });

  it("36 秒経っても 30 秒分（1.543km）で止まる", () => {
    expectWithinPercent(northKm(extrapolatedPosition(makeFlight(), RECEIVED_AT, RECEIVED_AT + 36_000)), 1.543);
  });

  it("上限を指定できる（maxSec = 10 で 20 秒経っても 10 秒分 0.5144km）", () => {
    expectWithinPercent(northKm(extrapolatedPosition(makeFlight(), RECEIVED_AT, RECEIVED_AT + 20_000, 10)), 0.5144);
  });

  it("起点は receivedAt − seenPosSec（seenPosSec = 10・受信から 5 秒後 → 15 秒分 0.7717km）", () => {
    const p = extrapolatedPosition(makeFlight({ seenPosSec: 10 }), RECEIVED_AT, RECEIVED_AT + 5_000);
    expectWithinPercent(northKm(p), 0.7717);
  });

  it("seenPosSec が 30 秒を超えていれば受信直後でも上限の 30 秒分", () => {
    const p = extrapolatedPosition(makeFlight({ seenPosSec: 40 }), RECEIVED_AT, RECEIVED_AT);
    expectWithinPercent(northKm(p), 1.543);
  });

  it("groundSpeedKt が無ければ動かない", () => {
    expect(extrapolatedPosition(makeFlight({ groundSpeedKt: undefined }), RECEIVED_AT, RECEIVED_AT + 20_000)).toEqual(ORIGIN);
  });

  it("trackDeg が無ければ動かない", () => {
    expect(extrapolatedPosition(makeFlight({ trackDeg: undefined }), RECEIVED_AT, RECEIVED_AT + 20_000)).toEqual(ORIGIN);
  });

  it("groundSpeedKt・trackDeg が非有限（NaN）なら動かない", () => {
    expect(extrapolatedPosition(makeFlight({ groundSpeedKt: Number.NaN }), RECEIVED_AT, RECEIVED_AT + 20_000)).toEqual(ORIGIN);
    expect(extrapolatedPosition(makeFlight({ trackDeg: Number.NaN }), RECEIVED_AT, RECEIVED_AT + 20_000)).toEqual(ORIGIN);
  });

  it("trackDeg = 0（真北）は「無い」と扱わない", () => {
    expect(extrapolatedPosition(makeFlight({ trackDeg: 0 }), RECEIVED_AT, RECEIVED_AT + 20_000)).not.toEqual(ORIGIN);
  });

  it("経過 0 秒なら動かない", () => {
    expect(extrapolatedPosition(makeFlight(), RECEIVED_AT, RECEIVED_AT)).toEqual(ORIGIN);
  });

  it("負の経過（時計が受信時刻より前）なら動かない", () => {
    expect(extrapolatedPosition(makeFlight(), RECEIVED_AT, RECEIVED_AT - 5_000)).toEqual(ORIGIN);
  });

  it("receivedAt が無ければ動かない", () => {
    expect(extrapolatedPosition(makeFlight(), undefined, RECEIVED_AT + 20_000)).toEqual(ORIGIN);
  });

  it("1 秒ごとの補間で日付変更線を東へまたいでも経度が飛ばない（180 を超えて単調に増え、1 秒の差は 0.001° 未満）", () => {
    const flight = makeFlight({ position: { lat: 0, lon: 179.995, altitudeBaroFt: 10000, onGround: false }, trackDeg: 90 });
    const lons = Array.from({ length: 31 }, (_, sec) => extrapolatedPosition(flight, RECEIVED_AT, RECEIVED_AT + sec * 1000).lon);
    expect(lons[30]).toBeGreaterThan(180);
    for (let sec = 1; sec < lons.length; sec += 1) {
      const step = lons[sec]! - lons[sec - 1]!;
      expect(step).toBeGreaterThan(0);
      expect(step).toBeLessThan(0.001);
    }
  });
});

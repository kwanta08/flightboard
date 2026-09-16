import { describe, expect, it } from "vitest";
import {
  EARTH_RADIUS_KM,
  FT_TO_M,
  JA_16_DIRECTIONS,
  aircraftAltitudeFt,
  aircraftAltitudeM,
  bearingDeg,
  bearingToJa16,
  destinationPoint,
  elevationAngleDeg,
  haversineKm,
  slantDistanceKm,
} from "./geo.ts";

describe("定数", () => {
  it("R = 6371km、ft→m = 0.3048", () => {
    expect(EARTH_RADIUS_KM).toBe(6371);
    expect(FT_TO_M).toBe(0.3048);
  });
});

describe("haversineKm", () => {
  it("赤道上の経度 1° は 111.195km", () => {
    expect(haversineKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(111.195, 3);
  });

  it("子午線上の緯度 1° も 111.195km", () => {
    expect(haversineKm({ lat: 35, lon: 139 }, { lat: 36, lon: 139 })).toBeCloseTo(111.195, 3);
  });

  it("同じ地点は 0km", () => {
    expect(haversineKm({ lat: 35.87, lon: 139.93 }, { lat: 35.87, lon: 139.93 })).toBe(0);
  });

  it("向きを入れ替えても同じ距離", () => {
    const a = { lat: 35.8709, lon: 139.9256 };
    const b = { lat: 35.552299, lon: 139.779999 };
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 9);
  });
});

describe("bearingDeg", () => {
  it("真東は 90°", () => {
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(90, 9);
  });

  it("真北は 0°", () => {
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(0, 9);
  });

  it("真南は 180°", () => {
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: -1, lon: 0 })).toBeCloseTo(180, 9);
  });

  it("真西は 270°（負にならず 0〜360 に正規化）", () => {
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: -1 })).toBeCloseTo(270, 9);
  });

  it("北北西寄りでも [0, 360) に収まる", () => {
    const b = bearingDeg({ lat: 35, lon: 139 }, { lat: 36, lon: 138.9 });
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(360);
    expect(b).toBeGreaterThan(270);
  });
});

describe("destinationPoint", () => {
  it("赤道上を真東へ 111.195km 進むと経度 +1°", () => {
    const to = destinationPoint({ lat: 0, lon: 0 }, 90, 111.195);
    expect(to.lat).toBeCloseTo(0, 9);
    expect(to.lon).toBeCloseTo(1, 4);
  });

  it("真北へ 111.195km 進むと緯度 +1°", () => {
    const to = destinationPoint({ lat: 35, lon: 139 }, 0, 111.195);
    expect(to.lat).toBeCloseTo(36, 4);
    expect(to.lon).toBeCloseTo(139, 9);
  });

  it("距離 0 なら同じ点", () => {
    const from = { lat: 35.5525, lon: 139.78 };
    const to = destinationPoint(from, 217, 0);
    expect(to.lat).toBeCloseTo(from.lat, 12);
    expect(to.lon).toBeCloseTo(from.lon, 12);
  });

  it("進めた先までの距離と方位が、指定した距離・方位に戻る", () => {
    const from = { lat: 35.8709, lon: 139.9256 };
    for (const bearing of [0, 37, 90, 152.8, 217.3, 330, 359]) {
      const to = destinationPoint(from, bearing, 42);
      expect(haversineKm(from, to)).toBeCloseTo(42, 6);
      expect(bearingDeg(from, to)).toBeCloseTo(bearing, 6);
    }
  });

  it("方位は [0, 360) の外でも同じ点（-90° と 270°、360° と 0°）", () => {
    const from = { lat: 35.5525, lon: 139.78 };
    for (const [outside, inside] of [[-90, 270], [360, 0], [720 + 45, 45]] as const) {
      const a = destinationPoint(from, outside, 25);
      const b = destinationPoint(from, inside, 25);
      expect(a.lat).toBeCloseTo(b.lat, 12);
      expect(a.lon).toBeCloseTo(b.lon, 12);
    }
  });

  it("日付変更線をまたいでも経度は [-180, 180)", () => {
    const to = destinationPoint({ lat: 0, lon: 179.5 }, 90, 111.195);
    expect(to.lon).toBeCloseTo(-179.5, 4);
    expect(to.lon).toBeGreaterThanOrEqual(-180);
    expect(to.lon).toBeLessThan(180);
  });

  it("逆向きに同じ距離を進むと元の点に戻る", () => {
    const from = { lat: 35.552299, lon: 139.779999 };
    const to = destinationPoint(from, 152.8, 10);
    const back = destinationPoint(to, bearingDeg(to, from), 10);
    expect(back.lat).toBeCloseTo(from.lat, 9);
    expect(back.lon).toBeCloseTo(from.lon, 9);
  });
});

describe("bearingToJa16", () => {
  it("16 方位の並び", () => {
    expect(JA_16_DIRECTIONS).toEqual([
      "北", "北北東", "北東", "東北東", "東", "東南東", "南東", "南南東",
      "南", "南南西", "南西", "西南西", "西", "西北西", "北西", "北北西",
    ]);
  });

  it("各区間の中心（22.5° 刻み）が対応する方位名になる", () => {
    JA_16_DIRECTIONS.forEach((name, i) => {
      expect(bearingToJa16(i * 22.5)).toBe(name);
    });
  });

  it.each([
    [0, "北"],
    [11.24, "北"],
    [11.25, "北北東"],
    [348.74, "北北西"],
    [348.75, "北"],
    [359.99, "北"],
    [360, "北"],
    [-10, "北"],
    [-22.5, "北北西"],
    [720 + 90, "東"],
    [191.25, "南南西"],
    [101.25, "東南東"],
  ] as const)("%s° → %s", (deg, name) => {
    expect(bearingToJa16(deg)).toBe(name);
  });

  it.each([NaN, Infinity, -Infinity])("非有限の入力 %s → undefined", (deg) => {
    expect(bearingToJa16(deg)).toBeUndefined();
  });
});

describe("elevationAngleDeg", () => {
  it("dh=1km, d=10km → 5.666°", () => {
    expect(elevationAngleDeg({ horizontalKm: 10, observerAltitudeM: 0, targetAltitudeM: 1000 })).toBeCloseTo(5.666, 3);
  });

  it("dh=3km, d=5km → 30.947°", () => {
    expect(elevationAngleDeg({ horizontalKm: 5, observerAltitudeM: 0, targetAltitudeM: 3000 })).toBeCloseTo(30.947, 3);
  });

  it("h と h₀ の差で決まる（観測者の標高を引く）", () => {
    expect(elevationAngleDeg({ horizontalKm: 10, observerAltitudeM: 15, targetAltitudeM: 1015 })).toBeCloseTo(5.666, 3);
  });

  it("地球の丸みで、同じ高さの遠方は負の仰角になる", () => {
    const eps = elevationAngleDeg({ horizontalKm: 50, observerAltitudeM: 0, targetAltitudeM: 0 });
    expect(eps).toBeLessThan(0);
    expect(eps).toBeCloseTo(Math.atan(-50 / (2 * 6371)) * (180 / Math.PI), 9);
  });

  it("d=0 で機体が上 → 90°", () => {
    expect(elevationAngleDeg({ horizontalKm: 0, observerAltitudeM: 15, targetAltitudeM: 1000 })).toBe(90);
  });

  it("d=0 で機体が下 → -90°", () => {
    expect(elevationAngleDeg({ horizontalKm: 0, observerAltitudeM: 1000, targetAltitudeM: 15 })).toBe(-90);
  });

  it("d=0 で同じ高さ → 0°", () => {
    expect(elevationAngleDeg({ horizontalKm: 0, observerAltitudeM: 15, targetAltitudeM: 15 })).toBe(0);
  });
});

describe("slantDistanceKm", () => {
  it("√(d² + (h − h₀)²)：d=3km, dh=4km → 5km", () => {
    expect(slantDistanceKm({ horizontalKm: 3, observerAltitudeM: 0, targetAltitudeM: 4000 })).toBeCloseTo(5, 9);
  });

  it("観測者の標高を引き、機体が下でも正の距離", () => {
    expect(slantDistanceKm({ horizontalKm: 3, observerAltitudeM: 4015, targetAltitudeM: 15 })).toBeCloseTo(5, 9);
  });

  it("高さが同じなら水平距離に等しい", () => {
    expect(slantDistanceKm({ horizontalKm: 12.5, observerAltitudeM: 15, targetAltitudeM: 15 })).toBeCloseTo(12.5, 9);
  });

  it("真上なら高さの差", () => {
    expect(slantDistanceKm({ horizontalKm: 0, observerAltitudeM: 0, targetAltitudeM: 2500 })).toBeCloseTo(2.5, 9);
  });
});

describe("aircraftAltitudeFt / aircraftAltitudeM", () => {
  it("altitudeGeomFt を優先する", () => {
    expect(aircraftAltitudeFt({ altitudeBaroFt: 2500, altitudeGeomFt: 2700 })).toBe(2700);
  });

  it("altitudeGeomFt が 0 でも優先する（falsy で落とさない）", () => {
    expect(aircraftAltitudeFt({ altitudeBaroFt: 100, altitudeGeomFt: 0 })).toBe(0);
  });

  it("altitudeGeomFt が無ければ altitudeBaroFt", () => {
    expect(aircraftAltitudeFt({ altitudeBaroFt: 2500 })).toBe(2500);
  });

  it("どちらも無ければ null", () => {
    expect(aircraftAltitudeFt({ altitudeBaroFt: null })).toBeNull();
    expect(aircraftAltitudeM({ altitudeBaroFt: null })).toBeNull();
  });

  it("m は ft × 0.3048", () => {
    expect(aircraftAltitudeM({ altitudeBaroFt: 10000 })).toBeCloseTo(3048, 9);
    expect(aircraftAltitudeM({ altitudeBaroFt: 100, altitudeGeomFt: 1000 })).toBeCloseTo(304.8, 9);
  });
});

describe("仕様 6.5 の再現（利用地点から。空港座標は adsbdb）", () => {
  const nagareyama = { lat: 35.8709, lon: 139.9256 };

  it("羽田 RJTT: 37.8±0.3km・南南西", () => {
    const rjtt = { lat: 35.552299, lon: 139.779999 };
    const d = haversineKm(nagareyama, rjtt);
    expect(Math.abs(d - 37.8)).toBeLessThanOrEqual(0.3);
    expect(bearingToJa16(bearingDeg(nagareyama, rjtt))).toBe("南南西");
  });

  it("成田 RJAA: 43.3±0.3km・東南東", () => {
    const rjaa = { lat: 35.764702, lon: 140.386002 };
    const d = haversineKm(nagareyama, rjaa);
    expect(Math.abs(d - 43.3)).toBeLessThanOrEqual(0.3);
    expect(bearingToJa16(bearingDeg(nagareyama, rjaa))).toBe("東南東");
  });
});

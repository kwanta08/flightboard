import { describe, expect, it } from "vitest";
import type { Flight, FlightDetailResponse, TrackPoint } from "../../shared/types.ts";
import { reduceDetailState, trackForSelection, type DetailState } from "./detailState.ts";
import { buildRows } from "./flightRows.ts";
import { AIRCRAFT_ICON_SELECTED_CLASS } from "./mapIcons.ts";
import {
  aircraftAriaLabel,
  aircraftMarkers,
  aircraftZIndexOffset,
  isSelectKey,
  type LatLngPair,
  radiusBounds,
  radiusMeters,
  radiusViewChanged,
  reuseLine,
  reusePosition,
  reuseTrack,
  type SelectedTrack,
  selectedTrackLine,
  trackLine,
  unwrapLongitudeNear,
} from "./mapView.ts";

// 期待値の点は、テスト側で球面の到達点の公式を独立に書いて求める（R = 6371km）
const R_KM = 6371;
function destination(lat: number, lon: number, bearingDeg: number, distanceKm: number): { lat: number; lon: number } {
  const rad = Math.PI / 180;
  const d = distanceKm / R_KM;
  const b = bearingDeg * rad;
  const p1 = lat * rad;
  const l1 = lon * rad;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 / rad, lon: l2 / rad };
}

/** 浮動小数の誤差の許容（度） */
const EPS = 1e-9;

describe("radiusBounds（AC-B10）", () => {
  const center = { lat: 35.87, lon: 139.93 };
  const [[south, west], [north, east]] = radiusBounds(center, 50);
  const circle = Array.from({ length: 360 }, (_, deg) => destination(center.lat, center.lon, deg, 50));

  it("中心 35.87/139.93・50km の円（方位 0〜359° の 360 点）が矩形の内側", () => {
    for (const point of circle) {
      expect(point.lat).toBeGreaterThanOrEqual(south - EPS);
      expect(point.lat).toBeLessThanOrEqual(north + EPS);
      expect(point.lon).toBeGreaterThanOrEqual(west - EPS);
      expect(point.lon).toBeLessThanOrEqual(east + EPS);
    }
  });

  it("矩形は円にほぼ接する（緯度 ±50/111.195 = 0.4497°、経度 ±0.4497°/cos35.87° ≒ 0.5549°、±1%）", () => {
    expect(Math.abs(north - center.lat - 0.4497)).toBeLessThanOrEqual(0.004497);
    expect(Math.abs(center.lat - south - 0.4497)).toBeLessThanOrEqual(0.004497);
    expect(Math.abs(east - center.lon - 0.5549)).toBeLessThanOrEqual(0.005549);
    expect(Math.abs(center.lon - west - 0.5549)).toBeLessThanOrEqual(0.005549);
    // 円の点の最大・最小とのずれが半幅の 1% 未満（広すぎる矩形を通さない）
    const maxLon = Math.max(...circle.map((p) => p.lon));
    const maxLat = Math.max(...circle.map((p) => p.lat));
    expect(east - maxLon).toBeLessThan(0.005549);
    expect(north - maxLat).toBeLessThan(0.004497);
  });

  it("北極付近（89.9°）では北が 90 に丸まり、経度は全周", () => {
    const [[s, w], [n, e]] = radiusBounds({ lat: 89.9, lon: 10 }, 50);
    expect(n).toBe(90);
    expect(w).toBe(-180);
    expect(e).toBe(180);
    expect(Math.abs(s - (89.9 - 0.4497))).toBeLessThanOrEqual(0.004497);
  });

  it("南極付近（-89.9°）では南が -90 に丸まり、経度は全周", () => {
    const [[s, w], [n, e]] = radiusBounds({ lat: -89.9, lon: -20 }, 50);
    expect(s).toBe(-90);
    expect(w).toBe(-180);
    expect(e).toBe(180);
    expect(n).toBeLessThanOrEqual(90);
  });

  it("日付変更線の近く（中心 0/179.9°・50km）: 経度を切り詰めず東は 180 を超え、円の 360 点がすべて矩形の内側", () => {
    const nearDateline = { lat: 0, lon: 179.9 };
    const [[s, w], [n, e]] = radiusBounds(nearDateline, 50);
    expect(e).toBeGreaterThan(180);
    expect(Math.abs(e - (179.9 + 0.4497))).toBeLessThanOrEqual(0.004497);
    expect(Math.abs(w - (179.9 - 0.4497))).toBeLessThanOrEqual(0.004497);
    const points = Array.from({ length: 360 }, (_, deg) => destination(nearDateline.lat, nearDateline.lon, deg, 50));
    // 前提: 円（テスト側の公式は経度を折り返さない）は 180 を越える
    expect(Math.max(...points.map((p) => p.lon))).toBeGreaterThan(180);
    for (const p of points) {
      expect(p.lat).toBeGreaterThanOrEqual(s - EPS);
      expect(p.lat).toBeLessThanOrEqual(n + EPS);
      expect(p.lon).toBeGreaterThanOrEqual(w - EPS);
      expect(p.lon).toBeLessThanOrEqual(e + EPS);
    }
  });

  it("日付変更線の近く（中心 35/-179.9°・50km）: 西は -180 を下回り、円の 360 点がすべて矩形の内側", () => {
    const nearDateline = { lat: 35, lon: -179.9 };
    const [[s, w], [n, e]] = radiusBounds(nearDateline, 50);
    expect(w).toBeLessThan(-180);
    const points = Array.from({ length: 360 }, (_, deg) => destination(nearDateline.lat, nearDateline.lon, deg, 50));
    expect(Math.min(...points.map((p) => p.lon))).toBeLessThan(-180);
    for (const p of points) {
      expect(p.lat).toBeGreaterThanOrEqual(s - EPS);
      expect(p.lat).toBeLessThanOrEqual(n + EPS);
      expect(p.lon).toBeGreaterThanOrEqual(w - EPS);
      expect(p.lon).toBeLessThanOrEqual(e + EPS);
    }
  });

  it("半径が大きいほど矩形も大きい", () => {
    const [[s10, w10], [n10, e10]] = radiusBounds(center, 10);
    expect(n10 - s10).toBeLessThan(north - south);
    expect(e10 - w10).toBeLessThan(east - west);
  });
});

function point(lat: number, lon: number, at: string): TrackPoint {
  return { lat, lon, altitudeFt: 10000, at };
}

describe("trackLine", () => {
  const track = [point(35.3, 139.3, "2026-09-15T10:00:20Z"), point(35.1, 139.1, "2026-09-15T10:00:00Z"), point(35.2, 139.2, "2026-09-15T10:00:10Z")];

  it("点の順序を保つ（並べ替えない）", () => {
    expect(trackLine(track)).toEqual([
      [35.3, 139.3],
      [35.1, 139.1],
      [35.2, 139.2],
    ]);
  });

  it("末尾に現在位置を足す", () => {
    expect(trackLine(track, { lat: 35.25, lon: 139.25 })).toEqual([
      [35.3, 139.3],
      [35.1, 139.1],
      [35.2, 139.2],
      [35.25, 139.25],
    ]);
  });

  it("現在位置が最後の点と同じなら足さない", () => {
    expect(trackLine(track, { lat: 35.2, lon: 139.2 })).toHaveLength(3);
  });

  it("緯度だけ・経度だけ同じなら足す", () => {
    expect(trackLine(track, { lat: 35.2, lon: 139.21 })).toHaveLength(4);
    expect(trackLine(track, { lat: 35.21, lon: 139.2 })).toHaveLength(4);
  });

  it("最後以外の点と同じ位置なら足す", () => {
    expect(trackLine(track, { lat: 35.3, lon: 139.3 })).toHaveLength(4);
  });

  it("track が無ければ現在位置だけ、それも無ければ空", () => {
    expect(trackLine(undefined, { lat: 35, lon: 139 })).toEqual([[35, 139]]);
    expect(trackLine(undefined)).toEqual([]);
    expect(trackLine([], { lat: 35, lon: 139 })).toEqual([[35, 139]]);
  });

  it("入力の track を変えない", () => {
    const input = [point(35, 139, "2026-09-15T10:00:00Z")];
    trackLine(input, { lat: 36, lon: 140 });
    expect(input).toHaveLength(1);
  });
});

describe("aircraftAriaLabel", () => {
  it("コールサインがあれば「ANA245 を選択」", () => {
    expect(aircraftAriaLabel({ hex: "86e7a0", callsign: "ANA245" })).toBe("ANA245 を選択");
  });

  it("コールサインの前後の空白は除く", () => {
    expect(aircraftAriaLabel({ hex: "86e7a0", callsign: "ANA245  " })).toBe("ANA245 を選択");
  });

  it("コールサインが無い・空白だけなら hex", () => {
    expect(aircraftAriaLabel({ hex: "86e7a0" })).toBe("86e7a0 を選択");
    expect(aircraftAriaLabel({ hex: "86e7a0", callsign: "  " })).toBe("86e7a0 を選択");
  });

  it("貨物機は「（貨物）」を添える（地図のアイコンの色だけで区別しない）", () => {
    expect(aircraftAriaLabel({ hex: "a1b2c3", callsign: "FDX5901", kind: "cargo" })).toBe("FDX5901（貨物）を選択");
    expect(aircraftAriaLabel({ hex: "a1b2c3", kind: "cargo" })).toBe("a1b2c3（貨物）を選択");
  });

  it("旅客機・その他には添えない", () => {
    expect(aircraftAriaLabel({ hex: "86e7a0", callsign: "ANA245", kind: "passenger" })).toBe("ANA245 を選択");
    expect(aircraftAriaLabel({ hex: "86e7a0", callsign: "JA01XX", kind: "other" })).toBe("JA01XX を選択");
  });
});

describe("radiusMeters", () => {
  it("検索半径の km を Circle の半径の m にする（50km → 50,000m、10km → 10,000m）", () => {
    expect(radiusMeters(50)).toBe(50_000);
    expect(radiusMeters(10)).toBe(10_000);
  });
});

describe("radiusViewChanged（地点・半径が変わったときだけ表示範囲を合わせ直す）", () => {
  const view = { lat: 35.87, lon: 139.93, radiusKm: 50 };

  it("地点・半径が同じなら変わっていない（初回のマウントでは合わせ直さない）", () => {
    expect(radiusViewChanged(view, { ...view })).toBe(false);
  });

  it("緯度・経度・半径のどれか 1 つでも違えば変わった", () => {
    expect(radiusViewChanged(view, { ...view, lat: 35.88 })).toBe(true);
    expect(radiusViewChanged(view, { ...view, lon: 139.94 })).toBe(true);
    expect(radiusViewChanged(view, { ...view, radiusKm: 100 })).toBe(true);
  });
});

describe("isSelectKey", () => {
  it("Enter と Space で選択する", () => {
    expect(isSelectKey("Enter")).toBe(true);
    expect(isSelectKey(" ")).toBe(true);
  });

  it.each(["Escape", "ArrowUp", "Tab", "a"])("%s では選択しない", (key) => {
    expect(isSelectKey(key)).toBe(false);
  });
});

describe("aircraftZIndexOffset", () => {
  it("選択中だけ手前に出す", () => {
    expect(aircraftZIndexOffset(true)).toBeGreaterThan(aircraftZIndexOffset(false));
    expect(aircraftZIndexOffset(false)).toBe(0);
  });
});

describe("reusePosition", () => {
  it("値が同じなら前回の配列をそのまま返す", () => {
    const previous: LatLngPair = [35.87, 139.93];
    expect(reusePosition(previous, { lat: 35.87, lon: 139.93 })).toBe(previous);
  });

  it("値が違えば新しい配列", () => {
    const previous: LatLngPair = [35.87, 139.93];
    const next = reusePosition(previous, { lat: 35.88, lon: 139.93 });
    expect(next).not.toBe(previous);
    expect(next).toEqual([35.88, 139.93]);
  });

  it("前回が無ければ新しい配列", () => {
    expect(reusePosition(undefined, { lat: 1, lon: 2 })).toEqual([1, 2]);
  });
});

function makeFlight(overrides: Partial<Flight> & { hex: string }): Flight {
  return {
    position: { lat: 35.87, lon: 139.93, altitudeBaroFt: 10000, onGround: false },
    isMlat: false,
    seenPosSec: 0,
    kind: "passenger",
    source: "adsblol",
    ...overrides,
  };
}

describe("aircraftMarkers", () => {
  const receivedAt = 1_700_000_000_000;
  const flights = [
    makeFlight({ hex: "aaa111", callsign: "ANA245", groundSpeedKt: 100, trackDeg: 0 }),
    makeFlight({ hex: "bbb222", kind: "cargo" }),
  ];

  it("位置は補間した位置（真北へ 100kt・30 秒 → 1.543km 北、速度の無い機体は動かない）", () => {
    const [moving, still] = aircraftMarkers(flights, receivedAt, receivedAt + 30_000, undefined);
    expect(Math.abs((moving!.position.lat - 35.87) * 111.195 - 1.543)).toBeLessThanOrEqual(0.01543);
    expect(still!.position).toEqual({ lat: 35.87, lon: 139.93 });
  });

  it("選択中の機体だけ selected・強調のアイコン・手前", () => {
    const [a, b] = aircraftMarkers(flights, receivedAt, receivedAt, "bbb222");
    expect(a!.selected).toBe(false);
    expect(b!.selected).toBe(true);
    expect(b!.icon.className).toContain(AIRCRAFT_ICON_SELECTED_CLASS);
    expect(a!.icon.className).not.toContain(AIRCRAFT_ICON_SELECTED_CLASS);
    expect(b!.zIndexOffset).toBeGreaterThan(a!.zIndexOffset);
  });

  it("選択の hex が大文字でも同じ機体を選択中として表示する（大文字小文字を区別しない、結合レビュー MINOR-6）", () => {
    const [a, b] = aircraftMarkers(flights, receivedAt, receivedAt, "BBB222");
    expect(a!.selected).toBe(false);
    expect(b!.selected).toBe(true);
    expect(b!.icon.className).toContain(AIRCRAFT_ICON_SELECTED_CLASS);
    expect(b!.zIndexOffset).toBeGreaterThan(a!.zIndexOffset);
  });

  it("ボタン名と hex を持つ（貨物機のボタン名には「（貨物）」が付く）", () => {
    const [a, b] = aircraftMarkers(flights, receivedAt, receivedAt, undefined);
    expect(a!.hex).toBe("aaa111");
    expect(a!.label).toBe("ANA245 を選択");
    expect(b!.label).toBe("bbb222（貨物）を選択");
  });

  it("時刻が進んでも角度が同じならアイコンの key は変わらない", () => {
    const [before] = aircraftMarkers(flights, receivedAt, receivedAt + 1_000, undefined);
    const [after] = aircraftMarkers(flights, receivedAt, receivedAt + 2_000, undefined);
    expect(after!.icon.key).toBe(before!.icon.key);
  });
});

describe("selectedTrackLine", () => {
  const receivedAt = 1_700_000_000_000;
  const points = [point(35.8, 139.9, "2026-09-15T10:00:00Z")];
  // 機体 A（aaa111、位置 35.87/139.93）と機体 B（bbb222、位置 35.6/139.6）
  const flights = [makeFlight({ hex: "aaa111" }), makeFlight({ hex: "bbb222", position: { lat: 35.6, lon: 139.6, altitudeBaroFt: 10000, onGround: false } })];
  const markers = aircraftMarkers(flights, receivedAt, receivedAt, "aaa111");

  it("track.hex が選択と一致すれば、track の点に選択中の機体の位置を足した線を返す", () => {
    expect(selectedTrackLine(markers, "aaa111", { hex: "aaa111", points })).toEqual([
      [35.8, 139.9],
      [35.87, 139.93],
    ]);
  });

  it("track.hex が選択と違えば線を返さない（A の航跡に B の位置をつながない）", () => {
    const markersB = aircraftMarkers(flights, receivedAt, receivedAt, "bbb222");
    expect(selectedTrackLine(markersB, "bbb222", { hex: "aaa111", points })).toBeUndefined();
  });

  it("track.hex と選択の大文字小文字だけが違うなら一致とみなす", () => {
    expect(selectedTrackLine(markers, "aaa111", { hex: "AAA111", points })).toEqual([
      [35.8, 139.9],
      [35.87, 139.93],
    ]);
  });

  it("選択の hex が大文字でも、選択中の機体の位置を線の末尾に足す（結合レビュー MINOR-6）", () => {
    expect(selectedTrackLine(markers, "AAA111", { hex: "aaa111", points })).toEqual([
      [35.8, 139.9],
      [35.87, 139.93],
    ]);
  });

  it("track が無ければ線を出さない", () => {
    expect(selectedTrackLine(markers, "aaa111", undefined)).toBeUndefined();
  });

  it("未選択なら線を出さない", () => {
    expect(selectedTrackLine(markers, undefined, { hex: "aaa111", points })).toBeUndefined();
  });

  it("選択中の機体が一覧に居なければ track の点だけ", () => {
    expect(selectedTrackLine(markers, "zzz999", { hex: "zzz999", points })).toEqual([[35.8, 139.9]]);
  });
});

describe("reuseLine（航跡の線の配列を同値なら使い回す）", () => {
  it("点の数と各座標が同じなら前回の配列をそのまま返す", () => {
    const previous: LatLngPair[] = [
      [35.8, 139.9],
      [35.87, 139.93],
    ];
    const next: LatLngPair[] = [
      [35.8, 139.9],
      [35.87, 139.93],
    ];
    expect(reuseLine(previous, next)).toBe(previous);
  });

  it("1 点でも緯度か経度が違えば新しい配列（next）", () => {
    const previous: LatLngPair[] = [
      [35.8, 139.9],
      [35.87, 139.93],
    ];
    const latChanged: LatLngPair[] = [
      [35.8, 139.9],
      [35.88, 139.93],
    ];
    const lonChanged: LatLngPair[] = [
      [35.8, 139.91],
      [35.87, 139.93],
    ];
    expect(reuseLine(previous, latChanged)).toBe(latChanged);
    expect(reuseLine(previous, lonChanged)).toBe(lonChanged);
  });

  it("点の数が違えば新しい配列（next）", () => {
    const shorter: LatLngPair[] = [[35.8, 139.9]];
    const longer: LatLngPair[] = [
      [35.8, 139.9],
      [35.87, 139.93],
    ];
    expect(reuseLine(shorter, longer)).toBe(longer);
    expect(reuseLine(longer, shorter)).toBe(shorter);
  });

  it("前回が無ければ next", () => {
    const next: LatLngPair[] = [[35.8, 139.9]];
    expect(reuseLine(undefined, next)).toBe(next);
  });

  it("動かない機体の航跡: 1 秒後に作り直した線（別の配列）でも前回の参照を使い回せる", () => {
    const receivedAt = 1_700_000_000_000;
    const flights = [makeFlight({ hex: "aaa111" })];
    const track = { hex: "aaa111", points: [point(35.8, 139.9, "2026-09-15T10:00:00Z")] };
    const first = selectedTrackLine(aircraftMarkers(flights, receivedAt, receivedAt, "aaa111"), "aaa111", track);
    const second = selectedTrackLine(aircraftMarkers(flights, receivedAt, receivedAt + 1_000, "aaa111"), "aaa111", track);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(reuseLine(first, second!)).toBe(first);
  });
});

describe("unwrapLongitudeNear（経度を観測地点の経度に最も近い同値へ寄せる）", () => {
  it("中心 179.9°・機体 -179.9° → 180.1°", () => {
    expect(unwrapLongitudeNear(-179.9, 179.9)).toBeCloseTo(180.1, 9);
  });

  it("中心 -179.9°・機体 179.9° → -180.1°", () => {
    expect(unwrapLongitudeNear(179.9, -179.9)).toBeCloseTo(-180.1, 9);
  });

  it("中心 139.9°・機体 140.1° → そのまま（同じ値）", () => {
    expect(unwrapLongitudeNear(140.1, 139.9)).toBe(140.1);
  });

  it("観測地点から 180° 未満の経度は変えない", () => {
    expect(unwrapLongitudeNear(-40, 139.9)).toBe(-40);
    expect(unwrapLongitudeNear(179.9, 0)).toBe(179.9);
    expect(unwrapLongitudeNear(0, 179.9)).toBe(0);
  });

  it("±180 を超えた中心（地図の連続した経度）にも寄せる（中心 180.2°・機体 -179.5° → 180.5°）", () => {
    expect(unwrapLongitudeNear(-179.5, 180.2)).toBeCloseTo(180.5, 9);
  });

  it("非有限なら lon のまま", () => {
    expect(unwrapLongitudeNear(Number.NaN, 179.9)).toBeNaN();
    expect(unwrapLongitudeNear(-179.9, Number.NaN)).toBe(-179.9);
  });
});

describe("日付変更線の近く: 地図の機体の位置と航跡の点を観測地点の経度に寄せる", () => {
  const receivedAt = 1_700_000_000_000;
  function flightAt(hex: string, lon: number, overrides: Partial<Flight> = {}): Flight {
    return makeFlight({ hex, position: { lat: 0, lon, altitudeBaroFt: 10000, onGround: false }, ...overrides });
  }

  it("中心 179.9° の地図で経度 -179.9° の機体は 180.1° に置く（360° 離れた側に出さない）", () => {
    const [marker] = aircraftMarkers([flightAt("ccc333", -179.9)], receivedAt, receivedAt, undefined, 179.9);
    expect(marker!.position.lat).toBe(0);
    expect(marker!.position.lon).toBeCloseTo(180.1, 9);
  });

  it("中心 -179.9° の地図で経度 179.9° の機体は -180.1° に置く", () => {
    const [marker] = aircraftMarkers([flightAt("ddd444", 179.9)], receivedAt, receivedAt, undefined, -179.9);
    expect(marker!.position.lon).toBeCloseTo(-180.1, 9);
  });

  it("補間の起点を寄せる（中心 179.9°・経度 -179.99° の機体が真東へ 100kt・30 秒 → 180.01° から東へ 1.543km）", () => {
    const moving = flightAt("eee555", -179.99, { groundSpeedKt: 100, trackDeg: 90 });
    const [marker] = aircraftMarkers([moving], receivedAt, receivedAt + 30_000, undefined, 179.9);
    // 赤道上の経度 1° = 111.195km
    expect(Math.abs((marker!.position.lon - 180.01) * 111.195 - 1.543)).toBeLessThanOrEqual(0.01543);
  });

  it("観測地点から遠くない通常の地点では位置が変わらない（中心 139.9°・機体 140.1°）", () => {
    const flight = makeFlight({ hex: "fff666", position: { lat: 35.87, lon: 140.1, altitudeBaroFt: 10000, onGround: false } });
    expect(aircraftMarkers([flight], receivedAt, receivedAt, undefined, 139.9)[0]!.position).toEqual({ lat: 35.87, lon: 140.1 });
  });

  it("航跡の点が日付変更線をまたいでも線は連続（中心 179.9°: 179.8, 179.95, -179.95, -179.8 → 179.8, 179.95, 180.05, 180.2、末尾に機体の位置 180.3）", () => {
    const points = [
      point(0, 179.8, "2026-09-15T10:00:00Z"),
      point(0, 179.95, "2026-09-15T10:00:10Z"),
      point(0, -179.95, "2026-09-15T10:00:20Z"),
      point(0, -179.8, "2026-09-15T10:00:30Z"),
    ];
    const markers = aircraftMarkers([flightAt("ccc333", -179.7)], receivedAt, receivedAt, "ccc333", 179.9);
    const line = selectedTrackLine(markers, "ccc333", { hex: "ccc333", points }, 179.9);
    expect(line).toHaveLength(5);
    const lons = line!.map(([, lon]) => lon);
    expect(lons[0]).toBe(179.8);
    expect(lons[1]).toBe(179.95);
    expect(lons[2]).toBeCloseTo(180.05, 9);
    expect(lons[3]).toBeCloseTo(180.2, 9);
    expect(lons[4]).toBeCloseTo(180.3, 9);
    // 隣り合う点の経度が 360° 飛ばない（東へ単調に進み、差は 1° 未満）
    for (let index = 1; index < lons.length; index += 1) {
      expect(lons[index]! - lons[index - 1]!).toBeGreaterThan(0);
      expect(lons[index]! - lons[index - 1]!).toBeLessThan(1);
    }
  });

  it("中心 -179.9° では航跡の点 179.9° を -180.1° に寄せる（trackLine）", () => {
    const line = trackLine([point(0, 179.9, "2026-09-15T10:00:00Z")], { lat: 0, lon: -179.95 }, -179.9);
    expect(line).toHaveLength(2);
    expect(line[0]![1]).toBeCloseTo(-180.1, 9);
    expect(line[1]).toEqual([0, -179.95]);
  });

  it("通常の地点の航跡は点の値が変わらない（中心 139.9°）", () => {
    const points = [point(35.8, 139.9, "2026-09-15T10:00:00Z"), point(35.85, 140.1, "2026-09-15T10:00:10Z")];
    const markers = aircraftMarkers([makeFlight({ hex: "aaa111" })], receivedAt, receivedAt, "aaa111", 139.9);
    expect(selectedTrackLine(markers, "aaa111", { hex: "aaa111", points }, 139.9)).toEqual([
      [35.8, 139.9],
      [35.85, 140.1],
      [35.87, 139.93],
    ]);
  });

  it("入力の機体を変えず、一覧の距離・方角（buildRows は受信した位置で計算）は寄せる前と同じ", () => {
    const observer = { lat: 0, lon: 179.9, elevationM: 0 };
    const flight = flightAt("ccc333", -179.9);
    const [before] = buildRows([flight], observer);
    aircraftMarkers([flight], receivedAt, receivedAt, "ccc333", observer.lon);
    expect(flight.position.lon).toBe(-179.9);
    const [after] = buildRows([flight], observer);
    expect(after!.distanceText).toBe(before!.distanceText);
    expect(after!.bearingText).toBe(before!.bearingText);
    // 前提: 受信した位置のままでも、日付変更線の向こうの近い機体（0.2° × 111.195 ≒ 22km・東）として計算される
    expect(before!.distanceText).toBe("22km");
    expect(before!.bearingText).toBe("東");
  });
});

describe("reuseTrack（航跡の参照を使い回す、W7 コードレビュー MINOR-5）", () => {
  const points = [point(35.8, 139.9, "2026-09-15T10:00:00Z")];

  it("同じ hex・同じ points の参照なら、別のオブジェクトでも前回のオブジェクトを返す", () => {
    const previous: SelectedTrack = { hex: "aaa111", points };
    expect(reuseTrack(previous, { hex: "aaa111", points })).toBe(previous);
  });

  it("points の参照が変われば（値が同じでも）新しいもの", () => {
    const previous: SelectedTrack = { hex: "aaa111", points };
    const next: SelectedTrack = { hex: "aaa111", points: [...points] };
    expect(reuseTrack(previous, next)).toBe(next);
  });

  it("hex が変われば新しいもの", () => {
    const previous: SelectedTrack = { hex: "aaa111", points };
    const next: SelectedTrack = { hex: "bbb222", points };
    expect(reuseTrack(previous, next)).toBe(next);
  });

  it("前回が無ければ next、next が無ければ undefined", () => {
    const next: SelectedTrack = { hex: "aaa111", points };
    expect(reuseTrack(undefined, next)).toBe(next);
    expect(reuseTrack(next, undefined)).toBeUndefined();
    expect(reuseTrack(undefined, undefined)).toBeUndefined();
  });

  it("詳細の状態が取り直し中・失敗に変わっても trackForSelection の結果を使い回すと同じ参照、新しい詳細が届けば新しい", () => {
    const detail: FlightDetailResponse = { updatedAt: "2026-09-15T10:00:00Z", flight: makeFlight({ hex: "aaa111" }), track: points };
    const loaded: DetailState = { hex: "aaa111", status: "loaded", detail };
    const first = trackForSelection(loaded, "aaa111");
    const refreshing = reduceDetailState(loaded, { type: "request" });
    const failed = reduceDetailState(refreshing, { type: "failure", hex: "aaa111" });
    // 前提: 状態のオブジェクトは変わっている
    expect(refreshing).not.toBe(loaded);
    expect(failed).not.toBe(refreshing);
    const second = reuseTrack(first, trackForSelection(refreshing, "aaa111"));
    expect(second).toBe(first);
    expect(reuseTrack(second, trackForSelection(failed, "aaa111"))).toBe(first);

    const newer: FlightDetailResponse = { ...detail, track: [point(35.81, 139.91, "2026-09-15T10:00:10Z")] };
    const reloaded = reduceDetailState(failed, { type: "success", hex: "aaa111", detail: newer });
    const third = reuseTrack(first, trackForSelection(reloaded, "aaa111"));
    expect(third).not.toBe(first);
    expect(third?.points).toBe(newer.track);
  });
});

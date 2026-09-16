import { describe, expect, it } from "vitest";
import type { Airport, Flight } from "../../shared/types.ts";
import { buildDetailView } from "./detailView.ts";
import { buildEstimateBadge } from "./estimateView.ts";
import {
  buildRows,
  CARGO_BADGE_LABEL,
  classifyVisibility,
  type FlightRow,
  HARD_TO_SEE_ELEVATION_DEG,
  nextRadius,
  type Observer,
  sortRows,
  summaryText,
  visibilityLabel,
} from "./flightRows.ts";
import { DEFAULT_UNITS, ELEVATION_ONE_DECIMAL_BELOW_DEG, nonEmpty, type Units } from "./format.ts";
import { TYPE_NAMES, typeDisplayName } from "./typeNames.ts";

// 仕様 6.5 の利用地点（流山）
const NAGAREYAMA: Observer = { lat: 35.8709, lon: 139.9256, elevationM: 15 };

const HND: Airport = { icao: "RJTT", iata: "HND", name: "Tokyo Haneda International Airport", municipality: "Tokyo", lat: 35.552299, lon: 139.779999 };
const FUK: Airport = { icao: "RJFF", iata: "FUK", name: "Fukuoka Airport", municipality: "Fukuoka", lat: 33.585899, lon: 130.451004 };

function makeFlight(overrides: Partial<Flight> & { hex: string }): Flight {
  return {
    position: { lat: 35.552299, lon: 139.779999, altitudeBaroFt: 3000, onGround: false },
    isMlat: false,
    seenPosSec: 0,
    kind: "passenger",
    source: "adsblol",
    ...overrides,
  };
}

// 仕様 §11: ε = atan((h − h₀)/d − d/(2R))、R = 6371km。
// 観測者の真北 d km に置いた機体が仰角 ε になる高度（ft）を、この式を h について解いて求める
const R_M = 6371 * 1000;
function flightAtElevation(hex: string, observer: Observer, elevationDeg: number, horizontalKm = 10): Flight {
  const dM = horizontalKm * 1000;
  const dLatDeg = (horizontalKm / 6371) * (180 / Math.PI); // 同じ経度なら haversine の距離は R × Δφ
  const heightM = observer.elevationM + dM * (Math.tan((elevationDeg * Math.PI) / 180) + dM / (2 * R_M));
  return makeFlight({
    hex,
    position: { lat: observer.lat + dLatDeg, lon: observer.lon, altitudeBaroFt: null, altitudeGeomFt: heightM / 0.3048, onGround: false },
  });
}

function onlyRow(rows: FlightRow[]): FlightRow {
  expect(rows).toHaveLength(1);
  return rows[0] as FlightRow;
}

describe("buildRows: 観測地点から見た距離・方位・仰角（§11）", () => {
  // 流山（標高 15m）から RJTT 上空 3000ft の機体（仕様 6.5）
  // 手計算: 南北 0.318601° × 111.195 = 35.43km、東西 0.145601° × cos(35.71°) × 111.195 = 13.15km → d ≈ 37.79km
  // 方位 180 + atan(13.15/35.43) ≈ 200.4° → 南南西
  // 仰角 atan((914.4 − 15)/37,790 − 37.79/(2 × 6371)) = atan(0.023800 − 0.002966) ≈ 1.19°
  const hanedaRow = () => onlyRow(buildRows([makeFlight({ hex: "86e7a0" })], NAGAREYAMA));

  it("水平距離は 37.8±0.3km、表示は「38km」", () => {
    const row = hanedaRow();
    expect(Math.abs(row.distanceKm - 37.8)).toBeLessThanOrEqual(0.3);
    expect(row.distanceText).toBe("38km");
  });

  it("方位は「南南西」", () => {
    expect(hanedaRow().bearingText).toBe("南南西");
  });

  it("仰角は約 1.19°（±0.05）、表示は 0.1° 単位の切り捨てで「1.1°」", () => {
    const row = hanedaRow();
    expect(row.elevationDeg).toBeDefined();
    expect(Math.abs((row.elevationDeg as number) - 1.19)).toBeLessThanOrEqual(0.05);
    expect(row.elevationText).toBe("1.1°");
  });

  it("仰角 10° 未満なので hard・「見えにくい」", () => {
    const row = hanedaRow();
    expect(row.visibility).toBe("hard");
    expect(row.visibilityLabel).toBe("見えにくい");
  });

  it("高度は 3000ft = 914.4m、表示は「910m」", () => {
    const row = hanedaRow();
    expect(row.altitudeM).toBeCloseTo(914.4, 6);
    expect(row.altitudeText).toBe("910m");
  });
});

describe("buildRows: 高度は altitudeGeomFt を優先する", () => {
  it("altitudeGeomFt があれば altitudeBaroFt より優先する", () => {
    const row = onlyRow(
      buildRows([makeFlight({ hex: "a1", position: { lat: 35.552299, lon: 139.779999, altitudeBaroFt: 3000, altitudeGeomFt: 6600, onGround: false } })], NAGAREYAMA),
    );
    expect(row.altitudeM).toBeCloseTo(2011.68, 6);
    expect(row.altitudeText).toBe("2,010m");
  });

  it("altitudeGeomFt: 0 を落とさない（0m、観測者の 15m より低いので仰角は負）", () => {
    const row = onlyRow(
      buildRows([makeFlight({ hex: "a2", position: { lat: 35.552299, lon: 139.779999, altitudeBaroFt: 3000, altitudeGeomFt: 0, onGround: false } })], NAGAREYAMA),
    );
    expect(row.altitudeM).toBe(0);
    expect(row.altitudeText).toBe("0m");
    expect(row.elevationDeg as number).toBeLessThan(0);
    expect(row.visibility).toBe("belowHorizon");
    expect(row.visibilityLabel).toBe("地平線の下");
  });

  it("altitudeGeomFt が無ければ altitudeBaroFt", () => {
    const row = onlyRow(buildRows([makeFlight({ hex: "a3" })], NAGAREYAMA));
    expect(row.altitudeM).toBeCloseTo(914.4, 6);
  });

  it("高度がどちらも無ければ 高度・仰角・見え方は無し（「—」）で、距離・方位は出す", () => {
    const row = onlyRow(
      buildRows([makeFlight({ hex: "a4", position: { lat: 35.552299, lon: 139.779999, altitudeBaroFt: null, onGround: true } })], NAGAREYAMA),
    );
    expect(row.altitudeM).toBeUndefined();
    expect(row.altitudeText).toBe("—");
    expect(row.elevationDeg).toBeUndefined();
    expect(row.elevationText).toBe("—");
    expect(row.visibility).toBeUndefined();
    expect(row.visibilityLabel).toBeUndefined();
    expect(row.distanceText).toBe("38km");
    expect(row.bearingText).toBe("南南西");
  });
});

describe("見え方の区分（AC-B6）", () => {
  it.each([
    [9.99, "hard", "見えにくい"],
    [10, "visible", undefined],
    [-0.01, "belowHorizon", "地平線の下"],
    [0, "hard", "見えにくい"],
    [45, "visible", undefined],
  ] as const)("classifyVisibility(%s) → %s", (deg, expected, label) => {
    expect(classifyVisibility(deg)).toBe(expected);
    expect(visibilityLabel(classifyVisibility(deg))).toBe(label);
  });

  it("仰角が無ければ undefined", () => {
    expect(classifyVisibility(undefined)).toBeUndefined();
    expect(classifyVisibility(Number.NaN)).toBeUndefined();
    expect(visibilityLabel(undefined)).toBeUndefined();
  });

  it.each([
    [9.99, "hard", "見えにくい"],
    [10.01, "visible", undefined],
    [0.01, "hard", "見えにくい"],
    [-0.01, "belowHorizon", "地平線の下"],
  ] as const)("観測者の真北 10km・仰角 %s° になる高さの機体 → %s", (deg, expected, label) => {
    const row = onlyRow(buildRows([flightAtElevation("b1", NAGAREYAMA, deg)], NAGAREYAMA));
    expect(row.distanceKm).toBeCloseTo(10, 6);
    expect(row.bearingText).toBe("北");
    expect(row.elevationDeg as number).toBeCloseTo(deg, 6);
    expect(row.visibility).toBe(expected);
    expect(row.visibilityLabel).toBe(label);
  });

  it("区分の境界と仰角の表示を小数 1 桁にする境界は同じ値（10°）", () => {
    expect(HARD_TO_SEE_ELEVATION_DEG).toBe(10);
    expect(ELEVATION_ONE_DECIMAL_BELOW_DEG).toBe(HARD_TO_SEE_ELEVATION_DEG);
  });

  it.each([
    [9.99, "hard", "9.9°"],
    [-0.01, "belowHorizon", "-0.1°"],
  ] as const)("真北 10km・仰角 %s° の機体: 区分 %s、表示「%s」", (deg, expected, text) => {
    const row = onlyRow(buildRows([flightAtElevation("b2", NAGAREYAMA, deg)], NAGAREYAMA));
    expect(row.visibility).toBe(expected);
    expect(row.elevationText).toBe(text);
  });

  // 表示の数値と区分の組合せ: visible ⇔ 表示 ≥ 10、hard ⇔ 0 ≤ 表示 < 10、belowHorizon ⇔ 表示 < 0
  it.each([9.99, 10, 10.01, 9.999, 0.01, 0, -0.01, -0.001, 5, 45])(
    "真北 10km・仰角 %s° 付近の機体: 表示の数値と区分が食い違わない",
    (deg) => {
      const row = onlyRow(buildRows([flightAtElevation("b3", NAGAREYAMA, deg)], NAGAREYAMA));
      const shown = Number.parseFloat(row.elevationText);
      expect(Number.isFinite(shown)).toBe(true);
      if (row.visibility === "visible") {
        expect(shown).toBeGreaterThanOrEqual(10);
      } else if (row.visibility === "hard") {
        expect(shown).toBeLessThan(10);
        expect(shown).toBeGreaterThanOrEqual(0);
      } else {
        expect(row.visibility).toBe("belowHorizon");
        expect(shown).toBeLessThan(0);
      }
    },
  );

  it("仰角 -1°〜11° を 0.001° 刻みで: hard の行の表示は 10 未満、belowHorizon の行の表示は負、visible の行の表示は 10 以上", () => {
    const mismatches: string[] = [];
    for (let milli = -1000; milli <= 11_000; milli += 1) {
      const row = onlyRow(buildRows([flightAtElevation("b4", NAGAREYAMA, milli / 1000)], NAGAREYAMA));
      const shown = Number.parseFloat(row.elevationText);
      const ok =
        (row.visibility === "visible" && shown >= 10) ||
        (row.visibility === "hard" && shown >= 0 && shown < 10) ||
        (row.visibility === "belowHorizon" && shown < 0);
      if (!ok) {
        mismatches.push(`${row.elevationDeg}° → ${row.elevationText}（${row.visibility}）`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe("buildRows: 行の表示文字列（AC-B4）", () => {
  it("すべての値が揃った機体", () => {
    const row = onlyRow(
      buildRows(
        [
          makeFlight({
            hex: "86e7a0",
            callsign: "JAL123",
            typeCode: "B763",
            groundSpeedKt: 250,
            verticalRateFpm: -704,
            airline: { icao: "JAL", iata: "JL", name: "Japan Airlines" },
            route: { origin: HND, destination: FUK, source: "adsbdb" },
          }),
        ],
        NAGAREYAMA,
      ),
    );
    expect(row.hex).toBe("86e7a0");
    expect(row.callsign).toBe("JAL123");
    expect(row.callsignText).toBe("JAL123");
    expect(row.airlineText).toBe("Japan Airlines");
    expect(row.routeText).toBe("HND Tokyo → FUK Fukuoka");
    expect(row.typeText).toBe("B767-300");
    expect(row.altitudeText).toBe("910m");
    expect(row.speedText).toBe("463km/h");
    expect(row.trend).toBe("descend");
    expect(row.trendText).toBe("▼ 下降");
    expect(row.distanceText).toBe("38km");
    expect(row.bearingText).toBe("南南西");
    expect(row.elevationText).toBe("1.1°");
    expect(row.isCargo).toBe(false);
    expect(row.badgeText).toBeUndefined();
  });

  it("元の Flight をそのまま持つ", () => {
    const flight = makeFlight({ hex: "c1" });
    expect(onlyRow(buildRows([flight], NAGAREYAMA)).flight).toBe(flight);
  });

  it("routeText: IATA の無い空港は ICAO、都市名の無い空港はコードのみ", () => {
    const noIata: Airport = { icao: "RJTF", name: "Chofu Airport", municipality: "Chofu" };
    const noCity: Airport = { icao: "RJFF", iata: "FUK", name: "Fukuoka Airport" };
    const row = onlyRow(buildRows([makeFlight({ hex: "c2", route: { origin: noIata, destination: noCity, source: "adsbdb" } })], NAGAREYAMA));
    expect(row.routeText).toBe("RJTF Chofu → FUK");
  });

  it("route の無い機体を含む入力でも件数は入力と同じで、その行の routeText は undefined", () => {
    const flights = [
      makeFlight({ hex: "d1", route: { origin: HND, destination: FUK, source: "adsbdb" } }),
      makeFlight({ hex: "d2" }), // ルート未付与（初回応答）
      makeFlight({ hex: "d3", route: { origin: FUK, destination: HND, source: "adsbdb" } }),
    ];
    const rows = buildRows(flights, NAGAREYAMA);
    expect(rows).toHaveLength(flights.length);
    expect(rows.map((row) => row.hex)).toEqual(["d1", "d2", "d3"]);
    expect(rows[0]?.routeText).toBe("HND Tokyo → FUK Fukuoka");
    expect(rows[1]?.routeText).toBeUndefined();
    expect(rows[2]?.routeText).toBe("FUK Fukuoka → HND Tokyo");
  });

  it("ルートの無い機体だけでも全件が行になる", () => {
    const flights = [makeFlight({ hex: "e1" }), makeFlight({ hex: "e2" })];
    expect(buildRows(flights, NAGAREYAMA)).toHaveLength(2);
  });

  it("空の入力は空の行", () => {
    expect(buildRows([], NAGAREYAMA)).toEqual([]);
  });

  it("kind が cargo なら isCargo（other・passenger は false）", () => {
    const rows = buildRows(
      [makeFlight({ hex: "f1", kind: "cargo" }), makeFlight({ hex: "f2", kind: "passenger" }), makeFlight({ hex: "f3", kind: "other" })],
      NAGAREYAMA,
    );
    expect(rows.map((row) => row.isCargo)).toEqual([true, false, false]);
  });

  it("badgeText: cargo は「貨物」、passenger・other は undefined", () => {
    expect(CARGO_BADGE_LABEL).toBe("貨物");
    const rows = buildRows(
      [makeFlight({ hex: "f1", kind: "cargo" }), makeFlight({ hex: "f2", kind: "passenger" }), makeFlight({ hex: "f3", kind: "other" })],
      NAGAREYAMA,
    );
    expect(rows.map((row) => row.badgeText)).toEqual(["貨物", undefined, undefined]);
  });

  it("値の無い項目は「—」（コールサイン無しは hex、昇降率無しは区分無し）", () => {
    const row = onlyRow(buildRows([makeFlight({ hex: "86e7a1" })], NAGAREYAMA));
    expect(row.callsignText).toBe("86e7a1");
    expect(row.airlineText).toBe("—");
    expect(row.routeText).toBeUndefined();
    expect(row.typeText).toBe("—");
    expect(row.speedText).toBe("—");
    expect(row.trend).toBeUndefined();
    expect(row.trendText).toBeUndefined();
  });

  it("空白だけのコールサインは hex で出す", () => {
    expect(onlyRow(buildRows([makeFlight({ hex: "86e7a2", callsign: "  " })], NAGAREYAMA)).callsignText).toBe("86e7a2");
  });

  it("callsign: 前後の空白を除き、空・空白だけ・無しは undefined（callsignText はそこから派生）", () => {
    const rows = buildRows(
      [
        makeFlight({ hex: "h1", callsign: " JAL123 " }),
        makeFlight({ hex: "h2", callsign: "  " }),
        makeFlight({ hex: "h3", callsign: "" }),
        makeFlight({ hex: "h4" }),
      ],
      NAGAREYAMA,
    );
    expect(rows.map((row) => row.callsign)).toEqual(["JAL123", undefined, undefined, undefined]);
    expect(rows.map((row) => row.callsignText)).toEqual(["JAL123", "h2", "h3", "h4"]);
  });

  it("昇降率 +1000fpm は「▲ 上昇」、0fpm は「― 水平」", () => {
    const rows = buildRows([makeFlight({ hex: "g1", verticalRateFpm: 1000 }), makeFlight({ hex: "g2", verticalRateFpm: 0 })], NAGAREYAMA);
    expect(rows.map((row) => row.trendText)).toEqual(["▲ 上昇", "― 水平"]);
  });
});

describe("buildRows: 経路の推定バッジ（AC-P2-50）", () => {
  it("estimate のある機体の行にバッジが載る（文言は estimateView.ts が決める）", () => {
    const flight = makeFlight({
      hex: "p1",
      estimate: { phase: "arrival", airport: { icao: "RJTT", name: "羽田" }, runway: "22", confidence: 0.9, evidence: [] },
    });
    const row = onlyRow(buildRows([flight], NAGAREYAMA));
    expect(row.estimateBadge).toEqual(buildEstimateBadge(flight.estimate, row.altitudeFt));
    expect(row.estimateBadge?.text).toBe("HND RWY22 進入 確度:高");
  });

  it("estimate の無い機体の行には載らない", () => {
    expect(onlyRow(buildRows([makeFlight({ hex: "p2" })], NAGAREYAMA)).estimateBadge).toBeUndefined();
  });

  it("推定のある機体と無い機体が混ざっても、ある行だけに載る（3000ft ≒ 910m）", () => {
    const rows = buildRows(
      [
        makeFlight({ hex: "p3", estimate: { phase: "enroute", confidence: 0.5, evidence: [] } }),
        makeFlight({ hex: "p4" }),
      ],
      NAGAREYAMA,
    );
    expect(rows.map((row) => row.estimateBadge?.text)).toEqual(["通過（巡航 910m）", undefined]);
  });
});

describe("buildRows: 表示の単位（F-09・AC-P2-72）", () => {
  const FEET_AND_KNOTS: Units = { altitude: "ft", speed: "kt" };
  // 既定の機体は altitudeBaroFt 3000（= 914.4m）
  const rowWith = (units?: Units) =>
    onlyRow(buildRows([makeFlight({ hex: "u1", groundSpeedKt: 250, verticalRateFpm: 1000 })], NAGAREYAMA, units));

  it("ft・kt を渡すと高度と対地速度がその単位で出る", () => {
    const row = rowWith(FEET_AND_KNOTS);
    expect(row.altitudeText).toBe("3,000ft");
    expect(row.speedText).toBe("250kt");
  });

  it("単位を渡さなければ m・km/h（既定。Q6）", () => {
    const row = rowWith();
    expect(row.altitudeText).toBe("910m");
    expect(row.speedText).toBe("463km/h");
  });

  it("高度だけ ft にしても速度は km/h のまま（項目ごとに独立している）", () => {
    const row = rowWith({ altitude: "ft", speed: "kmh" });
    expect(row.altitudeText).toBe("3,000ft");
    expect(row.speedText).toBe("463km/h");
  });

  it("距離は km、昇降の区分の文字は単位で変わらない（切り替えるのは高度と対地速度だけ）", () => {
    const row = rowWith(FEET_AND_KNOTS);
    expect(row.distanceText).toBe("38km");
    expect(row.trendText).toBe("▲ 上昇");
  });

  it("並び替えのキー（altitudeM）は単位を変えても m のまま", () => {
    expect(rowWith(FEET_AND_KNOTS).altitudeM).toBeCloseTo(914.4, 6);
    expect(rowWith(FEET_AND_KNOTS).altitudeM).toBe(rowWith().altitudeM);
  });

  it("推定バッジの高度も同じ単位で出る（通過の「巡航」）", () => {
    const flights = [makeFlight({ hex: "u2", estimate: { phase: "enroute", confidence: 0.5, evidence: [] } })];
    expect(onlyRow(buildRows(flights, NAGAREYAMA, FEET_AND_KNOTS)).estimateBadge?.text).toBe("通過（巡航 3,000ft）");
    expect(onlyRow(buildRows(flights, NAGAREYAMA)).estimateBadge?.text).toBe("通過（巡航 910m）");
  });
});

describe("buildRows: ft 表示の丸めは詳細と一致する（W7 コードレビュー MAJOR-1）", () => {
  // ADS-B の高度（alt_baro / alt_geom）は 25ft 刻みで届くので x25 / x75 は日常的に出る。
  // 一覧・バッジが m に換算してから ft に戻していたころは、浮動小数の誤差で 10ft 単位の丸めが
  // 詳細（ft のまま丸める）と逆向きになり、同じ機体が一覧「870ft」／詳細「880ft」と食い違っていた
  const FEET: Units = { altitude: "ft", speed: "kmh" };

  function detailAltitudeText(flight: Flight, units: Units): string | undefined {
    const view = buildDetailView({ updatedAt: "2026-09-16T00:00:00.000Z", flight, track: [] }, NAGAREYAMA, undefined, units);
    return view.sections
      .find((section) => section.title === "飛行状態")
      ?.items.find((item) => item.label === "GNSS 高度")?.value;
  }

  function enrouteFlightAt(altitudeGeomFt: number): Flight {
    return makeFlight({
      hex: "q1",
      position: { lat: 35.552299, lon: 139.779999, altitudeBaroFt: null, altitudeGeomFt, onGround: false },
      estimate: { phase: "enroute", confidence: 0.5, evidence: [] },
    });
  }

  it.each([875, 225, 1725, 7525])("%sft: 一覧・推定バッジ・詳細が同じ文字", (altitudeGeomFt) => {
    const flight = enrouteFlightAt(altitudeGeomFt);
    const row = onlyRow(buildRows([flight], NAGAREYAMA, FEET));
    const detailText = detailAltitudeText(flight, FEET);
    expect(row.altitudeText).toBe(detailText);
    expect(row.estimateBadge?.text).toBe(`通過（巡航 ${detailText}）`);
  });

  it("875ft は 10ft 単位の四捨五入で「880ft」（切り下げの「870ft」にしない）", () => {
    const row = onlyRow(buildRows([enrouteFlightAt(875)], NAGAREYAMA, FEET));
    expect(row.altitudeText).toBe("880ft");
    expect(row.estimateBadge?.text).toBe("通過（巡航 880ft）");
    expect(row.altitudeFt).toBe(875); // 行は受信した ft をそのまま持ち、表示はこれを丸める
  });

  it("m 表示は ft を換算して丸めるので、詳細と同じまま（875ft = 266.7m → 270m）", () => {
    const flight = enrouteFlightAt(875);
    const row = onlyRow(buildRows([flight], NAGAREYAMA));
    expect(row.altitudeText).toBe("270m");
    expect(row.altitudeText).toBe(detailAltitudeText(flight, DEFAULT_UNITS));
    expect(row.estimateBadge?.text).toBe("通過（巡航 270m）");
  });
});

describe("typeDisplayName（機種の表示名）", () => {
  it.each([
    ["B763", "B767-300"], // F-03 の例示
    ["A20N", "A320neo"],
    ["B38M", "B737 MAX 8"],
    ["B77W", "B777-300ER"],
    ["DH8D", "DHC-8-400"],
    ["AT76", "ATR 72-600"],
  ])("%s → %s", (code, expected) => {
    expect(typeDisplayName(code)).toBe(expected);
  });

  it("表に無い型式は typeCode のまま、typeCode が無ければ「—」", () => {
    expect(typeDisplayName("C172")).toBe("C172");
    expect(typeDisplayName(undefined)).toBe("—");
    expect(typeDisplayName("")).toBe("—");
  });

  it("主要な旅客機の型式が表にある", () => {
    const required = [
      "A20N", "A21N", "A320", "A321", "A332", "A333", "A359", "A35K", "A388",
      "B737", "B738", "B739", "B38M", "B39M", "B744", "B748", "B752", "B763", "B772", "B773", "B77W", "B788", "B789", "B78X",
      "E170", "E175", "E190", "E195", "AT76", "DH8D",
    ];
    expect(required.filter((code) => !Object.hasOwn(TYPE_NAMES, code))).toEqual([]);
  });

  it("Object のプロトタイプのキーを表示名にしない", () => {
    expect(typeDisplayName("constructor")).toBe("constructor");
    expect(typeDisplayName("toString")).toBe("toString");
  });
});

// 並び替えの入力。値は並び替えに使う項目だけを与える。
// callsign は buildRows と同じく前後の空白を除いて行に持たせる。flightCallsign を与えると元の Flight の callsign だけを変える
function sortRow(p: {
  hex: string;
  distanceKm?: number;
  elevationDeg?: number;
  altitudeM?: number;
  callsign?: string;
  flightCallsign?: string;
}): FlightRow {
  const callsign = nonEmpty(p.callsign);
  return {
    hex: p.hex,
    flight: makeFlight({ hex: p.hex, callsign: p.flightCallsign ?? p.callsign }),
    callsign,
    callsignText: callsign ?? p.hex,
    airlineText: "—",
    typeText: "—",
    altitudeM: p.altitudeM,
    altitudeText: "—",
    speedText: "—",
    distanceKm: p.distanceKm ?? Number.NaN,
    distanceText: "—",
    bearingText: "—",
    elevationDeg: p.elevationDeg,
    elevationText: "—",
    isCargo: false,
  };
}

const hexes = (rows: FlightRow[]) => rows.map((row) => row.hex);

describe("sortRows", () => {
  it("近い順（distance）: 距離の昇順、同値は hex 順、距離の無い行は末尾", () => {
    const rows = [
      sortRow({ hex: "d05", distanceKm: 5 }),
      sortRow({ hex: "z-nan" }),
      sortRow({ hex: "b02", distanceKm: 2 }),
      sortRow({ hex: "c05", distanceKm: 5 }),
      sortRow({ hex: "a-nan" }),
      sortRow({ hex: "e01", distanceKm: 1 }),
    ];
    expect(hexes(sortRows(rows, "distance"))).toEqual(["e01", "b02", "c05", "d05", "a-nan", "z-nan"]);
  });

  it("仰角が高い順（elevation）: 降順、同値は hex 順、仰角の無い行は末尾（負の仰角は値あり）", () => {
    const rows = [
      sortRow({ hex: "x5", elevationDeg: 5 }),
      sortRow({ hex: "y-none" }),
      sortRow({ hex: "z30", elevationDeg: 30 }),
      sortRow({ hex: "w5", elevationDeg: 5 }),
      sortRow({ hex: "v-2", elevationDeg: -2 }),
      sortRow({ hex: "a-none" }),
    ];
    expect(hexes(sortRows(rows, "elevation"))).toEqual(["z30", "w5", "x5", "v-2", "a-none", "y-none"]);
  });

  it("高度順（altitude）: 低い順、0m は先頭（値の無い扱いにしない）、同値は hex 順、高度の無い行は末尾", () => {
    const rows = [
      sortRow({ hex: "h9000", altitudeM: 9000 }),
      sortRow({ hex: "h-none" }),
      sortRow({ hex: "h0", altitudeM: 0 }),
      sortRow({ hex: "g300", altitudeM: 300 }),
      sortRow({ hex: "f300", altitudeM: 300 }),
    ];
    expect(hexes(sortRows(rows, "altitude"))).toEqual(["h0", "f300", "g300", "h9000", "h-none"]);
  });

  it("便名順（callsign）: コールサインの昇順、同値は hex 順、コールサインの無い（空白だけを含む）行は末尾", () => {
    const rows = [
      sortRow({ hex: "03", callsign: "JAL123" }),
      sortRow({ hex: "05" }),
      sortRow({ hex: "02", callsign: "ANA5" }),
      sortRow({ hex: "01", callsign: "JAL123" }),
      sortRow({ hex: "04", callsign: " " }),
      sortRow({ hex: "06", callsign: "ADO31" }),
    ];
    expect(hexes(sortRows(rows, "callsign"))).toEqual(["06", "02", "01", "03", "04", "05"]);
  });

  it("便名順（callsign）は行の callsign を見る（元の flight.callsign と食い違っても行の値で並ぶ）", () => {
    const rows = [
      sortRow({ hex: "01", callsign: "ZZZ9", flightCallsign: "AAA1" }),
      sortRow({ hex: "02", callsign: "AAA1", flightCallsign: "ZZZ9" }),
      sortRow({ hex: "03", flightCallsign: "BBB2" }), // 行に callsign が無い → 末尾
      sortRow({ hex: "04", callsign: "MMM5" }),
    ];
    expect(hexes(sortRows(rows, "callsign"))).toEqual(["02", "04", "01", "03"]);
  });

  it("buildRows の結果を便名順に並べる（前後の空白は除いて比べ、空白だけのコールサインは末尾）", () => {
    const flights = [
      makeFlight({ hex: "x1", callsign: "  " }),
      makeFlight({ hex: "x2", callsign: " JAL1" }),
      makeFlight({ hex: "x3", callsign: "ANA2 " }),
    ];
    expect(hexes(sortRows(buildRows(flights, NAGAREYAMA), "callsign"))).toEqual(["x3", "x2", "x1"]);
  });

  it.each(["distance", "elevation", "altitude", "callsign"] as const)("%s: 新しい配列を返し、入力配列を書き換えない", (mode) => {
    const rows = [
      sortRow({ hex: "c", distanceKm: 3, elevationDeg: 1, altitudeM: 3, callsign: "C" }),
      sortRow({ hex: "a", distanceKm: 1, elevationDeg: 3, altitudeM: 1, callsign: "A" }),
      sortRow({ hex: "b", distanceKm: 2, elevationDeg: 2, altitudeM: 2, callsign: "B" }),
    ];
    const before = [...rows];
    const sorted = sortRows(rows, mode);
    expect(sorted).not.toBe(rows);
    expect(rows).toEqual(before);
    expect(hexes(rows)).toEqual(["c", "a", "b"]);
    expect(sorted).toHaveLength(3);
  });

  it("buildRows の結果を近い順に並べる", () => {
    const far = makeFlight({ hex: "far" }); // RJTT 上空（約 37.8km）
    const near = flightAtElevation("near", NAGAREYAMA, 20, 5); // 真北 5km
    expect(hexes(sortRows(buildRows([far, near], NAGAREYAMA), "distance"))).toEqual(["near", "far"]);
  });
});

describe("summaryText（AC-B5・AC-B9、計画 M3-1）", () => {
  const updatedAt = "2026-09-15T09:00:00.000Z";
  const t0 = Date.parse(updatedAt);

  it("成功: 「周辺 N 機・X 秒前に更新」（X は updatedAt からの経過秒、切り捨て）", () => {
    expect(summaryText({ count: 12, updatedAt, now: t0 + 3999, failed: false })).toBe("周辺 12 機・3 秒前に更新");
  });

  it("失敗・データあり: 「更新できません（X 秒前のデータ）」", () => {
    expect(summaryText({ count: 12, updatedAt, now: t0 + 25_500, failed: true })).toBe("更新できません（25 秒前のデータ）");
  });

  it("失敗・データ無し: 「更新できません」（秒数なし）", () => {
    expect(summaryText({ count: 0, now: t0, failed: true })).toBe("更新できません");
  });

  it("成功・データ無し（初回取得前）: 「取得中…」", () => {
    expect(summaryText({ count: 0, now: t0, failed: false })).toBe("取得中…");
  });

  it("失敗中は失敗の文言で秒数が進み、成功に戻ると通常の文言になる", () => {
    const failing1 = summaryText({ count: 8, updatedAt, now: t0 + 20_000, failed: true });
    const failing2 = summaryText({ count: 8, updatedAt, now: t0 + 30_000, failed: true });
    const newUpdatedAt = "2026-09-15T09:00:35.000Z";
    const recovered = summaryText({ count: 9, updatedAt: newUpdatedAt, now: t0 + 36_000, failed: false });
    expect(failing1).toBe("更新できません（20 秒前のデータ）");
    expect(failing2).toBe("更新できません（30 秒前のデータ）");
    expect(recovered).toBe("周辺 9 機・1 秒前に更新");
    expect(recovered).not.toContain("更新できません");
  });

  it("0 機でも件数を出す", () => {
    expect(summaryText({ count: 0, updatedAt, now: t0, failed: false })).toBe("周辺 0 機・0 秒前に更新");
  });

  it("端末の時計がサーバより遅れていても負の秒数にしない", () => {
    expect(summaryText({ count: 3, updatedAt, now: t0 - 2000, failed: false })).toBe("周辺 3 機・0 秒前に更新");
  });

  it("解釈できない updatedAt はデータ無しとして扱う", () => {
    expect(summaryText({ count: 3, updatedAt: "not-a-date", now: t0, failed: false })).toBe("取得中…");
    expect(summaryText({ count: 3, updatedAt: "not-a-date", now: t0, failed: true })).toBe("更新できません");
  });
});

describe("nextRadius（AC-B7）", () => {
  it.each([
    [10, 25],
    [25, 50],
    [50, 100],
    [30, 50],
    [5, 10],
  ])("%s km → %s km", (radius, expected) => {
    expect(nextRadius(radius)).toBe(expected);
  });

  it.each([100, 150])("%s km → undefined（これ以上広げない）", (radius) => {
    expect(nextRadius(radius)).toBeUndefined();
  });
});

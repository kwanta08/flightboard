import { describe, expect, it } from "vitest";
import type { Airport, AirportOps, Flight, FlightDetailResponse } from "../../shared/types.ts";
import { INITIAL_DETAIL_STATE, reduceDetailState, type DetailEvent, type DetailState } from "./detailState.ts";
import {
  airportLabel,
  buildDetailView,
  DETAIL_ITEM_LABELS,
  DETAIL_SECTION_TITLES,
  DETAIL_ERROR_MESSAGE,
  DETAIL_LOADING_MESSAGE,
  DETAIL_NOT_FOUND_MESSAGE,
  DETAIL_REFRESH_FAILED_MESSAGE,
  detailPanelContent,
  formatHeadingDeg,
  isCloseKey,
  observerRelation,
  progressText,
  ROUTE_NOTE,
  routeProgress,
  type DetailView,
} from "./detailView.ts";
import type { Observer } from "./flightRows.ts";
import type { Units } from "./format.ts";

// 仕様 6.5 の利用地点（流山）
const NAGAREYAMA: Observer = { lat: 35.8709, lon: 139.9256, elevationM: 15 };

const HND: Airport = { icao: "RJTT", iata: "HND", name: "Tokyo Haneda International Airport", municipality: "Tokyo", lat: 35.552299, lon: 139.779999 };
const FUK: Airport = { icao: "RJFF", iata: "FUK", name: "Fukuoka Airport", municipality: "Fukuoka", lat: 33.585899, lon: 130.451004 };

function makeFlight(overrides: Partial<Flight> & { hex: string }): Flight {
  return {
    position: { lat: 35.552299, lon: 139.779999, altitudeBaroFt: null, onGround: false },
    isMlat: false,
    seenPosSec: 0,
    kind: "passenger",
    source: "adsblol",
    ...overrides,
  };
}

function makeDetail(flight: Flight): FlightDetailResponse {
  return { updatedAt: "2026-09-15T00:00:00.000Z", flight, track: [] };
}

// 全項目が揃った詳細。位置は RJTT（出発地）の上空、GNSS 高度 3000ft
const FULL_FLIGHT: Flight = makeFlight({
  hex: "86e7a0",
  callsign: "ANA245",
  registration: "JA873A",
  typeCode: "B788",
  position: { lat: 35.552299, lon: 139.779999, altitudeBaroFt: 2900, altitudeGeomFt: 3000, onGround: false },
  groundSpeedKt: 250,
  trackDeg: 123,
  verticalRateFpm: 1000,
  targetAltitudeFt: 5000,
  squawk: "2071",
  airline: { icao: "ANA", iata: "NH", name: "All Nippon Airways" },
  route: { origin: HND, destination: FUK, source: "adsbdb" },
  aircraft: {
    model: "Boeing 787-8",
    photo: {
      url: "https://image.example.test/full/1.jpg",
      thumbnailUrl: "https://image.example.test/thumb/1.jpg",
      credit: "Taro Yamada",
      link: "https://www.planespotters.net/photo/1",
    },
  },
});

function valueOf(view: DetailView, sectionTitle: string, label: string): string {
  const item = view.sections.find((section) => section.title === sectionTitle)?.items.find((entry) => entry.label === label);
  if (item === undefined) {
    throw new Error(`項目が無い: ${sectionTitle} / ${label}`);
  }
  return item.value;
}

describe("文言", () => {
  it("404 の案内は AC-B12 の文と一字一句同じ", () => {
    expect(DETAIL_NOT_FOUND_MESSAGE).toBe("この機体の情報を取得できません（範囲外に出た可能性があります）");
  });

  it("ルートの注記は「ルートは adsbdb による推定です」", () => {
    expect(ROUTE_NOTE).toBe("ルートは adsbdb による推定です");
  });
});

describe("buildDetailView: 区分と項目（F-05 の Phase 1 分）", () => {
  const view = buildDetailView(makeDetail(FULL_FLIGHT), NAGAREYAMA);

  it("区分は フライト / 機体 / 飛行状態 / 自分との関係 の順", () => {
    expect(view.sections.map((section) => section.title)).toEqual(["フライト", "機体", "飛行状態", "自分との関係"]);
  });

  it("各区分の項目名", () => {
    expect(view.sections.map((section) => section.items.map((item) => item.label))).toEqual([
      ["便名", "航空会社", "出発地", "到着地", "ルートの信頼度"],
      ["機種名", "登録記号", "ICAO 24bit アドレス"],
      ["気圧高度", "GNSS 高度", "対地速度", "進行方向", "昇降率", "目標高度", "スコーク"],
      ["水平距離", "直線距離", "方角", "仰角"],
    ]);
  });
});

describe("buildDetailView: 全項目が揃った詳細の値", () => {
  const view = buildDetailView(makeDetail(FULL_FLIGHT), NAGAREYAMA);

  it("見出しは便名、副見出しは航空会社名", () => {
    expect(view.title).toBe("ANA245");
    expect(view.subtitle).toBe("All Nippon Airways");
  });

  it("フライト: 便名・航空会社・出発地・到着地・ルートの信頼度", () => {
    expect(valueOf(view, "フライト", "便名")).toBe("ANA245");
    expect(valueOf(view, "フライト", "航空会社")).toBe("All Nippon Airways");
    expect(valueOf(view, "フライト", "出発地")).toBe("HND Tokyo Haneda International Airport（Tokyo）");
    expect(valueOf(view, "フライト", "到着地")).toBe("FUK Fukuoka Airport（Fukuoka）");
    expect(valueOf(view, "フライト", "ルートの信頼度")).toBe("adsbdb による推定");
  });

  it("機体: 機種名は aircraft.model、登録記号、ICAO 24bit アドレスは大文字", () => {
    expect(valueOf(view, "機体", "機種名")).toBe("Boeing 787-8");
    expect(valueOf(view, "機体", "登録記号")).toBe("JA873A");
    expect(valueOf(view, "機体", "ICAO 24bit アドレス")).toBe("86E7A0");
  });

  it("飛行状態: 単位は m・km/h・m/分", () => {
    // 2900 × 0.3048 = 883.92 → 880、3000 × 0.3048 = 914.4 → 910、5000 × 0.3048 = 1524 → 1,520
    expect(valueOf(view, "飛行状態", "気圧高度")).toBe("880m");
    expect(valueOf(view, "飛行状態", "GNSS 高度")).toBe("910m");
    // 250 × 1.852 = 463
    expect(valueOf(view, "飛行状態", "対地速度")).toBe("463km/h");
    // 123° は [112.5, 135) → 東南東
    expect(valueOf(view, "飛行状態", "進行方向")).toBe("123°（東南東）");
    // 1000 × 0.3048 = 304.8 → +305
    expect(valueOf(view, "飛行状態", "昇降率")).toBe("+305m/分");
    expect(valueOf(view, "飛行状態", "目標高度")).toBe("1,520m");
    expect(valueOf(view, "飛行状態", "スコーク")).toBe("2071");
  });

  it("自分との関係: 流山から RJTT 上空 3000ft の機体（水平 約 37.8km・南南西・仰角 約 1.19°）", () => {
    expect(valueOf(view, "自分との関係", "水平距離")).toBe("38km");
    // √(37.79² + 0.8994²) ≈ 37.80 → 38km
    expect(valueOf(view, "自分との関係", "直線距離")).toBe("38km");
    expect(valueOf(view, "自分との関係", "方角")).toBe("南南西");
    // atan((914.4 − 15)/37,790 − 37.79/(2 × 6371)) ≈ 1.19° → 0.1° 単位の切り捨てで 1.1°
    expect(valueOf(view, "自分との関係", "仰角")).toBe("1.1°");
  });

  it("写真: url を優先、alt は「<便名> の機体写真」、クレジットは「写真: <撮影者名>」と写真ページのリンク", () => {
    expect(view.photo).toEqual({
      src: "https://image.example.test/full/1.jpg",
      alt: "ANA245 の機体写真",
      credit: "写真: Taro Yamada",
      link: "https://www.planespotters.net/photo/1",
    });
  });

  it("ルート: 出発地 → 到着地の表示と注記。機体が出発地の上にいるので進み具合 0（約 0%）", () => {
    expect(view.route).toEqual({
      originLabel: "HND Tokyo Haneda International Airport（Tokyo）",
      destinationLabel: "FUK Fukuoka Airport（Fukuoka）",
      progress: 0,
      progressText: "約 0%",
      note: "ルートは adsbdb による推定です",
    });
  });

  it("単位を渡さなければ m・km/h（ft・kt・fpm を出さない）", () => {
    const values = view.sections.flatMap((section) => section.items.map((item) => item.value));
    for (const value of values) {
      expect(value).not.toMatch(/ft|kt|fpm/);
    }
  });
});

describe("buildDetailView: 表示の単位（F-09・AC-P2-72）", () => {
  const FEET_AND_KNOTS: Units = { altitude: "ft", speed: "kt" };
  // FULL_FLIGHT: 気圧高度 2900ft・GNSS 高度 3000ft・目標高度 5000ft・対地速度 250kt・昇降率 +1000fpm
  const view = buildDetailView(makeDetail(FULL_FLIGHT), NAGAREYAMA, undefined, FEET_AND_KNOTS);

  it("飛行状態の高度は ft（換算せず、10ft 単位に丸めて桁区切り）", () => {
    expect(valueOf(view, "飛行状態", "気圧高度")).toBe("2,900ft");
    expect(valueOf(view, "飛行状態", "GNSS 高度")).toBe("3,000ft");
    expect(valueOf(view, "飛行状態", "目標高度")).toBe("5,000ft");
  });

  it("25ft 刻みの受信値も ft のまま丸める（875ft → 880ft。W7 コードレビュー MAJOR-1）", () => {
    // ADS-B の高度は 25ft 刻みで届く。m を経由して丸めると 870ft になり一覧と食い違う
    // （一覧・推定バッジとの一致は flightRows.test.ts が突き合わせる）
    const quarter = makeFlight({
      hex: "86e7a0",
      position: { lat: 35.552299, lon: 139.779999, altitudeBaroFt: 225, altitudeGeomFt: 875, onGround: false },
    });
    const quarterView = buildDetailView(makeDetail(quarter), NAGAREYAMA, undefined, FEET_AND_KNOTS);
    expect(valueOf(quarterView, "飛行状態", "GNSS 高度")).toBe("880ft");
    expect(valueOf(quarterView, "飛行状態", "気圧高度")).toBe("230ft");
  });

  it("対地速度は kt", () => {
    expect(valueOf(view, "飛行状態", "対地速度")).toBe("250kt");
  });

  it("昇降率は m/分 のまま（仕様 Q15。切り替えるのは高度と対地速度だけ）", () => {
    expect(valueOf(view, "飛行状態", "昇降率")).toBe("+305m/分");
  });

  it("自分との関係の距離は km のまま", () => {
    expect(valueOf(view, "自分との関係", "水平距離")).toBe("38km");
    expect(valueOf(view, "自分との関係", "直線距離")).toBe("38km");
  });

  it("高度だけ ft にしても対地速度は km/h のまま（項目ごとに独立している）", () => {
    const altitudeOnly = buildDetailView(makeDetail(FULL_FLIGHT), NAGAREYAMA, undefined, { altitude: "ft", speed: "kmh" });
    expect(valueOf(altitudeOnly, "飛行状態", "GNSS 高度")).toBe("3,000ft");
    expect(valueOf(altitudeOnly, "飛行状態", "対地速度")).toBe("463km/h");
  });

  it("値の無い項目は単位に関わらず「—」", () => {
    const empty = buildDetailView(makeDetail(makeFlight({ hex: "86e7a0" })), NAGAREYAMA, undefined, FEET_AND_KNOTS);
    expect(valueOf(empty, "飛行状態", "気圧高度")).toBe("—");
    expect(valueOf(empty, "飛行状態", "対地速度")).toBe("—");
  });
});

describe("buildDetailView: 値の無い項目は「—」", () => {
  const view = buildDetailView(makeDetail(makeFlight({ hex: "86e7a0" })), NAGAREYAMA);

  it("見出しは hex、副見出しは無し（航空会社名が無い。「—」だけの副見出しを出さない）", () => {
    expect(view.title).toBe("86e7a0");
    expect(view.subtitle).toBeUndefined();
  });

  it("写真・ルートが無い", () => {
    expect(view.photo).toBeUndefined();
    expect(view.route).toBeUndefined();
  });

  it("フライト・機体・飛行状態の欠損は「—」（ICAO アドレスは hex から出す）", () => {
    expect(valueOf(view, "フライト", "便名")).toBe("—");
    expect(valueOf(view, "フライト", "航空会社")).toBe("—");
    expect(valueOf(view, "フライト", "出発地")).toBe("—");
    expect(valueOf(view, "フライト", "到着地")).toBe("—");
    expect(valueOf(view, "フライト", "ルートの信頼度")).toBe("—");
    expect(valueOf(view, "機体", "機種名")).toBe("—");
    expect(valueOf(view, "機体", "登録記号")).toBe("—");
    expect(valueOf(view, "機体", "ICAO 24bit アドレス")).toBe("86E7A0");
    expect(valueOf(view, "飛行状態", "気圧高度")).toBe("—");
    expect(valueOf(view, "飛行状態", "GNSS 高度")).toBe("—");
    expect(valueOf(view, "飛行状態", "対地速度")).toBe("—");
    expect(valueOf(view, "飛行状態", "進行方向")).toBe("—");
    expect(valueOf(view, "飛行状態", "昇降率")).toBe("—");
    expect(valueOf(view, "飛行状態", "目標高度")).toBe("—");
    expect(valueOf(view, "飛行状態", "スコーク")).toBe("—");
  });

  it("高度が無ければ直線距離・仰角は「—」、水平距離・方角は出す", () => {
    expect(valueOf(view, "自分との関係", "水平距離")).toBe("38km");
    expect(valueOf(view, "自分との関係", "方角")).toBe("南南西");
    expect(valueOf(view, "自分との関係", "直線距離")).toBe("—");
    expect(valueOf(view, "自分との関係", "仰角")).toBe("—");
  });

  it("空白だけの文字列も値が無いものとして「—」", () => {
    const blank = buildDetailView(
      makeDetail(makeFlight({ hex: "86e7a0", callsign: "  ", registration: " ", squawk: "", airline: { icao: "XXX", name: " " } })),
      NAGAREYAMA,
    );
    expect(blank.title).toBe("86e7a0");
    expect(blank.subtitle).toBeUndefined();
    expect(valueOf(blank, "フライト", "便名")).toBe("—");
    expect(valueOf(blank, "機体", "登録記号")).toBe("—");
    expect(valueOf(blank, "飛行状態", "スコーク")).toBe("—");
  });
});

describe("buildDetailView: 機種名", () => {
  it("aircraft.model が無ければ typeCode の表示名（B763 → B767-300）", () => {
    const view = buildDetailView(makeDetail(makeFlight({ hex: "86e7a0", typeCode: "B763", aircraft: {} })), NAGAREYAMA);
    expect(valueOf(view, "機体", "機種名")).toBe("B767-300");
  });

  it("表示名の表に無い typeCode はそのまま", () => {
    const view = buildDetailView(makeDetail(makeFlight({ hex: "86e7a0", typeCode: "C172" })), NAGAREYAMA);
    expect(valueOf(view, "機体", "機種名")).toBe("C172");
  });

  it("aircraft.model が空白だけなら typeCode の表示名", () => {
    const view = buildDetailView(makeDetail(makeFlight({ hex: "86e7a0", typeCode: "B788", aircraft: { model: " " } })), NAGAREYAMA);
    expect(valueOf(view, "機体", "機種名")).toBe("B787-8");
  });
});

describe("buildDetailView: 写真", () => {
  const LINK = "https://www.planespotters.net/photo/1";
  type Photo = NonNullable<NonNullable<Flight["aircraft"]>["photo"]>;

  // 上流が欠けた値を返した場合も試すので、部分的な写真を受け取れるようにする
  function photoOf(photo: Partial<Photo> | undefined, callsign?: string) {
    const aircraft = { photo: photo as Photo | undefined };
    return buildDetailView(makeDetail(makeFlight({ hex: "86e7a0", callsign, aircraft })), NAGAREYAMA).photo;
  }

  it("写真が無ければ photo 無し", () => {
    expect(photoOf(undefined, "ANA245")).toBeUndefined();
  });

  it("url が使えなければ thumbnailUrl", () => {
    const photo = { url: "javascript:alert(1)", thumbnailUrl: "https://image.example.test/thumb/2.jpg", credit: "Hanako", link: LINK };
    expect(photoOf(photo, "ANA245")?.src).toBe("https://image.example.test/thumb/2.jpg");
  });

  it("撮影者名が無ければ写真を出さない（仕様 §13）", () => {
    expect(photoOf({ url: "https://image.example.test/full/2.jpg", link: LINK }, "ANA245")).toBeUndefined();
    expect(photoOf({ url: "https://image.example.test/full/2.jpg", credit: "  ", link: LINK }, "ANA245")).toBeUndefined();
  });

  it("写真ページのリンクが無ければ写真を出さない（提供元の規約）", () => {
    expect(photoOf({ url: "https://image.example.test/full/2.jpg", credit: "Hanako" }, "ANA245")).toBeUndefined();
  });

  it("便名が無ければ alt は hex で「86e7a0 の機体写真」", () => {
    expect(photoOf({ url: "https://image.example.test/full/2.jpg", credit: "Hanako", link: LINK })?.alt).toBe("86e7a0 の機体写真");
  });

  it("http・https 以外の URL は使わない（画像もリンクも）", () => {
    expect(photoOf({ url: "javascript:alert(1)", credit: "Hanako", link: LINK }, "ANA245")).toBeUndefined();
    expect(photoOf({ url: "not a url", credit: "Hanako", link: LINK }, "ANA245")).toBeUndefined();
    const badLink = { url: "https://image.example.test/full/2.jpg", credit: "Hanako", link: "javascript:alert(1)" };
    expect(photoOf(badLink, "ANA245")).toBeUndefined();
  });
});

describe("buildDetailView: ルートと進み具合", () => {
  function routeOf(route: NonNullable<Flight["route"]>, position: { lat: number; lon: number }) {
    const flight = makeFlight({ hex: "86e7a0", route, position: { ...position, altitudeBaroFt: 3000, onGround: false } });
    return buildDetailView(makeDetail(flight), NAGAREYAMA).route;
  }

  it("出発地の座標が無ければ progress・progressText 無し（出発地 → 到着地と注記は出す）", () => {
    const { lat: _lat, lon: _lon, ...hndWithoutCoords } = HND;
    const route = routeOf({ origin: hndWithoutCoords, destination: FUK, source: "adsbdb" }, { lat: 35.0, lon: 138.0 });
    expect(route).toEqual({
      originLabel: "HND Tokyo Haneda International Airport（Tokyo）",
      destinationLabel: "FUK Fukuoka Airport（Fukuoka）",
      note: "ルートは adsbdb による推定です",
    });
    expect(route?.progress).toBeUndefined();
    expect(route?.progressText).toBeUndefined();
  });

  it("到着地の経度だけが無くても progress 無し", () => {
    const { lon: _lon, ...fukWithoutLon } = FUK;
    expect(routeOf({ origin: HND, destination: fukWithoutLon, source: "adsbdb" }, { lat: 35.0, lon: 138.0 })?.progress).toBeUndefined();
  });

  it("到着地の上では 1（約 100%）", () => {
    const route = routeOf({ origin: HND, destination: FUK, source: "adsbdb" }, { lat: 33.585899, lon: 130.451004 });
    expect(route?.progress).toBe(1);
    expect(route?.progressText).toBe("約 100%");
  });

  it("赤道上の出発地 (0, 0)・到着地 (0, 3) で、経度 1 の機体は 1/3（約 33%）、経度 2 の機体は 2/3（約 67%）", () => {
    // 赤道上の 2 点の距離は R × 経度差（ラジアン）なので、比は 1 : 2・2 : 1
    const origin: Airport = { icao: "XAAA", name: "Origin", lat: 0, lon: 0 };
    const destination: Airport = { icao: "XBBB", name: "Destination", lat: 0, lon: 3 };
    const oneThird = routeOf({ origin, destination, source: "adsbdb" }, { lat: 0, lon: 1 });
    expect(oneThird?.progress).toBeCloseTo(1 / 3, 10);
    expect(oneThird?.progressText).toBe("約 33%");
    const twoThirds = routeOf({ origin, destination, source: "adsbdb" }, { lat: 0, lon: 2 });
    expect(twoThirds?.progress).toBeCloseTo(2 / 3, 10);
    expect(twoThirds?.progressText).toBe("約 67%");
  });

  it("IATA の無い空港は ICAO で表示する", () => {
    const chofu: Airport = { icao: "RJTF", name: "Chofu Airport", municipality: "Chofu" };
    const route = routeOf({ origin: chofu, destination: HND, source: "adsbdb" }, { lat: 35.6, lon: 139.6 });
    expect(route?.originLabel).toBe("RJTF Chofu Airport（Chofu）");
  });
});

describe("routeProgress / progressText", () => {
  it("出発地・到着地・現在位置がすべて同じ点では比が求まらないので undefined", () => {
    expect(routeProgress({ lat: 0, lon: 0 }, { lat: 0, lon: 0 }, { lat: 0, lon: 0 })).toBeUndefined();
  });

  it("出発地 (0, 0)・到着地 (0, 4)、経度 1 の機体は 1/4（R × 1° ÷ (R × 1° + R × 3°)）", () => {
    expect(routeProgress({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 0, lon: 4 })).toBeCloseTo(0.25, 10);
  });

  it("「約 N%」の N は整数に丸める（0.004 → 0、0.005 → 1、0.994 → 99、0.996 → 100）", () => {
    expect(progressText(0.004)).toBe("約 0%");
    expect(progressText(0.005)).toBe("約 1%");
    expect(progressText(0.994)).toBe("約 99%");
    expect(progressText(0.996)).toBe("約 100%");
  });
});

describe("airportLabel", () => {
  it("IATA ＋空港名＋都市名", () => {
    expect(airportLabel(HND)).toBe("HND Tokyo Haneda International Airport（Tokyo）");
  });

  it("IATA が無ければ ICAO", () => {
    expect(airportLabel({ icao: "RJTF", name: "Chofu Airport", municipality: "Chofu" })).toBe("RJTF Chofu Airport（Chofu）");
  });

  it("都市名が無ければ括弧を付けない", () => {
    expect(airportLabel({ icao: "RJTT", iata: "HND", name: "Tokyo Haneda International Airport" })).toBe(
      "HND Tokyo Haneda International Airport",
    );
  });

  it("空港名が空ならコードと都市名", () => {
    expect(airportLabel({ icao: "RJTT", iata: " ", name: "", municipality: "Tokyo" })).toBe("RJTT（Tokyo）");
  });
});

describe("formatHeadingDeg: 進行方向", () => {
  it.each([
    [123, "123°（東南東）"],
    [0, "0°（北）"],
    [11.4, "11°（北）"], // 丸めた 11° から 16 方位を求める（11.25° 未満は北）
    [11.6, "12°（北北東）"],
    [359.6, "0°（北）"], // 360 に丸まるので 0°
    [270, "270°（西）"],
  ])("%s → %s", (deg, expected) => {
    expect(formatHeadingDeg(deg)).toBe(expected);
  });

  it.each([undefined, null, Number.NaN])("%s → 「—」", (value) => {
    expect(formatHeadingDeg(value)).toBe("—");
  });
});

describe("observerRelation: 水平距離と直線距離（§11）", () => {
  it("流山（標高 15m）から RJTT 上空 3000ft の機体: 水平 37.8±0.3km、直線 = √(d² + (914.4 − 15)²/1e6)", () => {
    const relation = observerRelation(
      { lat: 35.552299, lon: 139.779999, altitudeBaroFt: 3000, onGround: false },
      NAGAREYAMA,
    );
    expect(Math.abs(relation.horizontalKm - 37.8)).toBeLessThanOrEqual(0.3);
    const d = relation.horizontalKm;
    expect(relation.slantKm).toBeCloseTo(Math.sqrt(d * d + (914.4 - 15) ** 2 / 1e6), 9);
    // 手計算: 0.8994² / (2 × 37.79) ≈ 0.0107km だけ直線距離が長い
    expect((relation.slantKm as number) - d).toBeCloseTo(0.0107, 3);
    expect(relation.elevationDeg).toBeCloseTo(1.19, 1);
  });

  it("真北 20km・GNSS 高度 30000ft の機体: 水平「20km」、直線 √(20² + 9.129²) ≈ 21.98 →「22km」、仰角 約 24.5° →「24°」", () => {
    // 同じ経度で緯度を 20/6371 ラジアン北へ → haversine の距離は 20km
    const lat = NAGAREYAMA.lat + (20 / 6371) * (180 / Math.PI);
    const flight = makeFlight({
      hex: "86e7a0",
      position: { lat, lon: NAGAREYAMA.lon, altitudeBaroFt: 29000, altitudeGeomFt: 30000, onGround: false },
    });
    const relation = observerRelation(flight.position, NAGAREYAMA);
    expect(relation.horizontalKm).toBeCloseTo(20, 6);
    // (9144 − 15) = 9129m → √(400 + 83.3386) = 21.98496
    expect(relation.slantKm).toBeCloseTo(21.98496, 4);
    const view = buildDetailView(makeDetail(flight), NAGAREYAMA);
    expect(valueOf(view, "自分との関係", "水平距離")).toBe("20km");
    expect(valueOf(view, "自分との関係", "直線距離")).toBe("22km");
    expect(valueOf(view, "自分との関係", "方角")).toBe("北");
    // atan(9129/20000 − 20000/(2 × 6371000)) = atan(0.45488) ≈ 24.46°
    expect(valueOf(view, "自分との関係", "仰角")).toBe("24°");
  });

  it("高度が無ければ slantKm・elevationDeg 無し", () => {
    const relation = observerRelation({ lat: 35.552299, lon: 139.779999, altitudeBaroFt: null, onGround: false }, NAGAREYAMA);
    expect(relation.slantKm).toBeUndefined();
    expect(relation.elevationDeg).toBeUndefined();
  });
});

describe("detailPanelContent: パネルの中身", () => {
  const detail = makeDetail(FULL_FLIGHT);

  it("取得中（詳細なし）は見出し「機体の詳細」と「詳細を取得しています…」", () => {
    const content = detailPanelContent({ hex: "86e7a0", status: "loading" }, NAGAREYAMA);
    expect(content).toEqual({ title: "機体の詳細", message: DETAIL_LOADING_MESSAGE });
    expect(DETAIL_LOADING_MESSAGE).toBe("詳細を取得しています…");
  });

  it("404 は AC-B12 の案内", () => {
    const content = detailPanelContent({ hex: "86e7a0", status: "not-found" }, NAGAREYAMA);
    expect(content.message).toBe("この機体の情報を取得できません（範囲外に出た可能性があります）");
    expect(content.view).toBeUndefined();
  });

  it("詳細が無いまま失敗は「詳細を取得できませんでした」", () => {
    const content = detailPanelContent({ hex: "86e7a0", status: "error" }, NAGAREYAMA);
    expect(content.message).toBe(DETAIL_ERROR_MESSAGE);
    expect(DETAIL_ERROR_MESSAGE).toBe("詳細を取得できませんでした");
  });

  it("取得済みは詳細を出し、見出しは便名・航空会社。案内は無い", () => {
    const content = detailPanelContent({ hex: "86e7a0", status: "loaded", detail }, NAGAREYAMA);
    expect(content.title).toBe("ANA245");
    expect(content.subtitle).toBe("All Nippon Airways");
    expect(content.view).toEqual(buildDetailView(detail, NAGAREYAMA));
    expect(content.message).toBeUndefined();
    expect(content.notice).toBeUndefined();
  });

  it("取り直し中は詳細を出したまま何も添えない（ちらつかない）", () => {
    const content = detailPanelContent({ hex: "86e7a0", status: "loading", detail }, NAGAREYAMA);
    expect(content.view).toBeDefined();
    expect(content.message).toBeUndefined();
    expect(content.notice).toBeUndefined();
  });

  it("取り直しに失敗したら詳細を出したまま notice を添える", () => {
    const state: DetailState = { hex: "86e7a0", status: "error", detail };
    const content = detailPanelContent(state, NAGAREYAMA);
    expect(content.view).toBeDefined();
    expect(content.notice).toBe(DETAIL_REFRESH_FAILED_MESSAGE);
    expect(content.message).toBeUndefined();
  });
});

describe("detailPanelContent: 取り直し中は最後の結果を出す（W7 コードレビュー MINOR-1）", () => {
  const HEX = "86e7a0";
  const detail = makeDetail(FULL_FLIGHT);
  const SELECT: DetailEvent = { type: "select", hex: HEX };
  const REQUEST: DetailEvent = { type: "request" };

  function run(...events: DetailEvent[]): DetailState {
    return events.reduce((state, event) => reduceDetailState(state, event), INITIAL_DETAIL_STATE);
  }

  it("404 の後の取り直し中も 404 の案内のまま（「詳細を取得しています…」に戻らない）", () => {
    const content = detailPanelContent(run(SELECT, REQUEST, { type: "not-found", hex: HEX }, REQUEST), NAGAREYAMA);
    expect(content).toEqual({ title: "機体の詳細", message: DETAIL_NOT_FOUND_MESSAGE });
  });

  it("その取り直しが成功すると詳細", () => {
    const content = detailPanelContent(
      run(SELECT, REQUEST, { type: "not-found", hex: HEX }, REQUEST, { type: "success", hex: HEX, detail }),
      NAGAREYAMA,
    );
    expect(content.view).toEqual(buildDetailView(detail, NAGAREYAMA));
    expect(content.message).toBeUndefined();
    expect(content.notice).toBeUndefined();
  });

  it("失敗の後の取り直し中も失敗の案内のまま", () => {
    const content = detailPanelContent(run(SELECT, REQUEST, { type: "failure", hex: HEX }, REQUEST), NAGAREYAMA);
    expect(content).toEqual({ title: "機体の詳細", message: DETAIL_ERROR_MESSAGE });
  });

  it("詳細の後の取り直し中は詳細のまま（何も添えない）", () => {
    const content = detailPanelContent(run(SELECT, REQUEST, { type: "success", hex: HEX, detail }, REQUEST), NAGAREYAMA);
    expect(content.view).toEqual(buildDetailView(detail, NAGAREYAMA));
    expect(content.message).toBeUndefined();
    expect(content.notice).toBeUndefined();
  });

  it("取り直しに失敗した詳細をもう一度取り直している間も、詳細と notice を出したまま", () => {
    const content = detailPanelContent(
      run(SELECT, REQUEST, { type: "success", hex: HEX, detail }, REQUEST, { type: "failure", hex: HEX }, REQUEST),
      NAGAREYAMA,
    );
    expect(content.view).toEqual(buildDetailView(detail, NAGAREYAMA));
    expect(content.notice).toBe(DETAIL_REFRESH_FAILED_MESSAGE);
    expect(content.message).toBeUndefined();
  });

  it("選択を変えた直後は取得中（前の機体の 404 の案内を出さない）", () => {
    const content = detailPanelContent(
      run(SELECT, REQUEST, { type: "not-found", hex: HEX }, REQUEST, { type: "select", hex: "84c1b2" }, REQUEST),
      NAGAREYAMA,
    );
    expect(content).toEqual({ title: "機体の詳細", message: DETAIL_LOADING_MESSAGE });
  });
});

describe("detailPanelContent: 副見出し（W7 コードレビュー MINOR-7）", () => {
  it("航空会社名が無い詳細では副見出しを持たない（見出しは hex）", () => {
    const content = detailPanelContent(
      { hex: "86e7a0", status: "loaded", detail: makeDetail(makeFlight({ hex: "86e7a0" })) },
      NAGAREYAMA,
    );
    expect(content.title).toBe("86e7a0");
    expect("subtitle" in content).toBe(false);
    expect(content.view).toBeDefined();
  });
});

describe("isCloseKey: パネル内の Esc", () => {
  it("Escape で閉じる。他のキーでは閉じない", () => {
    expect(isCloseKey("Escape")).toBe(true);
    expect(isCloseKey("Enter")).toBe(false);
    expect(isCloseKey("ArrowDown")).toBe(false);
  });
});

describe("buildDetailView: 「経路」の区分（AC-P2-53・F-05・S-03）", () => {
  const AIRPORT_OPS: AirportOps[] = [
    { icao: "RJTT", landingRunways: ["22", "23"], departingRunways: ["16L"], configLabel: "南風運用", basedOn: 6, updatedAt: "2026-09-16T00:00:00.000Z" },
  ];
  const EVIDENCE = ["方位のズレ 0.3°", "滑走路まで 10.7km", "降下中 −704fpm"];
  const ESTIMATED_FLIGHT = makeFlight({
    hex: "86e7a0",
    callsign: "JAL38",
    estimate: { phase: "arrival", airport: { icao: "RJTT", name: "羽田" }, runway: "22", confidence: 0.9, evidence: EVIDENCE },
  });

  const view = buildDetailView(makeDetail(ESTIMATED_FLIGHT), NAGAREYAMA, AIRPORT_OPS);

  it("区分の末尾に「経路」が付く（既存の 4 区分の順は変わらない）", () => {
    expect(view.sections.map((section) => section.title)).toEqual(Object.values(DETAIL_SECTION_TITLES));
    expect(view.sections.at(-1)?.title).toBe("経路");
  });

  it("フェーズ・空港・滑走路・運用方向・確度が並ぶ（「一致度」はレベル2 なので出さない）", () => {
    expect(view.sections.at(-1)?.items).toEqual([
      { label: "推定フェーズ", value: "進入" },
      { label: "空港", value: "羽田" },
      { label: "滑走路", value: "RWY22" },
      { label: "運用方向", value: "南風運用" },
      { label: "確度", value: "高" },
    ]);
  });

  it("項目名は F-05 の表（DETAIL_ITEM_LABELS）から出る", () => {
    expect(view.sections.at(-1)?.items.map((item) => item.label)).toEqual([
      DETAIL_ITEM_LABELS.phase,
      DETAIL_ITEM_LABELS.airport,
      DETAIL_ITEM_LABELS.runway,
      DETAIL_ITEM_LABELS.airportConfig,
      DETAIL_ITEM_LABELS.confidence,
    ]);
  });

  it("evidence の各行が根拠として列挙される（S-03「経路推定の根拠を開示する」）", () => {
    expect(view.sections.at(-1)?.notes?.lines).toEqual(EVIDENCE);
  });

  it("推定の無い機体には「経路」の区分を出さない（既存の 4 区分のまま）", () => {
    const plain = buildDetailView(makeDetail(FULL_FLIGHT), NAGAREYAMA, AIRPORT_OPS);
    expect(plain.sections.map((section) => section.title)).toEqual(["フライト", "機体", "飛行状態", "自分との関係"]);
  });

  it("運用方向の集計を渡さなければ「—」（他の項目は出す）", () => {
    const withoutOps = buildDetailView(makeDetail(ESTIMATED_FLIGHT), NAGAREYAMA);
    expect(valueOf(withoutOps, "経路", "運用方向")).toBe("—");
    expect(valueOf(withoutOps, "経路", "滑走路")).toBe("RWY22");
  });
});

describe("detailPanelContent: 表示の単位の受け渡し（AC-P2-72）", () => {
  const FEET_AND_KNOTS: Units = { altitude: "ft", speed: "kt" };
  const detail = makeDetail(FULL_FLIGHT);

  it("渡した単位が詳細に出る（buildDetailView へそのまま通す）", () => {
    const content = detailPanelContent({ hex: "86e7a0", status: "loaded", detail }, NAGAREYAMA, undefined, FEET_AND_KNOTS);
    expect(content.view).toEqual(buildDetailView(detail, NAGAREYAMA, undefined, FEET_AND_KNOTS));
    expect(content.view && valueOf(content.view, "飛行状態", "GNSS 高度")).toBe("3,000ft");
    expect(content.view && valueOf(content.view, "飛行状態", "対地速度")).toBe("250kt");
  });

  it("単位を渡さなければ m・km/h（既定）", () => {
    const content = detailPanelContent({ hex: "86e7a0", status: "loaded", detail }, NAGAREYAMA);
    expect(content.view && valueOf(content.view, "飛行状態", "GNSS 高度")).toBe("910m");
    expect(content.view && valueOf(content.view, "飛行状態", "対地速度")).toBe("463km/h");
  });
});

describe("detailPanelContent: 運用方向の受け渡し（AC-P2-53）", () => {
  const AIRPORT_OPS: AirportOps[] = [
    { icao: "RJTT", landingRunways: ["22"], departingRunways: [], configLabel: "南風運用", basedOn: 2, updatedAt: "2026-09-16T00:00:00.000Z" },
  ];
  const detail = makeDetail(
    makeFlight({
      hex: "86e7a0",
      estimate: { phase: "arrival", airport: { icao: "RJTT", name: "羽田" }, runway: "22", confidence: 0.9, evidence: [] },
    }),
  );

  it("渡した airportOps が「経路」の運用方向に出る", () => {
    const content = detailPanelContent({ hex: "86e7a0", status: "loaded", detail }, NAGAREYAMA, AIRPORT_OPS);
    expect(content.view).toEqual(buildDetailView(detail, NAGAREYAMA, AIRPORT_OPS));
    const items = content.view?.sections.at(-1)?.items ?? [];
    expect(items.find((item) => item.label === "運用方向")?.value).toBe("南風運用");
  });
});

// 一覧の行（AC-B4〜B7）。判断と値の計算はここに置き、.tsx は描画だけにする。
// 距離・方位・仰角は受信した位置で計算する（補間した位置は地図のアイコンにだけ使う）。
import { aircraftAltitudeM, bearingDeg, elevationAngleDeg, haversineKm } from "../../shared/geo.ts";
import type { Flight } from "../../shared/types.ts";
import { buildEstimateBadge, type EstimateBadge } from "./estimateView.ts";
import {
  airportShortLabel,
  DASH,
  DEFAULT_UNITS,
  ELEVATION_ONE_DECIMAL_BELOW_DEG,
  finiteOrUndefined,
  formatAltitudeM,
  formatBearing,
  formatDistanceKm,
  formatElevationDeg,
  formatSecondsAgo,
  formatSpeedKt,
  formatTrend,
  isFiniteNumber,
  nonEmpty,
  verticalTrend,
  type Units,
  type VerticalTrend,
} from "./format.ts";
import type { Location } from "./locationStore.ts";
import { typeDisplayName } from "./typeNames.ts";

/** 観測者の地点（度）と標高（m）。保存する地点（`locationStore.ts` の `Location`）と同じ形 */
export type Observer = Location;

/** 見え方の区分。仰角 10° 以上 visible、0° 以上 10° 未満 hard、0° 未満 belowHorizon */
export type Visibility = "visible" | "hard" | "belowHorizon";

export type SortMode = "distance" | "elevation" | "altitude" | "callsign";

export type FlightRow = {
  hex: string;
  /** 元の機体 */
  flight: Flight;
  /** コールサイン（前後の空白を除く。空なら undefined）。便名順の並び替えキー */
  callsign?: string;
  /** callsign（無ければ hex） */
  callsignText: string;
  /** 航空会社名（無ければ "—"） */
  airlineText: string;
  /** "HND Tokyo → FUK Fukuoka"。route が無ければ undefined（この段だけを省く） */
  routeText?: string;
  typeText: string;
  /** 機体の高度 h（m）。altitudeGeomFt 優先、無ければ altitudeBaroFt。表示の単位に関わらず m（並び替えのキーに使う） */
  altitudeM?: number;
  altitudeText: string;
  speedText: string;
  trend?: VerticalTrend;
  /** "▲ 上昇" など。昇降率が無ければ undefined */
  trendText?: string;
  /** 観測地点からの水平距離（km） */
  distanceKm: number;
  distanceText: string;
  bearingText: string;
  elevationDeg?: number;
  elevationText: string;
  /** 仰角が無ければ undefined */
  visibility?: Visibility;
  /** "見えにくい" / "地平線の下"。visible と仰角無しでは undefined */
  visibilityLabel?: string;
  isCargo: boolean;
  /** kind が cargo なら "貨物"（CARGO_BADGE_LABEL）、それ以外は undefined */
  badgeText?: string;
  /** 経路の推定バッジ（AC-P2-50）。推定が無い機体では undefined（バッジを出さない） */
  estimateBadge?: EstimateBadge;
};

/** 見えにくいとする仰角の上限（度、この値未満が hard）。仰角の表示を小数 1 桁にする境界と同じ値 */
export const HARD_TO_SEE_ELEVATION_DEG = ELEVATION_ONE_DECIMAL_BELOW_DEG;

/** 貨物機の行に添えるバッジの文言 */
export const CARGO_BADGE_LABEL = "貨物";

/** 検索半径の選択肢（km） */
export const RADIUS_OPTIONS_KM = [10, 25, 50, 100] as const;

const VISIBILITY_LABELS: Readonly<Record<Visibility, string | undefined>> = {
  visible: undefined,
  hard: "見えにくい",
  belowHorizon: "地平線の下",
};

/** 仰角（度）から見え方の区分。仰角が無ければ undefined */
export function classifyVisibility(elevationDeg: number | undefined): Visibility | undefined {
  if (!isFiniteNumber(elevationDeg)) {
    return undefined;
  }
  if (elevationDeg < 0) {
    return "belowHorizon";
  }
  if (elevationDeg < HARD_TO_SEE_ELEVATION_DEG) {
    return "hard";
  }
  return "visible";
}

/** 見え方の文字（色以外の手がかり）。visible と区分無しでは undefined */
export function visibilityLabel(visibility: Visibility | undefined): string | undefined {
  return visibility === undefined ? undefined : VISIBILITY_LABELS[visibility];
}

function buildRow(flight: Flight, observer: Observer, units: Units): FlightRow {
  const target = { lat: flight.position.lat, lon: flight.position.lon };
  const distanceKm = haversineKm(observer, target);
  const altitudeM = finiteOrUndefined(aircraftAltitudeM(flight.position));
  const elevationDeg =
    altitudeM === undefined || !isFiniteNumber(distanceKm)
      ? undefined
      : finiteOrUndefined(
          elevationAngleDeg({ horizontalKm: distanceKm, observerAltitudeM: observer.elevationM, targetAltitudeM: altitudeM }),
        );
  const visibility = classifyVisibility(elevationDeg);
  const trend = verticalTrend(flight.verticalRateFpm);
  const route = flight.route;
  const callsign = nonEmpty(flight.callsign);
  const isCargo = flight.kind === "cargo";

  return {
    hex: flight.hex,
    flight,
    callsign,
    callsignText: callsign ?? flight.hex,
    airlineText: nonEmpty(flight.airline?.name) ?? DASH,
    routeText:
      route === undefined ? undefined : `${airportShortLabel(route.origin)} → ${airportShortLabel(route.destination)}`,
    typeText: typeDisplayName(flight.typeCode),
    altitudeM,
    altitudeText: formatAltitudeM(altitudeM, units.altitude),
    speedText: formatSpeedKt(flight.groundSpeedKt, units.speed),
    trend,
    trendText: formatTrend(trend),
    distanceKm,
    distanceText: formatDistanceKm(distanceKm),
    bearingText: isFiniteNumber(distanceKm) ? formatBearing(bearingDeg(observer, target)) : DASH,
    elevationDeg,
    elevationText: formatElevationDeg(elevationDeg),
    visibility,
    visibilityLabel: visibilityLabel(visibility),
    isCargo,
    badgeText: isCargo ? CARGO_BADGE_LABEL : undefined,
    // 高度は行が計算した altitudeM をそのまま渡す（同じ式を二度評価しない）。バッジの高度も同じ単位で出す
    estimateBadge: buildEstimateBadge(flight.estimate, altitudeM, units.altitude),
  };
}

/**
 * 機体を一覧の行にする。入力の機体をすべて行にし、件数を減らさない（順序は入力のまま）。
 * `units` は高度・対地速度の表示の単位（省くと既定の m・km/h。F-09・AC-P2-72）
 */
export function buildRows(flights: readonly Flight[], observer: Observer, units: Units = DEFAULT_UNITS): FlightRow[] {
  return flights.map((flight) => buildRow(flight, observer, units));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 値の無い（undefined）行を末尾に回す比較。両方無ければ 0 */
function compareMaybe<T>(a: T | undefined, b: T | undefined, compare: (x: T, y: T) => number): number {
  if (a === undefined) {
    return b === undefined ? 0 : 1;
  }
  if (b === undefined) {
    return -1;
  }
  return compare(a, b);
}

const SORT_KEYS: Readonly<Record<SortMode, (a: FlightRow, b: FlightRow) => number>> = {
  // 近い順（距離の昇順）
  distance: (a, b) => compareMaybe(finiteOrUndefined(a.distanceKm), finiteOrUndefined(b.distanceKm), (x, y) => x - y),
  // 仰角が高い順（降順）
  elevation: (a, b) =>
    compareMaybe(finiteOrUndefined(a.elevationDeg), finiteOrUndefined(b.elevationDeg), (x, y) => y - x),
  // 高度が低い順（昇順）
  altitude: (a, b) => compareMaybe(finiteOrUndefined(a.altitudeM), finiteOrUndefined(b.altitudeM), (x, y) => x - y),
  // 便名順（行の callsign の昇順）
  callsign: (a, b) => compareMaybe(a.callsign, b.callsign, compareText),
};

/** 並び替えた新しい配列を返す（入力は変えない）。値の無い行は末尾、同値は hex の昇順 */
export function sortRows(rows: readonly FlightRow[], mode: SortMode): FlightRow[] {
  const byKey = SORT_KEYS[mode];
  return [...rows].sort((a, b) => byKey(a, b) || compareText(a.hex, b.hex));
}

/**
 * 一覧の上の件数と更新の文言（AC-B5・AC-B9、計画 M3-1）。
 * X は サーバの updatedAt（ISO 文字列）から now（epoch ミリ秒）までの経過秒（切り捨て、負は 0）。
 * updatedAt が解釈できなければ「無い」として扱う。
 */
export function summaryText(args: { count: number; updatedAt?: string; now: number; failed: boolean }): string {
  const updatedAtMs = args.updatedAt === undefined ? Number.NaN : Date.parse(args.updatedAt);
  const hasData = Number.isFinite(updatedAtMs);
  if (args.failed) {
    return hasData ? `更新できません（${formatSecondsAgo((args.now - updatedAtMs) / 1000)}のデータ）` : "更新できません";
  }
  return hasData ? `周辺 ${args.count} 機・${formatSecondsAgo((args.now - updatedAtMs) / 1000)}に更新` : "取得中…";
}

/** 次の段の半径。選択肢 10 / 25 / 50 / 100 のうち radiusKm より大きい最小の値（100 以上なら undefined） */
export function nextRadius(radiusKm: number): number | undefined {
  return RADIUS_OPTIONS_KM.find((option) => option > radiusKm);
}

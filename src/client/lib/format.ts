// 一覧・詳細で使う表示用の文字列（AC-B4・AC-B13）。高度と対地速度は設定の単位で出す（F-09・AC-P2-72）。
// 値が無い（null / undefined）・非有限（NaN・±Infinity）なら DASH を返す。
import { bearingToJa16, FT_TO_M } from "../../shared/geo.ts";
import type { Airport } from "../../shared/types.ts";

/** 値の無い項目の表示 */
export const DASH = "—";

/** 1 kt = 1.852 km/h */
export const KT_TO_KMH = 1.852;

// ---- 表示の単位（F-09・仕様 Q6） ----
// 切り替えるのは高度と対地速度だけ。昇降率は m/分（Q15）、距離は km で固定する。
// 型と既定値はここ（書式の関数と同じ場所）に 1 つだけ置き、settingsStore.ts はこれを再輸出する
// （settingsStore.ts に置くと format.ts → settingsStore.ts → listView.ts → flightRows.ts → format.ts の循環になる）。

export type AltitudeUnit = "m" | "ft";
export type SpeedUnit = "kmh" | "kt";

/** 表示の単位（高度・速度）。設定（settingsStore.ts の `Settings.units`）から渡る */
export type Units = { altitude: AltitudeUnit; speed: SpeedUnit };

/** 単位の既定値（仕様 Q6「既定は m と km/h」）。単位を渡さない呼び出しはこの値で出す */
export const DEFAULT_UNITS: Units = { altitude: "m", speed: "kmh" };

/** 速度の単位の表示（`kmh` だけ値と表示が違う） */
const SPEED_UNIT_SUFFIX: Readonly<Record<SpeedUnit, string>> = { kmh: "km/h", kt: "kt" };

/**
 * 高度の丸めの単位（m・ft とも 10 単位）。
 * 10ft ≒ 3m なので、ft に切り替えても m 表示（10m 刻み）より粗くはならない（単位を変えて情報が減らない）
 */
const ALTITUDE_ROUND_STEP = 10;

/** 上昇／下降／水平の境界（fpm）。§10.2 のフェーズ判定と同じ値 */
export const VERTICAL_TREND_THRESHOLD_FPM = 200;

/**
 * 仰角をこの値（度）未満なら小数 1 桁、以上なら整数で表示する。
 * 見え方の区分の境界（flightRows.ts の HARD_TO_SEE_ELEVATION_DEG）と同じ値にする
 */
export const ELEVATION_ONE_DECIMAL_BELOW_DEG = 10;

export type MaybeNumber = number | null | undefined;

/** 有限の数値か（null / undefined・NaN・±Infinity は false） */
export function isFiniteNumber(value: MaybeNumber): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 有限の数値ならその値、そうでなければ undefined */
export function finiteOrUndefined(value: MaybeNumber): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

/** 前後の空白を除き、空なら undefined */
export function nonEmpty(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}

/** 負のゼロ（-0）を 0 にする。それ以外はそのまま */
export function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

/** 整数を 3 桁ごとにカンマで区切る（ロケールに依存しない） */
function groupThousands(integer: number): string {
  const sign = integer < 0 ? "-" : "";
  return sign + String(Math.abs(integer)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 高度の値（その単位のままの数）を 10 単位に丸めて桁区切りし、単位を付ける */
function altitudeText(value: number, unit: AltitudeUnit): string {
  const rounded = Math.round(value / ALTITUDE_ROUND_STEP) * ALTITUDE_ROUND_STEP;
  return `${groupThousands(normalizeZero(rounded))}${unit}`;
}

/**
 * 高度（m）を表示の単位で。10 単位に丸めて桁区切り（例 2011.68 → "2,010m"、単位が ft なら "6,600ft"）。
 * 単位を省くと既定の m（AC-P2-72）。
 * **元が ft の値（ADS-B の高度）はこれに渡さず `formatAltitudeFt` を使う**。
 * ft → m → ft の往復では 25ft 刻みの受信値（例 875ft）が 10ft の丸めの境界で逆向きに丸まり、表示が食い違う
 */
export function formatAltitudeM(meters: MaybeNumber, unit: AltitudeUnit = DEFAULT_UNITS.altitude): string {
  if (!isFiniteNumber(meters)) {
    return DASH;
  }
  return altitudeText(unit === "ft" ? meters / FT_TO_M : meters, unit);
}

/**
 * 高度（ft）を表示の単位で（例 6600ft → "2,010m"、単位が ft なら "6,600ft"）。
 * 単位が ft なら換算しない（ft → m → ft の往復で誤差を作らない）
 */
export function formatAltitudeFt(feet: MaybeNumber, unit: AltitudeUnit = DEFAULT_UNITS.altitude): string {
  if (!isFiniteNumber(feet)) {
    return DASH;
  }
  return unit === "ft" ? altitudeText(feet, "ft") : formatAltitudeM(feet * FT_TO_M, "m");
}

/** 対地速度（kt）を表示の単位の整数で（例 250kt → "463km/h"、単位が kt なら "250kt"）。単位を省くと既定の km/h */
export function formatSpeedKt(knots: MaybeNumber, unit: SpeedUnit = DEFAULT_UNITS.speed): string {
  if (!isFiniteNumber(knots)) {
    return DASH;
  }
  const value = unit === "kt" ? knots : knots * KT_TO_KMH;
  return `${normalizeZero(Math.round(value))}${SPEED_UNIT_SUFFIX[unit]}`;
}

/** 水平距離（km）。小数 1 桁に丸めた値が 10 未満なら小数 1 桁、以上なら整数（9.94 → "9.9km"、9.96 → "10km"） */
export function formatDistanceKm(km: MaybeNumber): string {
  if (!isFiniteNumber(km)) {
    return DASH;
  }
  const oneDecimal = Math.round(km * 10) / 10;
  if (oneDecimal < 10) {
    return `${normalizeZero(oneDecimal).toFixed(1)}km`;
  }
  return `${Math.round(km)}km`;
}

/** 昇降率（fpm）を m/分 の整数に。正なら "+" を付ける（+1000fpm → "+305m/分"） */
export function formatVerticalRateFpm(fpm: MaybeNumber): string {
  if (!isFiniteNumber(fpm)) {
    return DASH;
  }
  const mPerMin = Math.round(fpm * FT_TO_M);
  if (mPerMin > 0) {
    return `+${mPerMin}m/分`;
  }
  return `${normalizeZero(mPerMin)}m/分`;
}

export type VerticalTrend = "climb" | "descend" | "level";

/** 昇降の区分。> +200 は climb、< −200 は descend、その間（±200 ちょうどを含む）は level。値が無ければ undefined */
export function verticalTrend(fpm: MaybeNumber): VerticalTrend | undefined {
  if (!isFiniteNumber(fpm)) {
    return undefined;
  }
  if (fpm > VERTICAL_TREND_THRESHOLD_FPM) {
    return "climb";
  }
  if (fpm < -VERTICAL_TREND_THRESHOLD_FPM) {
    return "descend";
  }
  return "level";
}

const TREND_LABELS: Readonly<Record<VerticalTrend, string>> = {
  climb: "▲ 上昇",
  descend: "▼ 下降",
  level: "― 水平",
};

/** 昇降の区分を記号と文字の両方で。区分が無ければ undefined（記号を出さない） */
export function formatTrend(trend: VerticalTrend | undefined): string | undefined {
  return trend === undefined ? undefined : TREND_LABELS[trend];
}

/** 方位（度）を 16 方位の日本語に。求まらなければ（値無し・非有限で bearingToJa16 が undefined）DASH */
export function formatBearing(bearingDeg: MaybeNumber): string {
  return bearingToJa16(bearingDeg ?? Number.NaN) ?? DASH;
}

/**
 * 仰角（度）を "°" 付きで。
 * 10° 未満は 0.1° 単位で負の方向に切り捨てて小数 1 桁（9.99 → "9.9°"、0 → "0.0°"、-0.01 → "-0.1°"）、
 * 10° 以上は整数に丸める（10.4 → "10°"、45.6 → "46°"）。
 * 表示が 10 以上なら仰角は 10° 以上（visible）、0.0 以上なら 0° 以上（地平線の下ではない）、負なら 0° 未満になる
 */
export function formatElevationDeg(deg: MaybeNumber): string {
  if (!isFiniteNumber(deg)) {
    return DASH;
  }
  if (deg < ELEVATION_ONE_DECIMAL_BELOW_DEG) {
    return `${normalizeZero(Math.floor(deg * 10) / 10).toFixed(1)}°`;
  }
  return `${Math.round(deg)}°`;
}

/** 経過秒を "X 秒前" に。小数は切り捨て、負は 0 */
export function formatSecondsAgo(seconds: MaybeNumber): string {
  if (!isFiniteNumber(seconds)) {
    return DASH;
  }
  const whole = Math.max(0, Math.floor(seconds));
  return `${normalizeZero(whole)} 秒前`;
}

/**
 * 空港の短い表記。IATA（無ければ ICAO）＋空白＋都市名（都市名が無ければコードのみ）。
 * 例 { icao: "RJTT", iata: "HND", municipality: "Tokyo" } → "HND Tokyo"
 */
export function airportShortLabel(airport: Pick<Airport, "icao" | "iata" | "municipality">): string {
  const code = nonEmpty(airport.iata) ?? airport.icao.trim();
  const city = nonEmpty(airport.municipality);
  return city === undefined ? code : `${code} ${city}`;
}

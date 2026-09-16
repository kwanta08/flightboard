// 計算仕様（docs/spec.md §11）。角度の入出力はすべて「度」。
import type { Flight } from "./types.ts";

export const EARTH_RADIUS_KM = 6371;
export const FT_TO_M = 0.3048;

/** 緯度・経度（度） */
export type LatLon = { lat: number; lon: number };

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/** 任意の角度（度）を [0, 360) に正規化する */
function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** 水平距離（km）。haversine 公式、R = 6371km */
export function haversineKm(from: LatLon, to: LatLon): number {
  const phi0 = from.lat * DEG_TO_RAD;
  const phi = to.lat * DEG_TO_RAD;
  const dPhi = phi - phi0;
  const dLambda = (to.lon - from.lon) * DEG_TO_RAD;
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi0) * Math.cos(phi) * Math.sin(dLambda / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

/** from から見た to の方位（度、真北 0・時計回り、[0, 360)） */
export function bearingDeg(from: LatLon, to: LatLon): number {
  const phi0 = from.lat * DEG_TO_RAD;
  const phi = to.lat * DEG_TO_RAD;
  const dLambda = (to.lon - from.lon) * DEG_TO_RAD;
  const y = Math.sin(dLambda) * Math.cos(phi);
  const x = Math.cos(phi0) * Math.sin(phi) - Math.sin(phi0) * Math.cos(phi) * Math.cos(dLambda);
  return normalizeDeg(Math.atan2(y, x) * RAD_TO_DEG);
}

/**
 * from から方位 bearingDeg（度、真北 0・時計回り）へ distanceKm だけ進めた点（大円上の前進）。
 * bearingDeg の逆算（`bearingDeg(from, destinationPoint(from, b, d)) === b`）が成り立つ。
 * 経度は [-180, 180) に正規化する。距離が 0 なら from と同じ点。
 */
export function destinationPoint(from: LatLon, bearingDeg: number, distanceKm: number): LatLon {
  const delta = distanceKm / EARTH_RADIUS_KM;
  const theta = bearingDeg * DEG_TO_RAD;
  const phi0 = from.lat * DEG_TO_RAD;
  const sinPhi = Math.sin(phi0) * Math.cos(delta) + Math.cos(phi0) * Math.sin(delta) * Math.cos(theta);
  const phi = Math.asin(sinPhi);
  const dLambda = Math.atan2(
    Math.sin(theta) * Math.sin(delta) * Math.cos(phi0),
    Math.cos(delta) - Math.sin(phi0) * sinPhi,
  );
  const lon = from.lon + dLambda * RAD_TO_DEG;
  return { lat: phi * RAD_TO_DEG, lon: normalizeDeg(lon + 180) - 180 };
}

export const JA_16_DIRECTIONS = [
  "北", "北北東", "北東", "東北東", "東", "東南東", "南東", "南南東",
  "南", "南南西", "南西", "西南西", "西", "西北西", "北西", "北北西",
] as const;

export type Ja16Direction = (typeof JA_16_DIRECTIONS)[number];

/**
 * 方位（度）を 16 方位の日本語にする。各 22.5° 区間の中心を方位とする（[348.75, 11.25) が北）。
 * 非有限の入力（NaN・±Infinity）では undefined（表示側で「—」にする）。
 */
export function bearingToJa16(bearingDeg: number): Ja16Direction | undefined {
  if (!Number.isFinite(bearingDeg)) {
    return undefined;
  }
  const index = Math.floor((normalizeDeg(bearingDeg) + 11.25) / 22.5) % 16;
  return JA_16_DIRECTIONS[index];
}

/**
 * 見上げる角度 ε（度）。地球の丸みを補正する。
 * ε = atan((h − h₀)/d − d/(2R))。d = 0 のときは h − h₀ の符号で ±90°、等しければ 0°。
 */
export function elevationAngleDeg(args: { horizontalKm: number; observerAltitudeM: number; targetAltitudeM: number }): number {
  const dM = args.horizontalKm * 1000;
  const dhM = args.targetAltitudeM - args.observerAltitudeM;
  if (dM === 0) {
    return dhM > 0 ? 90 : dhM < 0 ? -90 : 0;
  }
  const rM = EARTH_RADIUS_KM * 1000;
  return Math.atan(dhM / dM - dM / (2 * rM)) * RAD_TO_DEG;
}

/** 直線距離（km）= √(d² + (h − h₀)²) */
export function slantDistanceKm(args: { horizontalKm: number; observerAltitudeM: number; targetAltitudeM: number }): number {
  const dhKm = (args.targetAltitudeM - args.observerAltitudeM) / 1000;
  return Math.hypot(args.horizontalKm, dhKm);
}

/** 機体の高度 h（ft）。altitudeGeomFt を優先し、無ければ altitudeBaroFt。どちらも無ければ null */
export function aircraftAltitudeFt(position: Pick<Flight["position"], "altitudeBaroFt" | "altitudeGeomFt">): number | null {
  return position.altitudeGeomFt ?? position.altitudeBaroFt;
}

/** 機体の高度 h（m）。aircraftAltitudeFt を ft → m（0.3048）で換算。どちらも無ければ null */
export function aircraftAltitudeM(position: Pick<Flight["position"], "altitudeBaroFt" | "altitudeGeomFt">): number | null {
  const ft = aircraftAltitudeFt(position);
  return ft === null ? null : ft * FT_TO_M;
}

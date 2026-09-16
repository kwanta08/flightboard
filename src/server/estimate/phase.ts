// フェーズの判定（docs/spec.md §10.2 の表 / AC-P2-10〜15）。
// 入力は単発の Flight だけで、航跡（TrackPoint[]）は使わない。I/O もグローバル状態も持たない純粋関数。
// 高度は aircraftAltitudeFt（GNSS 優先。spec §11 と揃える）を使う。
import { type LatLon, aircraftAltitudeFt, bearingDeg, haversineKm } from "../../shared/geo.ts";
import type { Flight } from "../../shared/types.ts";
import { TARGET_AIRPORTS, type TargetAirport } from "../data/airports.ts";

/** 推定のフェーズ（src/shared/types.ts の Flight["estimate"].phase と同じ） */
export type FlightPhase = NonNullable<Flight["estimate"]>["phase"];

/** 高度がこの値（ft）未満なら進入・出発の候補（AC-P2-10 / 11） */
export const LOW_ALTITUDE_FT = 10_000;

/** 高度がこの値（ft）より上で水平飛行なら通過（AC-P2-12） */
export const ENROUTE_ALTITUDE_FT = 20_000;

/**
 * 昇降率がこの値（fpm）以内なら水平飛行。降下中は −この値未満、上昇中は +この値より上。
 * 滑走路の候補条件（AC-P2-20 / 21）の「降下中／上昇中」も同じ値で判定する。
 */
export const VERTICAL_RATE_THRESHOLD_FPM = 200;

/**
 * 進行方向と「機体 → 空港中心」の方位の差がこの値（度）**未満**なら接近中、
 * **より大きければ**離脱中（ちょうど 90° はどちらでもない）。spec に定義が無いので plan で仮決めした。
 */
export const APPROACH_ANGLE_DEG = 90;

export type PhaseResult = {
  phase: FlightPhase;
  /** 接近中／離脱中と判定した空港（複数あれば機体に近い方）。enroute / unknown では undefined */
  airport?: TargetAirport;
};

/** 2 つの方位の差（度、0〜180）。0°/360° をまたいでも正しく出る */
export function angleDifferenceDeg(a: number, b: number): number {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}

/**
 * 有限の数値ならその値、そうでなければ undefined。
 * 欠損値（undefined・null）と非有限（NaN・±Infinity）の扱いを 1 箇所にまとめる（AC-P2-15）。
 */
export function finiteOrUndefined(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 幾何だけで決めるフェーズ（§10.2 の表を上から順に評価する）。
 * 高度・trackDeg・verticalRateFpm のいずれかが欠けていれば例外を出さず `unknown`（AC-P2-15）。
 */
export function detectPhase(flight: Flight, airports: readonly TargetAirport[] = TARGET_AIRPORTS): PhaseResult {
  const altitudeFt = finiteOrUndefined(aircraftAltitudeFt(flight.position));
  const trackDeg = finiteOrUndefined(flight.trackDeg);
  const verticalRateFpm = finiteOrUndefined(flight.verticalRateFpm);
  if (altitudeFt === undefined || trackDeg === undefined || verticalRateFpm === undefined) {
    return { phase: "unknown" };
  }

  if (altitudeFt < LOW_ALTITUDE_FT && verticalRateFpm < -VERTICAL_RATE_THRESHOLD_FPM) {
    const airport = nearestAirportInDirection(flight.position, trackDeg, airports, "toward");
    if (airport) {
      return { phase: "arrival", airport };
    }
  }

  if (altitudeFt < LOW_ALTITUDE_FT && verticalRateFpm > VERTICAL_RATE_THRESHOLD_FPM) {
    const airport = nearestAirportInDirection(flight.position, trackDeg, airports, "away");
    if (airport) {
      return { phase: "departure", airport };
    }
  }

  if (altitudeFt > ENROUTE_ALTITUDE_FT && Math.abs(verticalRateFpm) <= VERTICAL_RATE_THRESHOLD_FPM) {
    return { phase: "enroute" };
  }

  return { phase: "unknown" };
}

/**
 * 進行方向から見て接近中（`toward`）／離脱中（`away`）の対象空港のうち、機体に最も近いもの。
 * どれも当てはまらなければ undefined。
 */
function nearestAirportInDirection(
  position: LatLon,
  trackDeg: number,
  airports: readonly TargetAirport[],
  direction: "toward" | "away",
): TargetAirport | undefined {
  let best: { airport: TargetAirport; distanceKm: number } | undefined;
  for (const airport of airports) {
    const offDeg = angleDifferenceDeg(bearingDeg(position, airport), trackDeg);
    const matches = direction === "toward" ? offDeg < APPROACH_ANGLE_DEG : offDeg > APPROACH_ANGLE_DEG;
    if (!matches) {
      continue;
    }
    const distanceKm = haversineKm(position, airport);
    if (!best || distanceKm < best.distanceKm) {
      best = { airport, distanceKm };
    }
  }
  return best?.airport;
}

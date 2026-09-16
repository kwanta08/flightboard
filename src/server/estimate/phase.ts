// フェーズの判定（docs/spec.md §10.2 の表 / AC-P2-10〜15）。
// 入力は単発の Flight だけで、航跡（TrackPoint[]）は使わない。I/O もグローバル状態も持たない純粋関数。
// 高度は aircraftAltitudeFt（GNSS 優先。spec §11 と揃える）を使う。
import { type LatLon, aircraftAltitudeFt, bearingDeg, haversineKm } from "../../shared/geo.ts";
import type { Flight } from "../../shared/types.ts";
import { TARGET_AIRPORTS, type TargetAirport } from "../data/airports.ts";
import type { RunwayEnd } from "../data/importRunways.ts";
import { RUNWAY_ENDS } from "../data/runways.ts";

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
 * 進行方向と「機体 → 基準点」の方位の差がこの値（度）**未満**なら接近中、
 * **より大きければ**離脱中（ちょうど 90° はどちらでもない）。spec に定義が無いので plan で仮決めした。
 *
 * 基準点は空港中心（ARP）ではなく**その空港の滑走路端**である（referencePoints を見よ）。
 * 端は複数あり「いずれか 1 端が条件を満たせば」成立とするので、**同じ空港について接近中と離脱中が
 * 同時に成り立つ帯**（端の広がり分）がある。フェーズは昇降率で先に分かれるので実害は無いが、
 * この値や基準点を見直すときはここを思い出すこと（plan の「仮決めした解釈」の同項）。
 */
export const APPROACH_ANGLE_DEG = 90;

export type PhaseResult = {
  phase: FlightPhase;
  /**
   * 接近中／離脱中と判定した空港（複数あれば機体に近い方。距離は基準点＝滑走路端までで測る）。
   * enroute / unknown では undefined
   */
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
export function detectPhase(
  flight: Flight,
  airports: readonly TargetAirport[] = TARGET_AIRPORTS,
  ends: readonly RunwayEnd[] = RUNWAY_ENDS,
): PhaseResult {
  const altitudeFt = finiteOrUndefined(aircraftAltitudeFt(flight.position));
  const trackDeg = finiteOrUndefined(flight.trackDeg);
  const verticalRateFpm = finiteOrUndefined(flight.verticalRateFpm);
  if (altitudeFt === undefined || trackDeg === undefined || verticalRateFpm === undefined) {
    return { phase: "unknown" };
  }

  if (altitudeFt < LOW_ALTITUDE_FT && verticalRateFpm < -VERTICAL_RATE_THRESHOLD_FPM) {
    const airport = nearestAirportInDirection(flight.position, trackDeg, airports, "toward", ends);
    if (airport) {
      return { phase: "arrival", airport };
    }
  }

  if (altitudeFt < LOW_ALTITUDE_FT && verticalRateFpm > VERTICAL_RATE_THRESHOLD_FPM) {
    const airport = nearestAirportInDirection(flight.position, trackDeg, airports, "away", ends);
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
 * 接近中／離脱中を測る基準点。**その空港の滑走路端すべて**（`ends` にその空港の端が無ければ空港中心 ARP）。
 *
 * ARP を基準にすると、離陸直後の機体で「離脱中」が成り立たない。ARP は滑走路群の中ほどにあり、
 * 滑走路は 2.5〜4km あるので、離陸した機体から見て ARP はしばらく真横〜前方に残る
 * （RJTT 22 出発・端から 1km で ARP との方位差は約 79°＝「ARP へ接近中」と読まれる）。
 * 滑走路端を基準にすれば、たった今離れた端から見て確かに遠ざかっているので素直に「離脱中」になる。
 * **接近中も同じ基準に揃える**（離脱と接近で基準が違うと、同じ位置の機体が両方に見える帯ができる。
 * 接近側では、滑走路に接地する直前の機体が「ARP を通り過ぎた」ことで進入でなくなる裏返しの誤りが消える）。
 */
function referencePoints(airport: TargetAirport, ends: readonly RunwayEnd[]): readonly LatLon[] {
  const own = ends.filter((end) => end.icao === airport.icao);
  return own.length > 0 ? own : [airport];
}

/**
 * 進行方向から見て接近中（`toward`）／離脱中（`away`）の対象空港のうち、機体に最も近いもの。
 * どれも当てはまらなければ undefined。
 *
 * 空港は基準点（滑走路端）を複数持つので、「向きの条件を満たす基準点が 1 つでもあれば、その空港は
 * 接近中／離脱中」とし、距離は**条件を満たした基準点のうち最も近いもの**で測る。
 * 空港どうしの比較もこの距離で行う。
 */
function nearestAirportInDirection(
  position: LatLon,
  trackDeg: number,
  airports: readonly TargetAirport[],
  direction: "toward" | "away",
  ends: readonly RunwayEnd[],
): TargetAirport | undefined {
  let best: { airport: TargetAirport; distanceKm: number } | undefined;
  for (const airport of airports) {
    for (const reference of referencePoints(airport, ends)) {
      const offDeg = angleDifferenceDeg(bearingDeg(position, reference), trackDeg);
      const matches = direction === "toward" ? offDeg < APPROACH_ANGLE_DEG : offDeg > APPROACH_ANGLE_DEG;
      if (!matches) {
        continue;
      }
      const distanceKm = haversineKm(position, reference);
      if (!best || distanceKm < best.distanceKm) {
        best = { airport, distanceKm };
      }
    }
  }
  return best?.airport;
}

// 地図のアイコンの補間（F-06・§11・AC-B11）。取得の合間は、位置の受信時刻から対地速度と進行方向で位置を前方に進める。
// 一覧の距離・方位・仰角は受信した位置で計算し、補間した位置は地図のアイコンにだけ使う（plan p1b「仮決めした解釈」）。
import { EARTH_RADIUS_KM, type LatLon } from "../../shared/geo.ts";
import type { Flight } from "../../shared/types.ts";
import { KT_TO_KMH } from "./format.ts";

/** 位置を前方に進める時間の上限（秒） */
export const DEFAULT_MAX_EXTRAPOLATION_SEC = 30;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * `from` から `trackDeg`（真北 0・時計回り）の方位へ、対地速度 `gsKt` で `seconds` 秒進んだ点。
 * 球面の到達点の公式（地球半径 `EARTH_RADIUS_KM`）で求める。経度は [-180, 180) に折り返さず、`from.lon` から連続した値を返す
 * （日付変更線を東へまたぐと 180 を超える。折り返すとアイコンが地図の反対側へ飛ぶ。表示範囲の radiusBounds と同じ扱い）。
 * 進む距離が 0 以下（または非有限）なら `from` と同じ座標を返す
 */
export function projectPosition(from: LatLon, gsKt: number, trackDeg: number, seconds: number): LatLon {
  const distanceKm = ((gsKt * KT_TO_KMH) / 3600) * seconds;
  if (!(distanceKm > 0) || !Number.isFinite(distanceKm) || !Number.isFinite(trackDeg)) {
    return { lat: from.lat, lon: from.lon };
  }
  const delta = distanceKm / EARTH_RADIUS_KM;
  const theta = trackDeg * DEG_TO_RAD;
  const phi1 = from.lat * DEG_TO_RAD;
  const lambda1 = from.lon * DEG_TO_RAD;

  const sinPhi2 = Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
  const phi2 = Math.asin(Math.min(1, Math.max(-1, sinPhi2)));
  const lambda2 =
    lambda1 +
    Math.atan2(Math.sin(theta) * Math.sin(delta) * Math.cos(phi1), Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2));

  return { lat: phi2 * RAD_TO_DEG, lon: lambda2 * RAD_TO_DEG };
}

/**
 * 補間したアイコンの位置。
 * 位置の受信時刻 `fixMs = receivedAtMs − seenPosSec × 1000`（`seenPosSec` は応答時点からの経過秒）から `nowMs` までの経過秒を
 * [0, `maxSec`] に丸めて前方に進める。対地速度か進行方向が無い（非有限）機体と、`receivedAtMs` が無いときは受信した位置のまま
 */
export function extrapolatedPosition(
  flight: Pick<Flight, "position" | "groundSpeedKt" | "trackDeg" | "seenPosSec">,
  receivedAtMs: number | undefined,
  nowMs: number,
  maxSec = DEFAULT_MAX_EXTRAPOLATION_SEC,
): LatLon {
  const origin: LatLon = { lat: flight.position.lat, lon: flight.position.lon };
  const { groundSpeedKt, trackDeg } = flight;
  if (
    receivedAtMs === undefined ||
    groundSpeedKt === undefined ||
    trackDeg === undefined ||
    !Number.isFinite(groundSpeedKt) ||
    !Number.isFinite(trackDeg)
  ) {
    return origin;
  }
  const fixMs = receivedAtMs - flight.seenPosSec * 1000;
  const elapsedSec = Math.min(maxSec, Math.max(0, (nowMs - fixMs) / 1000));
  if (!(elapsedSec > 0)) {
    return origin;
  }
  return projectPosition(origin, groundSpeedKt, trackDeg, elapsedSec);
}

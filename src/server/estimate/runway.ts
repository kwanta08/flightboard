// 滑走路の推定（docs/spec.md §10.2 / AC-P2-19〜23）。
// 各滑走路端について「方位のズレ」と「距離」を出し、条件を満たすものを採点して最良を採る純粋関数。
// 真方位はデータに持たず、自端 → 対向端の座標から計算する（AC-P2-01）。
import { type LatLon, bearingDeg, haversineKm } from "../../shared/geo.ts";
import type { RunwayEnd } from "../data/importRunways.ts";
import { VERTICAL_RATE_THRESHOLD_FPM, angleDifferenceDeg } from "./phase.ts";

/** 進入の候補になる滑走路端までの距離の上限（km。この値**未満**） */
export const APPROACH_MAX_DISTANCE_KM = 35;

/** 出発の候補になる滑走路端までの距離の上限（km。この値**未満**） */
export const DEPARTURE_MAX_DISTANCE_KM = 25;

/** 進入: 滑走路端の方向が進行方向のこの角度（度）**以内**にあること */
export const APPROACH_END_WINDOW_DEG = 20;

/** 出発: 滑走路端から見て離陸方向のこの角度（度）**以内**に機体がいること */
export const DEPARTURE_SECTOR_DEG = 35;

/** 許容ズレ = max(MIN_TOLERANCE_DEG, MAX_TOLERANCE_DEG − 距離km × TOLERANCE_PER_KM_DEG)（AC-P2-22） */
export const MAX_TOLERANCE_DEG = 20;
export const TOLERANCE_PER_KM_DEG = 0.4;
export const MIN_TOLERANCE_DEG = 3;

/** 採点 = 方位のズレ + 距離km × この重み（小さいほど良い。AC-P2-23） */
export const SCORE_DISTANCE_WEIGHT = 0.3;

export type RunwaySearch = {
  /** 機体の位置 */
  position: LatLon;
  trackDeg: number;
  verticalRateFpm: number;
  /** 候補探索を行うフェーズ。unknown / enroute では探索しない（AC-P2-19） */
  phase: "arrival" | "departure";
};

export type RunwayCandidate = {
  end: RunwayEnd;
  /** 滑走路の真方位（自端 → 対向端） */
  runwayBearingDeg: number;
  /** 方位のズレ（度、0〜180）= |機体の進行方向 − 滑走路の真方位| */
  headingOffDeg: number;
  /** 機体から滑走路端までの水平距離（km） */
  distanceKm: number;
  /** その距離での許容ズレ（度） */
  toleranceDeg: number;
  /** 採点（小さいほど良い） */
  score: number;
};

/** 許容ズレ（度）。距離が遠いほど狭める（AC-P2-22。実測で 31.8km 先を 12.6° のズレで誤判定したため） */
export function toleranceDeg(distanceKm: number): number {
  return Math.max(MIN_TOLERANCE_DEG, MAX_TOLERANCE_DEG - distanceKm * TOLERANCE_PER_KM_DEG);
}

/** 滑走路端の真方位（自端 → 対向端）。対向端が ends に無ければ undefined */
export function runwayBearingDeg(end: RunwayEnd, ends: readonly RunwayEnd[]): number | undefined {
  const opposite = ends.find((other) => other.icao === end.icao && other.ident === end.oppositeIdent);
  return opposite ? bearingDeg(end, opposite) : undefined;
}

/**
 * 条件（AC-P2-20 / 21）を満たす候補を、採点の昇順で返す。
 * 同点のときは ends の並び順を保つ（Array#sort は安定なので、出力は入力の順で決まる）。
 */
export function runwayCandidates(search: RunwaySearch, ends: readonly RunwayEnd[]): RunwayCandidate[] {
  // 降下中／上昇中（±200fpm。フェーズ判定と同じ値）を満たさなければ候補なし
  const verticalOk =
    search.phase === "arrival"
      ? search.verticalRateFpm < -VERTICAL_RATE_THRESHOLD_FPM
      : search.verticalRateFpm > VERTICAL_RATE_THRESHOLD_FPM;
  if (!verticalOk) {
    return [];
  }

  const candidates: RunwayCandidate[] = [];
  for (const end of ends) {
    const bearing = runwayBearingDeg(end, ends);
    if (bearing === undefined) {
      continue;
    }
    const distanceKm = haversineKm(search.position, end);
    const headingOffDeg = angleDifferenceDeg(search.trackDeg, bearing);
    const tolerance = toleranceDeg(distanceKm);
    if (headingOffDeg >= tolerance) {
      continue;
    }
    if (search.phase === "arrival") {
      if (distanceKm >= APPROACH_MAX_DISTANCE_KM) {
        continue;
      }
      // 滑走路端が進行方向の前方（±20°）にあること
      if (angleDifferenceDeg(bearingDeg(search.position, end), search.trackDeg) > APPROACH_END_WINDOW_DEG) {
        continue;
      }
    } else {
      if (distanceKm >= DEPARTURE_MAX_DISTANCE_KM) {
        continue;
      }
      // 滑走路端から見て、機体が離陸方向（滑走路の真方位）の ±35° にいること
      if (angleDifferenceDeg(bearingDeg(end, search.position), bearing) > DEPARTURE_SECTOR_DEG) {
        continue;
      }
    }
    candidates.push({
      end,
      runwayBearingDeg: bearing,
      headingOffDeg,
      distanceKm,
      toleranceDeg: tolerance,
      score: headingOffDeg + distanceKm * SCORE_DISTANCE_WEIGHT,
    });
  }
  return candidates.sort((a, b) => a.score - b.score);
}

/** 候補のうち採点が最小のもの（AC-P2-23）。候補が無ければ undefined */
export function selectRunway(search: RunwaySearch, ends: readonly RunwayEnd[]): RunwayCandidate | undefined {
  return runwayCandidates(search, ends)[0];
}

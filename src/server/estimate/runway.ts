// 滑走路の推定（docs/spec.md §10.2 / AC-P2-19〜23）。
// 各滑走路端について「方位のズレ」と「距離」を出し、条件を満たすものを採点して最良を採る純粋関数。
// 真方位はデータに持たず、自端 → 対向端の座標から計算する（AC-P2-01）。
import { type LatLon, bearingDeg, crossTrackKm, haversineKm } from "../../shared/geo.ts";
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

/**
 * 並行の組で L/C/R を決めるときの、最小の横ずれと次点の差の下限（km。この値**未満**なら決めない。AC-P3-06）。
 * 出どころ: plan 20260917-parallel-runway-and-fpm §「仮決めした解釈」の「しきい値 0.3km（横ずれの差）の限界」。
 * 実分離の最小が 1.70km（羽田）/ 1.88km（成田）なので、正しいケースを取りこぼさない安全弁として置く。
 */
export const RUNWAY_SIDE_MARGIN_KM = 0.3;

/**
 * 出発の基準点から**組の滑走路の端**までの距離の上限（km。この値**より遠い**なら L/C/R を決めない。AC-P3-05）。
 * 出どころ: plan §「出発の基準点としきい値の導出」（滑走路長 4.0km・浮揚地点・観測粒度 10〜30 秒からの導出。
 * 実フィードでの計測ではない）。
 */
export const DEPARTURE_TRACK_MAX_KM = 3.0;

/**
 * 出発の基準点の、選ばれる端の中心線からの横ずれの上限（km。この値**より大きい**なら決めない。AC-P3-05）。
 * 出どころ: plan §「出発の基準点としきい値の導出」の 2 つ目の条件と §「既知の妥協: 並行滑走路の誤判別帯」
 * （0.5 → 0.3km に絞って誤判別帯を 249 → 148 格子点に縮めた値。**この条件でも帯は消えない**）。
 */
export const DEPARTURE_TRACK_MAX_XTK_KM = 0.3;

/** L/C/R を決められなかったときの evidence の行（AC-P3-09） */
const UNDECIDED_SIDE_EVIDENCE = "L/R は判別できず";

export type RunwaySearch = {
  /** 機体の位置 */
  position: LatLon;
  trackDeg: number;
  verticalRateFpm: number;
  /** 候補探索を行うフェーズ。unknown / enroute では探索しない（AC-P2-19） */
  phase: "arrival" | "departure";
  /**
   * 機体の航跡（**古い順**）。出発で並行滑走路の L/C/R を判別するときだけ使う（AC-P3-05）。
   * 渡さなければ出発の判別は「決めない」に落ちる（Phase 2 と同じ挙動）。
   */
  track?: readonly LatLon[];
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

/**
 * 選ばれた滑走路端（AC-P3-04〜06 / 10）。`RunwayCandidate` の各値は**選ばれた端**のもので、
 * L/C/R を決められなかったときは組内で採点最小の端のもの（AC-P3-10）。
 */
export type RunwaySelection = RunwayCandidate & {
  /** 応答に出す滑走路。L/C/R まで決まれば `end.ident`、決まらなければ指示子の数字部分（"16L" → "16"） */
  runway: string;
  /** L/C/R まで決まったか */
  decided: boolean;
  /**
   * 確度に `min(素点, 0.6)` の上限を掛けるべきか（AC-P3-07。適用は estimate.ts）。
   * **「組の端が 2 つ以上」と同値**（決めたかどうか・進入／出発の別によらない）。
   * 並行の組の判別は進入も出発も**基準点 1 点の横ずれ**に依り、どちらにも誤判別帯が残るため
   * （plan 20260917-parallel-runway-and-fpm §「既知の妥協: 並行滑走路の誤判別帯」）。
   * 単独の組（羽田 04 / 22 / 05 / 23）は false（AC-P3-08 のとおり Phase 2 と完全に同じ）。
   */
  capConfidence: boolean;
  /** evidence の判別の行（AC-P3-09）。**並行の組のときだけ**付く */
  sideEvidence?: string;
};

/** 指示子の先頭の数字部分（"16L" → "16"、"22" → "22"）。数字で始まらなければ指示子そのもの */
function runwayNumber(ident: string): string {
  return /^\d+/.exec(ident)?.[0] ?? ident;
}

/** 対向端（同じ空港の oppositeIdent）。ends に無ければ undefined */
function oppositeEnd(end: RunwayEnd, ends: readonly RunwayEnd[]): RunwayEnd | undefined {
  return ends.find((other) => other.icao === end.icao && other.ident === end.oppositeIdent);
}

/** 許容ズレ（度）。距離が遠いほど狭める（AC-P2-22。実測で 31.8km 先を 12.6° のズレで誤判定したため） */
export function toleranceDeg(distanceKm: number): number {
  return Math.max(MIN_TOLERANCE_DEG, MAX_TOLERANCE_DEG - distanceKm * TOLERANCE_PER_KM_DEG);
}

/** 滑走路端の真方位（自端 → 対向端）。対向端が ends に無ければ undefined */
export function runwayBearingDeg(end: RunwayEnd, ends: readonly RunwayEnd[]): number | undefined {
  const opposite = oppositeEnd(end, ends);
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

/**
 * 並行の組（同じ空港・指示子の数字が同じ**全端**。AC-P3-01）。
 * 候補でない端も判別の対象に含めるので、ends から直接引く。
 */
function parallelGroup(end: RunwayEnd, ends: readonly RunwayEnd[]): readonly RunwayEnd[] {
  const number = runwayNumber(end.ident);
  return ends.filter((other) => other.icao === end.icao && runwayNumber(other.ident) === number);
}

/**
 * 候補条件を通らなかった端にも、候補と同じ量を作る（AC-P3-13 (e)。組の中では候補でない端も選ばれうる）。
 * 採点式は spec §10.2 の `方位のズレ + 距離km × 0.3` のままで、runwayCandidates と同じ値になる。
 */
function measureEnd(search: RunwaySearch, end: RunwayEnd, bearing: number): RunwayCandidate {
  const distanceKm = haversineKm(search.position, end);
  const headingOffDeg = angleDifferenceDeg(search.trackDeg, bearing);
  return {
    end,
    runwayBearingDeg: bearing,
    headingOffDeg,
    distanceKm,
    toleranceDeg: toleranceDeg(distanceKm),
    score: headingOffDeg + distanceKm * SCORE_DISTANCE_WEIGHT,
  };
}

/**
 * 出発の基準点（AC-P3-05）: 航跡の中で、**組の滑走路の端**（組の各端 ∪ それぞれの対向端）までの
 * 距離の最小値がいちばん小さい点。出発機の航跡は空港から遠ざかる一方なので、実質「最初の空中の位置通報」を選ぶ。
 * 航跡が無い／空、またはその距離が DEPARTURE_TRACK_MAX_KM より遠ければ undefined（＝決めない）。
 * その距離が同じ点が複数あるときは、**先に現れた（古い）点**を採る。
 */
function departureReferencePoint(
  track: readonly LatLon[] | undefined,
  group: readonly RunwayEnd[],
  ends: readonly RunwayEnd[],
): LatLon | undefined {
  if (!track || track.length === 0) {
    return undefined;
  }
  const runwayEnds = [...group];
  for (const end of group) {
    const opposite = oppositeEnd(end, ends);
    if (opposite && !runwayEnds.includes(opposite)) {
      runwayEnds.push(opposite);
    }
  }
  let reference: LatLon | undefined;
  let referenceDistanceKm = Number.POSITIVE_INFINITY;
  for (const point of track) {
    const distanceKm = Math.min(...runwayEnds.map((end) => haversineKm(point, end)));
    if (distanceKm < referenceDistanceKm) {
      referenceDistanceKm = distanceKm;
      reference = point;
    }
  }
  return referenceDistanceKm > DEPARTURE_TRACK_MAX_KM ? undefined : reference;
}

type SideDecision = { end: RunwayEnd; runwayBearingDeg: number; crossTrackKm: number };

/**
 * 組の中の L/C/R（AC-P3-04〜06）。決められなければ undefined。
 * 基準点は進入なら**現在位置**、出発なら**航跡の基準点**で、その点の中心線（自端 → 対向端）からの
 * 横ずれが最小の端を採る。次点との差が RUNWAY_SIDE_MARGIN_KM 未満なら決めない。
 * **中心線を引けた端（対向端が ends にある端）が 2 つ未満のときも決めない**（差を検査できないため）。
 */
function decideSide(
  search: RunwaySearch,
  group: readonly RunwayEnd[],
  ends: readonly RunwayEnd[],
): SideDecision | undefined {
  const reference =
    search.phase === "arrival" ? search.position : departureReferencePoint(search.track, group, ends);
  if (!reference) {
    return undefined;
  }
  const measured: SideDecision[] = [];
  for (const end of group) {
    const opposite = oppositeEnd(end, ends);
    if (!opposite) {
      // 中心線が引けない端は判別に使えない（真方位が無いので候補にもならない）
      continue;
    }
    measured.push({
      end,
      runwayBearingDeg: bearingDeg(end, opposite),
      crossTrackKm: crossTrackKm(reference, end, opposite),
    });
  }
  // 横ずれを測れた端が 2 つ未満なら決めない。1 つだけで決めると AC-P3-06 の「次点との差」を
  // 検査しないまま「決めた」ことになり、中心線から 0.8km 離れていても L/R を名乗ってしまう
  // （組の端は 2 つ以上あるのに、対向端が ends に無くて中心線が引けない端があるときに起こる）
  if (measured.length < 2) {
    return undefined;
  }
  measured.sort((a, b) => a.crossTrackKm - b.crossTrackKm);
  const closest = measured[0]!;
  const runnerUp = measured[1]!;
  // 出発の基準点は中心線に乗っていること（別の滑走路から出た機体・大きく外れた点を弾く）
  if (search.phase === "departure" && closest.crossTrackKm > DEPARTURE_TRACK_MAX_XTK_KM) {
    return undefined;
  }
  if (runnerUp.crossTrackKm - closest.crossTrackKm < RUNWAY_SIDE_MARGIN_KM) {
    return undefined;
  }
  return closest;
}

/** 判別の行（AC-P3-09）。並行の組の勝者にだけ付ける */
function sideEvidence(phase: RunwaySearch["phase"], crossTrackKm: number): string {
  const measured = `中心線から ${crossTrackKm.toFixed(1)}km`;
  return phase === "departure" ? `離陸直後 ${measured}` : measured;
}

/**
 * 候補のうち採点が最小のものを採り（AC-P2-23）、それが**並行の組**に属するなら組の中で L/C/R を判別する
 * （AC-P3-01〜06 / 10）。候補が無ければ undefined。
 *
 * 組どうしの比較は「その組で最良（採点最小）の端の採点」で行う（AC-P3-03）。候補は採点の昇順なので、
 * 先頭の候補が属する組がそのまま勝者になり、同点のときの並び（ends の順）も Phase 2 のままになる。
 */
export function selectRunway(search: RunwaySearch, ends: readonly RunwayEnd[]): RunwaySelection | undefined {
  const candidates = runwayCandidates(search, ends);
  const best = candidates[0];
  if (!best) {
    return undefined;
  }
  const group = parallelGroup(best.end, ends);
  if (group.length < 2) {
    // 単独の組（羽田 04 / 22 / 05 / 23）は Phase 2 と完全に同じ（AC-P3-08。確度の上限も掛けない）
    return { ...best, runway: best.end.ident, decided: true, capConfidence: false };
  }
  // 並行の組はここから先、決まっても決まらなくても確度に上限が掛かる（AC-P3-07）。
  // 判別が 1 点の横ずれに依るので、進入・出発とも誤判別帯が残るため
  // （plan §「既知の妥協: 並行滑走路の誤判別帯」）
  const decision = decideSide(search, group, ends);
  if (!decision) {
    // 決めないときの各値は組内で採点最小の端から取る（AC-P3-10）
    return {
      ...best,
      runway: runwayNumber(best.end.ident),
      decided: false,
      capConfidence: true,
      sideEvidence: UNDECIDED_SIDE_EVIDENCE,
    };
  }
  const chosen =
    candidates.find((candidate) => candidate.end === decision.end) ??
    measureEnd(search, decision.end, decision.runwayBearingDeg);
  return {
    ...chosen,
    runway: decision.end.ident,
    decided: true,
    capConfidence: true,
    sideEvidence: sideEvidence(search.phase, decision.crossTrackKm),
  };
}

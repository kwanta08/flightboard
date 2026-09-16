// 経路推定の表示（S-02 の一覧のバッジ、AC-P2-50・AC-P2-51）。判断と文言はここに置き、FlightList.tsx は描画だけにする。
// 確度のしきい値とラベルは src/shared/estimate.ts、空港の短縮コード（HND / NRT）は src/shared/airports.ts から引く
// （クライアント側で持ち直さない。tsconfig.client.json の include は src/client・src/shared なので src/server は読めない）。
import { airportDisplayName } from "../../shared/airports.ts";
import { confidenceLabel, type ConfidenceLabel } from "../../shared/estimate.ts";
import { aircraftAltitudeM } from "../../shared/geo.ts";
import type { Flight } from "../../shared/types.ts";
import { finiteOrUndefined, formatAltitudeM, nonEmpty } from "./format.ts";

type Estimate = NonNullable<Flight["estimate"]>;

/** バッジのフェーズの呼び名。unknown はバッジを出さないので持たない（plan の生成規則表） */
const PHASE_LABELS: Readonly<Record<"arrival" | "departure", string>> = {
  arrival: "進入",
  departure: "出発",
};

/** 滑走路の頭に付ける（"22" → "RWY22"） */
export const RUNWAY_PREFIX = "RWY";

/** 確度の見出し（AC-P2-51: 確度を色だけでなく文字でも示す） */
export const CONFIDENCE_PREFIX = "確度:";

/** 通過（phase = "enroute"）のバッジの文言と、それに添える高度の見出し */
export const ENROUTE_BADGE_TEXT = "通過";
const CRUISE_LABEL = "巡航";

/** バッジのアクセシブルネームの頭（読み上げで推定だと分かるようにする。S-02「必ず推定であることを添える」） */
export const ESTIMATE_BADGE_LABEL_PREFIX = "推定";

/** バッジのクラス名（styles.css と揃える） */
export const ESTIMATE_BADGE_CLASS = "flight-estimate";

/** 確度に応じた見た目の違い（S-02「確からしさに応じて表示を変える」）。文字（確度:高）と併用し、色だけに頼らない */
const CONFIDENCE_MODIFIERS: Readonly<Record<ConfidenceLabel, string>> = {
  高: `${ESTIMATE_BADGE_CLASS}--high`,
  中: `${ESTIMATE_BADGE_CLASS}--medium`,
  低: `${ESTIMATE_BADGE_CLASS}--low`,
};

export type EstimateBadge = {
  /** バッジに出す文字（例 "HND RWY22 進入 確度:高"・"通過（巡航 11,000m）"） */
  text: string;
  /** 読み上げ用（例 "推定 HND RWY22 進入 確度:高"） */
  label: string;
  /** 確度ラベル。滑走路が決まったときだけ付く（`confidenceLabel`）。無ければ確度を出さない */
  confidence?: ConfidenceLabel;
  /** バッジのクラス名（空白区切り） */
  className: string;
};

/**
 * 一覧の行の推定バッジ（AC-P2-50・plan の生成規則表）。
 * `estimate` が無い機体と、phase が unknown の推定では undefined（バッジを出さない）。
 * 高度は既定の m で出す（単位の切り替えは W7 の担当）。
 */
export function buildEstimateBadge(flight: Pick<Flight, "estimate" | "position">): EstimateBadge | undefined {
  const estimate = flight.estimate;
  if (estimate === undefined) {
    return undefined;
  }
  const confidence = confidenceLabel(estimate.confidence, runwayText(estimate.runway) !== undefined);
  const text = badgeText(estimate, confidence, finiteOrUndefined(aircraftAltitudeM(flight.position)));
  if (text === undefined) {
    return undefined;
  }
  return {
    text,
    label: `${ESTIMATE_BADGE_LABEL_PREFIX} ${text}`,
    confidence,
    className:
      confidence === undefined ? ESTIMATE_BADGE_CLASS : `${ESTIMATE_BADGE_CLASS} ${CONFIDENCE_MODIFIERS[confidence]}`,
  };
}

/**
 * バッジの文字。進入／出発は「空港 滑走路 フェーズ 確度」を、決まったものだけ空白で繋ぐ
 * （滑走路が決まらなければ "HND 進入"、確度ラベルもそのとき出さない）。
 * phase が unknown なら undefined（サーバーは推定を付けないが、受け取っても出さない）
 */
function badgeText(
  estimate: Estimate,
  confidence: ConfidenceLabel | undefined,
  altitudeM: number | undefined,
): string | undefined {
  if (estimate.phase === "enroute") {
    // 「通過（巡航 11,000m）」。高度が取れなければ括弧ごと省く
    return altitudeM === undefined ? ENROUTE_BADGE_TEXT : `${ENROUTE_BADGE_TEXT}（${CRUISE_LABEL} ${formatAltitudeM(altitudeM)}）`;
  }
  if (estimate.phase !== "arrival" && estimate.phase !== "departure") {
    return undefined;
  }
  const parts = [
    airportCode(estimate.airport?.icao),
    runwayText(estimate.runway),
    PHASE_LABELS[estimate.phase],
    confidence === undefined ? undefined : `${CONFIDENCE_PREFIX}${confidence}`,
  ];
  return parts.filter((part) => part !== undefined).join(" ");
}

/** 空港の短縮コード（RJTT → "HND"）。表に無い ICAO はそのまま出す（推測で埋めない）。空なら undefined */
function airportCode(icao: string | undefined): string | undefined {
  const trimmed = nonEmpty(icao);
  return trimmed === undefined ? undefined : (airportDisplayName(trimmed)?.code ?? trimmed);
}

/** 滑走路の表示（"22" → "RWY22"）。決まっていなければ undefined */
function runwayText(runway: string | undefined): string | undefined {
  const ident = nonEmpty(runway);
  return ident === undefined ? undefined : `${RUNWAY_PREFIX}${ident}`;
}

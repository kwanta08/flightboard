// 経路推定の表示（S-02 の一覧のバッジとヘッダーの運用方向、S-03 / F-05 の詳細の「経路」）。
// 判断と文言はここに置き、FlightList.tsx・App.tsx・DetailPanel.tsx は描画だけにする。
// 確度のしきい値とラベルは src/shared/estimate.ts、空港の表示名（HND / 羽田）は src/shared/airports.ts から引く
// （クライアント側で持ち直さない。tsconfig.client.json の include は src/client・src/shared なので src/server は読めない）。
import { AIRPORT_DISPLAY_NAMES, airportDisplayName } from "../../shared/airports.ts";
import { confidenceLabel, type ConfidenceLabel } from "../../shared/estimate.ts";
import type { AirportOps, Flight } from "../../shared/types.ts";
import { DASH, formatAltitudeM, nonEmpty } from "./format.ts";

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

/** バッジのアクセシブルネームの頭（読み上げでも推定だと分かるようにする。S-03「推定を鵜呑みにさせない」） */
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
  /**
   * 読み上げられる名前（例 "推定 HND RWY22 進入 確度:高"）。
   * .tsx は不可視の接頭辞（`ESTIMATE_BADGE_LABEL_PREFIX` ＋ 空白）と `text` を並べてこの名前を作る
   * （素の `<span>` は WAI-ARIA 1.2 の generic ロールで名前付けが禁止されているので `aria-label` は使わない）
   */
  label: string;
  /** 確度ラベル。滑走路が決まった進入／出発のときだけ付く（`confidenceLabel`）。無ければ確度を出さない */
  confidence?: ConfidenceLabel;
  /** バッジのクラス名（空白区切り） */
  className: string;
};

/**
 * 一覧の行の推定バッジ（AC-P2-50・plan の生成規則表）。
 * `estimate` が無い機体と、phase が unknown の推定では undefined（バッジを出さない）。
 * 高度（m）は行が計算したものを受け取る（同じ値を二度計算しない。単位の切り替えは W7 の担当で、ここは既定の m で出す）
 */
export function buildEstimateBadge(estimate: Flight["estimate"], altitudeM: number | undefined): EstimateBadge | undefined {
  if (estimate === undefined) {
    return undefined;
  }
  const confidence = estimateConfidence(estimate);
  const text = badgeText(estimate, confidence, altitudeM);
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
 * 確度ラベル。**滑走路が決まった進入／出発のときだけ**出す。
 * 滑走路の候補探索は phase が arrival / departure のときだけ行う（AC-P2-19）ので、
 * enroute や unknown に `runway` が付いた応答を受け取っても確度は出さない（色＝クラス名だけが確度を伝える状態にしない）
 */
function estimateConfidence(estimate: Estimate): ConfidenceLabel | undefined {
  if (estimate.phase !== "arrival" && estimate.phase !== "departure") {
    return undefined;
  }
  return confidenceLabel(estimate.confidence, runwayText(estimate.runway) !== undefined);
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

// ---- ヘッダーの運用方向（S-02・AC-P2-52） ----

/** 運用方向がまだ決まっていない空港に出す文字（常時表示するので、出さないのではなく「判定中」を出す） */
export const AIRPORT_OPS_PENDING_TEXT = "判定中";

/** ヘッダーで空港どうしを区切る文字（「羽田: 南風運用 / 成田: 判定中」） */
export const AIRPORT_OPS_SEPARATOR = " / ";

/** 空港名と運用方向の間に置く文字 */
const AIRPORT_OPS_DELIMITER = ": ";

/** 空港の表示名（RJTT → "羽田"）。表に無い ICAO はそのまま出す（推測で埋めない） */
function airportShortName(icao: string): string {
  return airportDisplayName(icao)?.shortName ?? icao;
}

/** その空港の運用方向（例 "南風運用"）。集計がまだ無い・対応表に無い（`configLabel` が付かない）なら undefined */
export function airportConfigLabel(
  icao: string | undefined,
  airportOps: readonly AirportOps[] | undefined,
): string | undefined {
  const target = nonEmpty(icao);
  if (target === undefined || airportOps === undefined) {
    return undefined;
  }
  return nonEmpty(airportOps.find((ops) => ops.icao === target)?.configLabel);
}

/** 1 空港分の文言（「羽田: 南風運用」。未判定は「羽田: 判定中」） */
export function airportOpsText(icao: string, airportOps: readonly AirportOps[] | undefined): string {
  return `${airportShortName(icao)}${AIRPORT_OPS_DELIMITER}${airportConfigLabel(icao, airportOps) ?? AIRPORT_OPS_PENDING_TEXT}`;
}

/**
 * ヘッダーに出す運用方向の 1 行（「羽田: 南風運用 / 成田: 判定中」。AC-P2-52）。
 * 対象空港（`AIRPORT_DISPLAY_NAMES`）を常に全部出し、集計に無い空港は「判定中」になる。
 * 対象空港でない集計は出さない（spec Q9 が対象を羽田・成田に固定している）
 */
export function buildAirportOpsHeader(airportOps: readonly AirportOps[] | undefined): string {
  return Object.keys(AIRPORT_DISPLAY_NAMES)
    .map((icao) => airportOpsText(icao, airportOps))
    .join(AIRPORT_OPS_SEPARATOR);
}

// ---- 詳細の「経路」（F-05・S-03・AC-P2-53） ----

/** 詳細の区分（`DETAIL_SECTION_TITLES` の末尾に足す） */
export const ESTIMATE_SECTION_TITLE = "経路";

/**
 * 「経路」の項目名（F-05 の「推定フェーズ、空港、滑走路、運用方向、一致度」のうち、
 * 「一致度」はレベル2（名前付き経路との照合）の項目なので Phase 2 では出さない）
 */
export const ESTIMATE_ITEM_LABELS = {
  phase: "推定フェーズ",
  airport: "空港",
  runway: "滑走路",
  airportConfig: "運用方向",
  confidence: "確度",
} as const;

/** 詳細のフェーズの呼び名（F-05「推定フェーズ（出発/進入/通過）」）。unknown は「—」 */
const DETAIL_PHASE_LABELS: Readonly<Record<Estimate["phase"], string>> = {
  arrival: PHASE_LABELS.arrival,
  departure: PHASE_LABELS.departure,
  enroute: ENROUTE_BADGE_TEXT,
  unknown: DASH,
};

export type EstimateSection = {
  title: typeof ESTIMATE_SECTION_TITLE;
  items: Array<{ label: string; value: string }>;
  /** 推定の根拠（`estimate.evidence` の各行。S-03「経路推定の根拠を開示する」）。無ければ空 */
  notes: string[];
};

/**
 * 詳細パネルの「経路」（AC-P2-53）。推定が無い機体では undefined（区分ごと出さない）。
 * 「運用方向」は推定した空港の集計（`airportOps`）から引く。決まっていない項目は「—」。
 * 単位の切り替えは W7 の担当なので、ここは数値の書式を持たない（`evidence` はサーバーの文字列をそのまま並べる）
 */
export function buildEstimateSection(
  estimate: Flight["estimate"],
  airportOps?: readonly AirportOps[],
): EstimateSection | undefined {
  if (estimate === undefined) {
    return undefined;
  }
  const labels = ESTIMATE_ITEM_LABELS;
  const confidence = estimateConfidence(estimate);
  return {
    title: ESTIMATE_SECTION_TITLE,
    items: [
      { label: labels.phase, value: phaseText(estimate.phase) },
      { label: labels.airport, value: airportText(estimate.airport) },
      { label: labels.runway, value: runwayText(estimate.runway) ?? DASH },
      { label: labels.airportConfig, value: airportConfigLabel(estimate.airport?.icao, airportOps) ?? DASH },
      { label: labels.confidence, value: confidence ?? DASH },
    ],
    // `evidence` はサーバーの応答なので、配列でないものが届いても描画を落とさない（空白だけの行は出さない）
    notes: (Array.isArray(estimate.evidence) ? estimate.evidence : [])
      .map((line) => nonEmpty(line))
      .filter((line) => line !== undefined),
  };
}

/** フェーズの表示。表に無い値（上流の応答が想定外でも落とさない）は「—」 */
function phaseText(phase: Estimate["phase"]): string {
  return Object.hasOwn(DETAIL_PHASE_LABELS, phase) ? DETAIL_PHASE_LABELS[phase] : DASH;
}

/** 空港の表示（RJTT → "羽田"）。表に無ければ推定に添えられた名前、それも無ければ ICAO。空港が無ければ「—」 */
function airportText(airport: Estimate["airport"]): string {
  const icao = nonEmpty(airport?.icao);
  const shortName = icao === undefined ? undefined : airportDisplayName(icao)?.shortName;
  return shortName ?? nonEmpty(airport?.name) ?? icao ?? DASH;
}

// 経路推定の確度ラベル（docs/spec.md §10.2）。しきい値はここ 1 箇所にだけ置く。
// サーバー（推定エンジン）とクライアント（一覧のバッジ・詳細の確度表示）が同じ値を読む。
// tsconfig.client.json の include は src/client・src/shared なので、
// クライアントからは src/server を import できない（だから src/shared にある）。

/** confidence がこの値以上なら「高」 */
export const CONFIDENCE_HIGH = 0.8;

/** confidence がこの値以上なら「中」（下回れば「低」） */
export const CONFIDENCE_MEDIUM = 0.5;

export type ConfidenceLabel = "高" | "中" | "低";

/**
 * 確度ラベル（AC-P2-24）。滑走路が決まっていない推定では undefined（ラベルを出さない）。
 * 食い違いで減点したあとの値も同じ規則で決まる（0.9 → 高 / 0.7 → 中 / 0.4 → 低）。
 * 非有限の confidence（NaN・±Infinity の -Infinity 側）は「低」に倒す。
 */
export function confidenceLabel(confidence: number, hasRunway: boolean): ConfidenceLabel | undefined {
  if (!hasRunway) {
    return undefined;
  }
  if (confidence >= CONFIDENCE_HIGH) {
    return "高";
  }
  if (confidence >= CONFIDENCE_MEDIUM) {
    return "中";
  }
  return "低";
}

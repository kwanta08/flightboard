// 経路推定の確度ラベルと昇降のしきい値（docs/spec.md §10.2）。しきい値はここ 1 箇所にだけ置く。
// サーバー（推定エンジン）とクライアント（一覧のバッジ・詳細の確度表示）が同じ値を読む。
// tsconfig.client.json の include は src/client・src/shared なので、
// クライアントからは src/server を import できない（だから src/shared にある）。

/** confidence がこの値以上なら「高」 */
export const CONFIDENCE_HIGH = 0.8;

/** confidence がこの値以上なら「中」（下回れば「低」） */
export const CONFIDENCE_MEDIUM = 0.5;

export type ConfidenceLabel = "高" | "中" | "低";

/**
 * 上昇／下降／水平の境界（fpm）。**この値ちょうどは水平**（降下中は −この値未満、上昇中は +この値より上）。
 * サーバー（§10.2 のフェーズ判定と滑走路の候補条件。`src/server/estimate/phase.ts` が再輸出する）と
 * クライアント（一覧・詳細の昇降の区分。`src/client/lib/format.ts` の `verticalTrend`）が同じ値を読む
 */
export const VERTICAL_RATE_THRESHOLD_FPM = 200;

/**
 * 昇降率の数値部分の書式（fpm）。`Math.round` で整数にし、-0 は 0 に直して `fpm` を付ける。
 * **符号は付けない**（正のときに "+" を足すかは呼び出し側が決める）:
 * サーバーの根拠（`src/server/estimate/estimate.ts` の `verticalRateEvidence`）は
 * 「上昇中」「降下中」「水平飛行」の語で向きを伝えるので ±200fpm 以内では符号を出さず、
 * クライアントの詳細の「昇降率」（`src/client/lib/format.ts` の `formatVerticalRateFpm`）は
 * 語が無く値の符号だけが向きを伝えるので正なら必ず "+" を出す。
 * 丸め・-0・接尾辞・桁区切りをしないことを 1 箇所にまとめるのは、
 * 詳細パネルで根拠の「降下中 -704fpm」と昇降率の「-704fpm」が**同じ数字になることを構成で保証する**ため
 * （しきい値を `VERTICAL_RATE_THRESHOLD_FPM` に 1 箇所化したのと同じ理由。仕様 Q15）。
 *
 * **有限値だけを渡すこと**（非有限値は弾かずに `Infinityfpm` / `NaNfpm` を返す）。
 * 絞るのは呼び出し側の仕事: サーバーは `estimate.ts` の `finiteOrUndefined`（非有限なら evidence の行自体を出さない）、
 * クライアントは `format.ts` の `isFiniteNumber`（非有限なら「—」）でガードしている
 */
export function formatFpm(fpm: number): string {
  const rounded = Math.round(fpm);
  return `${rounded === 0 ? 0 : rounded}fpm`;
}

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

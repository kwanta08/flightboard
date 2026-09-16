import { describe, expect, it } from "vitest";
import { CONFIDENCE_HIGH, CONFIDENCE_MEDIUM, VERTICAL_RATE_THRESHOLD_FPM, confidenceLabel } from "./estimate.ts";

describe("確度のしきい値", () => {
  it("高は 0.8 以上、中は 0.5 以上（1 箇所にだけ置く）", () => {
    expect(CONFIDENCE_HIGH).toBe(0.8);
    expect(CONFIDENCE_MEDIUM).toBe(0.5);
  });
});

describe("AC-P2-24: confidenceLabel", () => {
  it("滑走路が決まっていなければラベルを出さない（confidence によらず undefined）", () => {
    for (const confidence of [0, 0.3, 0.5, 0.9, 1]) {
      expect(confidenceLabel(confidence, false)).toBeUndefined();
    }
  });

  it("しきい値ちょうどは上の段（0.8 → 高、0.5 → 中）", () => {
    expect(confidenceLabel(CONFIDENCE_HIGH, true)).toBe("高");
    expect(confidenceLabel(CONFIDENCE_MEDIUM, true)).toBe("中");
  });

  it("しきい値をわずかに下回れば下の段", () => {
    expect(confidenceLabel(0.79, true)).toBe("中");
    expect(confidenceLabel(0.49, true)).toBe("低");
  });

  // plan の confidence 表（素点と、食い違いで 0.2 引いたあとの値）が一意にラベルへ落ちること
  it.each([
    [0.9, "高"],
    [0.7, "中"],
    [0.6, "中"],
    [0.4, "低"],
    [0.3, "低"],
    [0.1, "低"],
  ] as const)("confidence %s は「%s」", (confidence, label) => {
    expect(confidenceLabel(confidence, true)).toBe(label);
  });

  it("非有限（NaN）は「低」に倒す", () => {
    expect(confidenceLabel(Number.NaN, true)).toBe("低");
  });
});

// W9 MINOR-2: クライアント（`format.ts` の verticalTrend）とサーバー（`phase.ts` のフェーズ判定・
// `runway.ts` の候補条件）が同じ値を読むよう、定義をここ 1 箇所に集めた
describe("昇降のしきい値", () => {
  it("上昇／下降／水平の境界は 200fpm（1 箇所にだけ置く）", () => {
    expect(VERTICAL_RATE_THRESHOLD_FPM).toBe(200);
  });
});

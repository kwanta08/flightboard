import { describe, expect, it } from "vitest";
import { CONFIDENCE_HIGH, CONFIDENCE_MEDIUM } from "../../shared/estimate.ts";
import type { Flight } from "../../shared/types.ts";
import {
  buildEstimateBadge,
  CONFIDENCE_PREFIX,
  ENROUTE_BADGE_TEXT,
  ESTIMATE_BADGE_CLASS,
  ESTIMATE_BADGE_LABEL_PREFIX,
  RUNWAY_PREFIX,
} from "./estimateView.ts";

type Estimate = NonNullable<Flight["estimate"]>;

// 11,000m ≒ 36,089ft（0.3048 m/ft）。通過のバッジの「巡航 11,000m」に使う
const CRUISE_11000M_FT = 36_089;

const HND: Estimate["airport"] = { icao: "RJTT", name: "羽田" };
const NRT: Estimate["airport"] = { icao: "RJAA", name: "成田" };

function makeFlight(estimate: Flight["estimate"], altitudeGeomFt = 3000): Flight {
  return {
    hex: "86e7a0",
    position: { lat: 35.552299, lon: 139.779999, altitudeBaroFt: null, altitudeGeomFt, onGround: false },
    isMlat: false,
    seenPosSec: 0,
    kind: "passenger",
    source: "adsblol",
    estimate,
  };
}

function badgeTextOf(estimate: Flight["estimate"], altitudeGeomFt?: number): string | undefined {
  return buildEstimateBadge(makeFlight(estimate, altitudeGeomFt))?.text;
}

describe("buildEstimateBadge: 生成規則表のバッジ文言（AC-P2-50）", () => {
  it("滑走路が決まった進入: 「HND RWY22 進入 確度:高」", () => {
    expect(badgeTextOf({ phase: "arrival", airport: HND, runway: "22", confidence: 0.9, evidence: [] })).toBe(
      "HND RWY22 進入 確度:高",
    );
  });

  it("滑走路が決まった出発: 「HND RWY16L 出発 確度:中」", () => {
    expect(badgeTextOf({ phase: "departure", airport: HND, runway: "16L", confidence: 0.6, evidence: [] })).toBe(
      "HND RWY16L 出発 確度:中",
    );
  });

  it("滑走路が決まらない進入: 「HND 進入」（確度ラベルなし）", () => {
    expect(badgeTextOf({ phase: "arrival", airport: HND, confidence: 0.5, evidence: [] })).toBe("HND 進入");
  });

  it("滑走路が決まらない出発: 「HND 出発」（確度ラベルなし）", () => {
    expect(badgeTextOf({ phase: "departure", airport: HND, confidence: 0.3, evidence: [] })).toBe("HND 出発");
  });

  it("通過: 「通過（巡航 11,000m）」（高度は機体の位置から。既定の m で出す）", () => {
    expect(badgeTextOf({ phase: "enroute", confidence: 0.5, evidence: [] }, CRUISE_11000M_FT)).toBe(
      "通過（巡航 11,000m）",
    );
  });

  it("estimate が無い機体にはバッジを出さない", () => {
    expect(buildEstimateBadge(makeFlight(undefined))).toBeUndefined();
  });

  it("phase が unknown の推定にはバッジを出さない（サーバーは付けないが、受け取っても出さない）", () => {
    expect(buildEstimateBadge(makeFlight({ phase: "unknown", confidence: 0.3, evidence: [] }))).toBeUndefined();
  });

  it("成田は NRT で出す（空港の短縮コードは src/shared/airports.ts から引く）", () => {
    expect(badgeTextOf({ phase: "arrival", airport: NRT, runway: "34L", confidence: 0.9, evidence: [] })).toBe(
      "NRT RWY34L 進入 確度:高",
    );
  });

  it("表に無い ICAO はそのまま出す（推測で埋めない）", () => {
    expect(
      badgeTextOf({ phase: "arrival", airport: { icao: "RJBB", name: "関西" }, confidence: 0.5, evidence: [] }),
    ).toBe("RJBB 進入");
  });

  it("空港が無い進入では空港を省く（決まったものだけを繋ぐ）", () => {
    expect(badgeTextOf({ phase: "arrival", confidence: 0.3, evidence: [] })).toBe("進入");
  });

  it("高度が取れない通過では括弧ごと省く", () => {
    expect(
      buildEstimateBadge({
        estimate: { phase: "enroute", confidence: 0.5, evidence: [] },
        position: { lat: 35.5, lon: 139.7, altitudeBaroFt: null, onGround: false },
      })?.text,
    ).toBe(ENROUTE_BADGE_TEXT);
  });
});

describe("buildEstimateBadge: 確度は文字でも示す（AC-P2-51）", () => {
  // しきい値は src/shared/estimate.ts の confidenceLabel が持つ（クライアントでは持ち直さない）。
  // 食い違いで減点した後の値（0.7 / 0.4 / 0.1）も同じ規則で決まる
  it.each([
    [0.9, "高"],
    [CONFIDENCE_HIGH, "高"],
    [0.7, "中"],
    [0.6, "中"],
    [CONFIDENCE_MEDIUM, "中"],
    [0.4, "低"],
    [0.3, "低"],
    [0.1, "低"],
  ])("confidence %s → 「確度:%s」", (confidence, label) => {
    const badge = buildEstimateBadge(
      makeFlight({ phase: "arrival", airport: HND, runway: "22", confidence, evidence: [] }),
    );
    expect(badge?.confidence).toBe(label);
    expect(badge?.text).toBe(`HND ${RUNWAY_PREFIX}22 進入 ${CONFIDENCE_PREFIX}${label}`);
  });

  it.each([
    ["arrival" as const, 0.9],
    ["arrival" as const, 0.5],
    ["enroute" as const, 0.5],
  ])("滑走路が決まっていなければ確度を出さない（%s・confidence %s）", (phase, confidence) => {
    const badge = buildEstimateBadge(makeFlight({ phase, airport: HND, confidence, evidence: [] }));
    expect(badge?.confidence).toBeUndefined();
    expect(badge?.text).not.toContain(CONFIDENCE_PREFIX);
  });

  it("確度は色（クラス名）だけでなく、必ず文字でも出る", () => {
    const badge = buildEstimateBadge(
      makeFlight({ phase: "arrival", airport: HND, runway: "22", confidence: 0.9, evidence: [] }),
    );
    expect(badge?.className).toBe(`${ESTIMATE_BADGE_CLASS} ${ESTIMATE_BADGE_CLASS}--high`);
    expect(badge?.text).toContain("確度:高");
  });

  it("確度ラベルが無いバッジのクラス名は基本のものだけ", () => {
    expect(buildEstimateBadge(makeFlight({ phase: "arrival", airport: HND, confidence: 0.5, evidence: [] }))?.className).toBe(
      ESTIMATE_BADGE_CLASS,
    );
  });

  it.each([
    [0.9, "--high"],
    [0.6, "--medium"],
    [0.3, "--low"],
  ])("confidence %s のクラス名は %s を含む", (confidence, modifier) => {
    expect(
      buildEstimateBadge(makeFlight({ phase: "arrival", airport: HND, runway: "22", confidence, evidence: [] }))
        ?.className,
    ).toContain(`${ESTIMATE_BADGE_CLASS}${modifier}`);
  });
});

describe("buildEstimateBadge: 読み上げ", () => {
  it("アクセシブルネームは「推定」で始まり、見える文字をそのまま含む", () => {
    const badge = buildEstimateBadge(
      makeFlight({ phase: "departure", airport: HND, runway: "16L", confidence: 0.6, evidence: [] }),
    );
    expect(badge?.label).toBe(`${ESTIMATE_BADGE_LABEL_PREFIX} HND RWY16L 出発 確度:中`);
  });

  it("通過のバッジにも「推定」を添える", () => {
    expect(buildEstimateBadge(makeFlight({ phase: "enroute", confidence: 0.5, evidence: [] }, CRUISE_11000M_FT))?.label).toBe(
      `${ESTIMATE_BADGE_LABEL_PREFIX} 通過（巡航 11,000m）`,
    );
  });
});

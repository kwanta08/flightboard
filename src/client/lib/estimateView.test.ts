import { describe, expect, it } from "vitest";
import { CONFIDENCE_HIGH, CONFIDENCE_MEDIUM } from "../../shared/estimate.ts";
import { aircraftAltitudeM } from "../../shared/geo.ts";
import type { AirportOps, Flight } from "../../shared/types.ts";
import { finiteOrUndefined } from "./format.ts";
import {
  AIRPORT_OPS_PENDING_TEXT,
  airportConfigLabel,
  airportOpsText,
  buildAirportOpsHeader,
  buildEstimateBadge,
  buildEstimateSection,
  CONFIDENCE_PREFIX,
  ENROUTE_BADGE_TEXT,
  ESTIMATE_BADGE_CLASS,
  ESTIMATE_BADGE_LABEL_PREFIX,
  ESTIMATE_SECTION_TITLE,
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

/** 一覧の行と同じ呼び方（`buildEstimateBadge` は高度を自分で計算せず、行が計算した m を受け取る） */
function badgeOf(flight: Pick<Flight, "estimate" | "position">) {
  return buildEstimateBadge(flight.estimate, finiteOrUndefined(aircraftAltitudeM(flight.position)));
}

function badgeTextOf(estimate: Flight["estimate"], altitudeGeomFt?: number): string | undefined {
  return badgeOf(makeFlight(estimate, altitudeGeomFt))?.text;
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
    expect(badgeOf(makeFlight(undefined))).toBeUndefined();
  });

  it("phase が unknown の推定にはバッジを出さない（サーバーは付けないが、受け取っても出さない）", () => {
    expect(badgeOf(makeFlight({ phase: "unknown", confidence: 0.3, evidence: [] }))).toBeUndefined();
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
      badgeOf({
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
    const badge = badgeOf(
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
    const badge = badgeOf(makeFlight({ phase, airport: HND, confidence, evidence: [] }));
    expect(badge?.confidence).toBeUndefined();
    expect(badge?.text).not.toContain(CONFIDENCE_PREFIX);
  });

  it("確度は色（クラス名）だけでなく、必ず文字でも出る", () => {
    const badge = badgeOf(
      makeFlight({ phase: "arrival", airport: HND, runway: "22", confidence: 0.9, evidence: [] }),
    );
    expect(badge?.className).toBe(`${ESTIMATE_BADGE_CLASS} ${ESTIMATE_BADGE_CLASS}--high`);
    expect(badge?.text).toContain("確度:高");
  });

  it("確度ラベルが無いバッジのクラス名は基本のものだけ", () => {
    expect(badgeOf(makeFlight({ phase: "arrival", airport: HND, confidence: 0.5, evidence: [] }))?.className).toBe(
      ESTIMATE_BADGE_CLASS,
    );
  });

  it.each([
    [0.9, "--high"],
    [0.6, "--medium"],
    [0.3, "--low"],
  ])("confidence %s のクラス名は %s を含む", (confidence, modifier) => {
    expect(
      badgeOf(makeFlight({ phase: "arrival", airport: HND, runway: "22", confidence, evidence: [] }))
        ?.className,
    ).toContain(`${ESTIMATE_BADGE_CLASS}${modifier}`);
  });
});

describe("buildEstimateBadge: 読み上げ", () => {
  it("アクセシブルネームは「推定」で始まり、見える文字をそのまま含む", () => {
    const badge = badgeOf(
      makeFlight({ phase: "departure", airport: HND, runway: "16L", confidence: 0.6, evidence: [] }),
    );
    expect(badge?.label).toBe(`${ESTIMATE_BADGE_LABEL_PREFIX} HND RWY16L 出発 確度:中`);
  });

  it("通過のバッジにも「推定」を添える", () => {
    expect(badgeOf(makeFlight({ phase: "enroute", confidence: 0.5, evidence: [] }, CRUISE_11000M_FT))?.label).toBe(
      `${ESTIMATE_BADGE_LABEL_PREFIX} 通過（巡航 11,000m）`,
    );
  });
});

describe("buildEstimateBadge: enroute に滑走路が付いた応答（W4 コードレビュー MINOR-3）", () => {
  // 候補探索は phase が arrival / departure のときだけ行う（AC-P2-19）ので、サーバーはこの形を返さない。
  // 受け取っても「文字は確度なし・色は確度あり」にはしない（色だけが確度を伝える状態を作らない）
  it("確度ラベルもクラス名の色も付けない", () => {
    const badge = badgeOf(
      makeFlight({ phase: "enroute", runway: "22", confidence: 0.9, evidence: [] }, CRUISE_11000M_FT),
    );
    expect(badge?.text).toBe("通過（巡航 11,000m）");
    expect(badge?.confidence).toBeUndefined();
    expect(badge?.className).toBe(ESTIMATE_BADGE_CLASS);
  });
});

describe("ヘッダーの運用方向（AC-P2-52）", () => {
  const UPDATED_AT = "2026-09-16T00:00:00.000Z";

  function ops(icao: string, configLabel?: string): AirportOps {
    return {
      icao,
      landingRunways: ["22"],
      departingRunways: ["16L"],
      ...(configLabel === undefined ? {} : { configLabel }),
      basedOn: 3,
      updatedAt: UPDATED_AT,
    };
  }

  it("対象空港を常時表示する（「羽田: 南風運用 / 成田: 北風運用」）", () => {
    expect(buildAirportOpsHeader([ops("RJTT", "南風運用"), ops("RJAA", "北風運用")])).toBe(
      "羽田: 南風運用 / 成田: 北風運用",
    );
  });

  it("集計に無い空港は「判定中」（出さないのではなく常時出す）", () => {
    expect(buildAirportOpsHeader([ops("RJTT", "南風運用")])).toBe("羽田: 南風運用 / 成田: 判定中");
  });

  it.each([[undefined], [[] as AirportOps[]]])("集計がまだ無ければ（%s）どちらも「判定中」", (airportOps) => {
    expect(buildAirportOpsHeader(airportOps)).toBe(
      `羽田: ${AIRPORT_OPS_PENDING_TEXT} / 成田: ${AIRPORT_OPS_PENDING_TEXT}`,
    );
  });

  it("configLabel が付かない集計（対応表に無い滑走路）も「判定中」", () => {
    expect(buildAirportOpsHeader([ops("RJTT"), ops("RJAA", " ")])).toBe("羽田: 判定中 / 成田: 判定中");
  });

  it("空港の表示名は src/shared/airports.ts から引く。表に無い ICAO はそのまま出す", () => {
    expect(airportOpsText("RJTT", [ops("RJTT", "南風運用")])).toBe("羽田: 南風運用");
    expect(airportOpsText("RJBB", [ops("RJBB", "南風運用")])).toBe("RJBB: 南風運用");
  });
});

describe("airportConfigLabel: 空港の運用方向", () => {
  const OPS: AirportOps[] = [
    { icao: "RJTT", landingRunways: ["22"], departingRunways: [], configLabel: "南風運用", basedOn: 2, updatedAt: "2026-09-16T00:00:00.000Z" },
  ];

  it("その空港の configLabel を返す", () => {
    expect(airportConfigLabel("RJTT", OPS)).toBe("南風運用");
  });

  it.each([["RJAA"], [undefined], [" "]])("集計に無い空港（%s）は undefined", (icao) => {
    expect(airportConfigLabel(icao, OPS)).toBeUndefined();
  });

  it("集計そのものが無ければ undefined", () => {
    expect(airportConfigLabel("RJTT", undefined)).toBeUndefined();
  });
});

describe("buildEstimateSection: 詳細の「経路」（AC-P2-53・S-03）", () => {
  const OPS: AirportOps[] = [
    { icao: "RJTT", landingRunways: ["22", "23"], departingRunways: ["16L"], configLabel: "南風運用", basedOn: 5, updatedAt: "2026-09-16T00:00:00.000Z" },
  ];
  const EVIDENCE = ["方位のズレ 0.3°", "滑走路まで 10.7km", "降下中 −704fpm"];

  function itemsOf(estimate: Flight["estimate"], airportOps?: AirportOps[]) {
    const section = buildEstimateSection(estimate, airportOps);
    return new Map(section?.items.map((item) => [item.label, item.value]));
  }

  it("区分は「経路」で、項目はフェーズ・空港・滑走路・運用方向・確度の順", () => {
    const section = buildEstimateSection(
      { phase: "arrival", airport: HND, runway: "22", confidence: 0.9, evidence: EVIDENCE },
      OPS,
    );
    expect(section?.title).toBe(ESTIMATE_SECTION_TITLE);
    expect(section?.items).toEqual([
      { label: "推定フェーズ", value: "進入" },
      { label: "空港", value: "羽田" },
      { label: "滑走路", value: "RWY22" },
      { label: "運用方向", value: "南風運用" },
      { label: "確度", value: "高" },
    ]);
  });

  it("evidence の各行が根拠として列挙される（S-03「経路推定の根拠を開示する」）", () => {
    const section = buildEstimateSection({ phase: "arrival", airport: HND, runway: "22", confidence: 0.9, evidence: EVIDENCE }, OPS);
    expect(section?.notes).toEqual(EVIDENCE);
  });

  it("evidence が空なら根拠は空（区分は出す）", () => {
    const section = buildEstimateSection({ phase: "enroute", confidence: 0.5, evidence: [] });
    expect(section?.notes).toEqual([]);
  });

  it("推定が無い機体では区分ごと出さない", () => {
    expect(buildEstimateSection(undefined, OPS)).toBeUndefined();
  });

  it("「一致度」は出さない（レベル2 の項目）", () => {
    const section = buildEstimateSection({ phase: "arrival", airport: HND, runway: "22", confidence: 0.9, evidence: [] }, OPS);
    expect(section?.items.map((item) => item.label)).not.toContain("一致度");
  });

  it("運用方向は推定した空港の集計から引く（集計に無ければ「—」）", () => {
    expect(itemsOf({ phase: "arrival", airport: NRT, runway: "34L", confidence: 0.9, evidence: [] }, OPS).get("運用方向")).toBe("—");
    expect(itemsOf({ phase: "arrival", airport: HND, runway: "22", confidence: 0.9, evidence: [] }).get("運用方向")).toBe("—");
  });

  it("滑走路が決まらない進入では滑走路と確度が「—」", () => {
    const items = itemsOf({ phase: "arrival", airport: HND, confidence: 0.5, evidence: [] }, OPS);
    expect(items.get("滑走路")).toBe("—");
    expect(items.get("確度")).toBe("—");
    expect(items.get("運用方向")).toBe("南風運用");
  });

  it("通過は「通過」、空港が無ければ「—」", () => {
    const items = itemsOf({ phase: "enroute", confidence: 0.5, evidence: [] }, OPS);
    expect(items.get("推定フェーズ")).toBe("通過");
    expect(items.get("空港")).toBe("—");
  });

  it("phase が unknown なら「—」（サーバーは推定を付けないが、受け取っても断定しない）", () => {
    expect(itemsOf({ phase: "unknown", confidence: 0.3, evidence: [] }, OPS).get("推定フェーズ")).toBe("—");
  });

  it("空港の表示名は src/shared/airports.ts から引く。表に無ければ推定の名前、それも無ければ ICAO", () => {
    expect(itemsOf({ phase: "arrival", airport: NRT, confidence: 0.5, evidence: [] }).get("空港")).toBe("成田");
    expect(itemsOf({ phase: "arrival", airport: { icao: "RJBB", name: "関西" }, confidence: 0.5, evidence: [] }).get("空港")).toBe("関西");
    expect(itemsOf({ phase: "arrival", airport: { icao: "RJBB", name: " " }, confidence: 0.5, evidence: [] }).get("空港")).toBe("RJBB");
  });

  it("出発の確度も滑走路が決まったときだけ出す", () => {
    expect(itemsOf({ phase: "departure", airport: HND, runway: "16L", confidence: 0.6, evidence: [] }, OPS).get("確度")).toBe("中");
  });
});

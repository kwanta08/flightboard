import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FT_TO_M, bearingDeg, haversineKm } from "../../shared/geo.ts";
import { MAGNETIC_VARIATION_DEG, RUNWAY_CONFIGS, TARGET_AIRPORTS } from "./airports.ts";
import { LENGTH_TOLERANCE, type RunwayEnd } from "./importRunways.ts";
import { KNOWN_LENGTH_MISMATCHES, RUNWAY_ENDS, runwayEndsFor } from "./runways.ts";

/** 対向端（相互参照が壊れていれば例外で落ちる） */
function oppositeOf(end: RunwayEnd): RunwayEnd {
  const opposite = RUNWAY_ENDS.find((other) => other.icao === end.icao && other.ident === end.oppositeIdent);
  if (!opposite) {
    throw new Error(`${end.icao} ${end.ident} の対向端 ${end.oppositeIdent} が RUNWAY_ENDS に無い`);
  }
  return opposite;
}

/** 滑走路端の真方位。データには持たず、自端 → 対向端の座標から計算する（AC-P2-01） */
function trueBearingDeg(end: RunwayEnd): number {
  return bearingDeg(end, oppositeOf(end));
}

/**
 * 指示子（磁方位を 10° に丸めたもの）と、座標から計算した真方位の食い違い（度、[-180, 180)）。
 * 真方位に磁気偏角（西偏）を足して磁方位に直してから、指示子の数字 × 10° と比べる。
 */
function identDeviationDeg(end: RunwayEnd): number {
  const magnetic = trueBearingDeg(end) + MAGNETIC_VARIATION_DEG;
  return ((magnetic - Number.parseInt(end.ident, 10) * 10 + 540) % 360) - 180;
}

/** 対向端どうしの距離が公示滑走路長からどれだけずれているか（比。+0.1 なら 10% 長い） */
function lengthDeviation(end: RunwayEnd): number {
  const publishedKm = (end.lengthFt ?? Number.NaN) * FT_TO_M / 1000;
  return haversineKm(end, oppositeOf(end)) / publishedKm - 1;
}

// 滑走路（対向する 2 端の組）。識別子の小さい側を代表に採る
const RUNWAYS = RUNWAY_ENDS.filter((end) => end.ident < end.oppositeIdent);

/** 滑走路の名前（`RJAA 16L/34R`）。既知の不一致との突き合わせのキーにする */
const runwayKey = (end: { icao: string; ident: string; oppositeIdent: string }): string =>
  `${end.icao} ${end.ident}/${end.oppositeIdent}`;

// 生成物のヘッダ（`// 既知の不一致: RJAA 16L/34R — ...` の行）から不一致を読み戻す。
// テストのローカル定数に例外を書かないための読み取りで、ヘッダ・KNOWN_LENGTH_MISMATCHES・実測の
// 3 つが一致していなければ落ちる（AC-P2-03 / AC-P2-05）。
const GENERATED_SOURCE = readFileSync(fileURLToPath(new URL("./runways.ts", import.meta.url)), "utf-8");
const HEADER = GENERATED_SOURCE.slice(0, GENERATED_SOURCE.indexOf("import type"));
const MISMATCHES_IN_HEADER = [...HEADER.matchAll(/^\/\/ 既知の不一致: (\S+) (\S+\/\S+) —/gm)].map(
  ([, icao, runway]) => `${icao} ${runway}`,
);

describe("AC-P2-01: 滑走路端のスナップショット", () => {
  it("羽田 RJTT は 8 端（16L / 16R / 34L / 34R / 04 / 22 / 05 / 23）", () => {
    expect(runwayEndsFor("RJTT").map((end) => end.ident).sort()).toEqual([
      "04", "05", "16L", "16R", "22", "23", "34L", "34R",
    ]);
  });

  it("成田 RJAA は 4 端（16L / 16R / 34L / 34R）", () => {
    expect(runwayEndsFor("RJAA").map((end) => end.ident).sort()).toEqual(["16L", "16R", "34L", "34R"]);
  });

  it("対象の 2 空港だけを持ち、合計 12 端", () => {
    expect(new Set(RUNWAY_ENDS.map((end) => end.icao))).toEqual(new Set(["RJTT", "RJAA"]));
    expect(RUNWAY_ENDS).toHaveLength(12);
  });

  it("同じ空港に同じ識別子の端が 2 つない", () => {
    const keys = RUNWAY_ENDS.map((end) => `${end.icao} ${end.ident}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("各端は緯度・経度・対向端の識別子・公示滑走路長を持つ（真方位は持たない）", () => {
    for (const end of RUNWAY_ENDS) {
      expect(Number.isFinite(end.lat)).toBe(true);
      expect(Number.isFinite(end.lon)).toBe(true);
      expect(end.oppositeIdent).not.toBe("");
      expect(end.lengthFt).toBeGreaterThan(0);
      expect(end).not.toHaveProperty("headingDegT");
    }
  });

  it("対向端どうしが相互に参照し合い、公示滑走路長も一致する", () => {
    for (const end of RUNWAY_ENDS) {
      const opposite = oppositeOf(end);
      expect(opposite.oppositeIdent).toBe(end.ident);
      expect(opposite.lengthFt).toBe(end.lengthFt);
    }
  });

  it("滑走路は 6 本（羽田 4・成田 2）で、すべての端が対で数えられる", () => {
    expect(RUNWAYS).toHaveLength(RUNWAY_ENDS.length / 2);
  });
});

describe("runwayEndsFor", () => {
  it("対象外の ICAO では空配列", () => {
    expect(runwayEndsFor("RJOO")).toEqual([]);
    expect(runwayEndsFor("")).toEqual([]);
  });

  it("返すのはその空港の端だけ", () => {
    expect(runwayEndsFor("RJAA").every((end) => end.icao === "RJAA")).toBe(true);
  });
});

describe("MAGNETIC_VARIATION_DEG", () => {
  it("東京付近の西偏 8°（指示子の磁方位と真方位を突き合わせるための見積り）", () => {
    expect(MAGNETIC_VARIATION_DEG).toBe(8);
  });

  // airports.ts の根拠コメントに書いた数字の検算。8 という値の出所は
  // (1) 東京付近の西偏が 7〜8° 程度という広く知られた値（一次情報では未検証）と、
  // (2) この 12 端の実データでの「指示子 × 10° − 座標から計算した真方位」の分布。
  it("12 端の「指示子 × 10° − 真方位」は 平均 8.9°・範囲 5.1°〜11.0°（8 はこの範囲の中にある）", () => {
    const diffs = RUNWAY_ENDS.map(
      (end) => ((Number.parseInt(end.ident, 10) * 10 - trueBearingDeg(end) + 540) % 360) - 180,
    );
    const mean = diffs.reduce((sum, diff) => sum + diff, 0) / diffs.length;
    expect(mean).toBeCloseTo(8.9, 1);
    expect(Math.min(...diffs)).toBeCloseTo(5.1, 1);
    expect(Math.max(...diffs)).toBeCloseTo(11.0, 1);
    expect(MAGNETIC_VARIATION_DEG).toBeGreaterThan(Math.min(...diffs));
    expect(MAGNETIC_VARIATION_DEG).toBeLessThan(Math.max(...diffs));
  });
});

describe("AC-P2-02: 指示子（磁方位）と、座標から計算した真方位", () => {
  // 許容 7° = 指示子の 10° 丸めの ±5° ＋ 磁気偏角の見積り誤差 ±2°。
  // 落とせるのは端の取り違え・符号の誤りといった十度単位の粗い誤りだけで、数十 m の座標誤差は見えない。
  it.each(RUNWAY_ENDS.map((end) => [`${end.icao} ${end.ident}`, end] as const))(
    "%s: |真方位 + 8° − 指示子 × 10°| ≤ 7°",
    (_name, end) => {
      expect(Math.abs(identDeviationDeg(end))).toBeLessThanOrEqual(7);
    },
  );

  it("対向端の真方位は互いに約 180° 違う", () => {
    for (const end of RUNWAYS) {
      const between = (((trueBearingDeg(end) - trueBearingDeg(oppositeOf(end))) % 360) + 360) % 360;
      expect(Math.abs(between - 180)).toBeLessThan(0.1);
    }
  });
});

describe("AC-P2-03: 対向端どうしの距離と公示滑走路長", () => {
  // 実際に ±10% を外れた滑走路（lengthFt が undefined の端は対象外）
  const outOfTolerance = RUNWAYS.filter(
    (end) => end.lengthFt !== undefined && Math.abs(lengthDeviation(end)) > LENGTH_TOLERANCE,
  );

  it("±10% を外れた滑走路の集合が、生成物の KNOWN_LENGTH_MISMATCHES と完全に一致する", () => {
    // 例外はテストのローカル定数ではなく生成物（取り込みの検出結果）にある。新しい不一致が出たら
    // ここが落ち、npm run import-runways で取り込み直して記録に載せるまで緑にならない。
    expect(outOfTolerance.map(runwayKey).sort()).toEqual(KNOWN_LENGTH_MISMATCHES.map(runwayKey).sort());
  });

  it("生成ファイルのヘッダが申告している不一致の集合も、実際に外れた集合と完全に一致する（AC-P2-05）", () => {
    expect(MISMATCHES_IN_HEADER.sort()).toEqual(outOfTolerance.map(runwayKey).sort());
  });

  it.each(
    RUNWAYS.filter((end) => !KNOWN_LENGTH_MISMATCHES.some((mismatch) => runwayKey(mismatch) === runwayKey(end))).map(
      (end) => [runwayKey(end), end] as const,
    ),
  )("%s: 端の間の距離が公示滑走路長の ±10%% に収まる", (_name, end) => {
    expect(Math.abs(lengthDeviation(end))).toBeLessThanOrEqual(LENGTH_TOLERANCE);
  });

  it.each(KNOWN_LENGTH_MISMATCHES.map((mismatch) => [runwayKey(mismatch), mismatch] as const))(
    "%s: 申告されているずれの値が、座標と公示滑走路長から計算した値と合う",
    (_name, mismatch) => {
      const end = RUNWAY_ENDS.find((other) => other.icao === mismatch.icao && other.ident === mismatch.ident);
      if (!end) {
        throw new Error(`${runwayKey(mismatch)} の端が RUNWAY_ENDS に無い`);
      }
      expect(end.oppositeIdent).toBe(mismatch.oppositeIdent);
      expect(haversineKm(end, oppositeOf(end))).toBeCloseTo(mismatch.endsApartKm, 2);
      expect(((end.lengthFt ?? Number.NaN) * FT_TO_M) / 1000).toBeCloseTo(mismatch.publishedKm, 2);
      expect(lengthDeviation(end)).toBeCloseTo(mismatch.deviation, 3);
      // 中心線の向きは動いていない（＝ずれは中心線に沿った方向）という記録の裏づけ
      expect(Math.max(Math.abs(identDeviationDeg(end)), Math.abs(identDeviationDeg(oppositeOf(end))))).toBeCloseTo(
        mismatch.identDeviationDeg,
        1,
      );
      expect(mismatch.identDeviationDeg).toBeLessThanOrEqual(7);
    },
  );

  it("不一致があるときは、生成物に「中心線に沿ったずれ」と「どちらの端が旧位置かは不明」が書かれている", () => {
    if (KNOWN_LENGTH_MISMATCHES.length === 0) {
      expect(HEADER).toContain("既知の不一致: なし");
      return;
    }
    expect(HEADER).toContain("滑走路中心線に沿った方向のずれ");
    expect(HEADER).toContain("どちらの端が旧位置かは判別できていない");
  });
});

describe("airports.ts との突き合わせ", () => {
  it("運用方向の対応表に出てくる滑走路は、すべてその空港の滑走路端にある", () => {
    for (const config of RUNWAY_CONFIGS) {
      const idents = new Set(runwayEndsFor(config.icao).map((end) => end.ident));
      for (const runway of [...config.landing, ...config.departing]) {
        expect({ icao: config.icao, label: config.label, runway, known: idents.has(runway) }).toEqual({
          icao: config.icao,
          label: config.label,
          runway,
          known: true,
        });
      }
    }
  });

  it("同じ空港・同じ滑走路・同じ用途が 2 つのラベルに出てこない（ラベルが一意に決まる）", () => {
    for (const use of ["landing", "departing"] as const) {
      const seen = new Set<string>();
      for (const config of RUNWAY_CONFIGS) {
        for (const runway of config[use]) {
          const key = `${config.icao} ${use} ${runway}`;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
      }
    }
  });

  it("空港の中心座標は、その空港の滑走路端から 5km 以内にある", () => {
    for (const airport of TARGET_AIRPORTS) {
      const ends = runwayEndsFor(airport.icao);
      expect(ends.length).toBeGreaterThan(0);
      for (const end of ends) {
        expect(haversineKm(airport, end)).toBeLessThan(5);
      }
    }
  });
});

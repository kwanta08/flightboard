// 運用方向の集計（AC-P2-30〜32 / 34 / 35）。純粋関数なので、記録と「現在時刻」を直接渡して確かめる。
import { describe, expect, it } from "vitest";
import { AIRPORT_OPS_WINDOW_MS, aggregateAirportOps } from "./airportOps.ts";
import type { AirportOpsEntry } from "./airportOps.ts";

const T0 = Date.UTC(2026, 8, 16, 0, 0, 0);
const ISO_T0 = new Date(T0).toISOString();

type EntryOverrides = { icao?: string; phase?: AirportOpsEntry["phase"]; at?: number };

/** 既定は RJTT への進入・T0 の記録 */
function entry(hex: string, runway: string, overrides: EntryOverrides = {}): AirportOpsEntry {
  return {
    hex,
    icao: overrides.icao ?? "RJTT",
    phase: overrides.phase ?? "arrival",
    runway,
    at: overrides.at ?? T0,
  };
}

/** 出発の記録 */
function departure(hex: string, runway: string, overrides: EntryOverrides = {}): AirportOpsEntry {
  return entry(hex, runway, { ...overrides, phase: "departure" });
}

describe("aggregateAirportOps: 滑走路の並び（AC-P2-30）", () => {
  it("機体数の多い順に並べ、同数なら滑走路識別子の昇順にする", () => {
    const entries = [
      entry("a1", "23"),
      entry("b2", "22"),
      entry("c3", "16R"),
      entry("d4", "22"),
      entry("e5", "16R"),
      departure("f6", "16L"),
      departure("g7", "16L"),
      departure("h8", "05"),
    ];

    const [ops] = aggregateAirportOps(entries, T0);
    // 着陸: 16R 2 機・22 2 機（同数なので識別子の昇順）→ 23 1 機
    expect(ops?.landingRunways).toEqual(["16R", "22", "23"]);
    // 出発: 16L 2 機 → 05 1 機
    expect(ops?.departingRunways).toEqual(["16L", "05"]);
  });

  it("着陸だけ・出発だけの空港では、もう一方が空配列になる", () => {
    const [ops] = aggregateAirportOps([entry("a1", "34L"), entry("b2", "34R")], T0);
    expect(ops?.landingRunways).toEqual(["34L", "34R"]);
    expect(ops?.departingRunways).toEqual([]);
  });
});

describe("aggregateAirportOps: 運用方向のラベル（AC-P2-31）", () => {
  it("着陸の最頻 1 本で対応表を引く（RJTT 22 着陸 → 南風運用）", () => {
    const entries = [entry("a1", "22"), entry("b2", "22"), entry("c3", "34L"), departure("d4", "34R")];
    const [ops] = aggregateAirportOps(entries, T0);
    expect(ops?.landingRunways).toEqual(["22", "34L"]);
    expect(ops?.configLabel).toBe("南風運用");
  });

  it("着陸が 0 件なら出発の最頻 1 本で引く（RJTT 05 出発 → 北風運用）", () => {
    const [ops] = aggregateAirportOps([departure("a1", "05"), departure("b2", "05"), departure("c3", "16R")], T0);
    expect(ops?.departingRunways).toEqual(["05", "16R"]);
    expect(ops?.configLabel).toBe("北風運用");
  });

  it("対応表に無い滑走路（RJTT 04 着陸）ならラベルを付けない（推測で埋めない）", () => {
    const [ops] = aggregateAirportOps([entry("a1", "04")], T0);
    expect(ops?.landingRunways).toEqual(["04"]);
    expect(ops).not.toHaveProperty("configLabel");
  });

  it("着陸が 1 件でもあれば、それが表に無いときに出発へは回らない（着陸 04・出発 16L）", () => {
    const [ops] = aggregateAirportOps([entry("a1", "04"), departure("b2", "16L")], T0);
    expect(ops).not.toHaveProperty("configLabel");
  });

  it("成田も同じ表で引く（RJAA 16L 着陸 → 南風運用）", () => {
    const [ops] = aggregateAirportOps([entry("a1", "16L", { icao: "RJAA" })], T0);
    expect(ops?.icao).toBe("RJAA");
    expect(ops?.configLabel).toBe("南風運用");
  });
});

describe("aggregateAirportOps: basedOn と updatedAt（AC-P2-32）", () => {
  it("basedOn はサンプル数ではなく機体数（hex のユニーク数）", () => {
    const entries = [
      entry("a1", "22"),
      entry("a1", "22", { at: T0 - 1000 }), // 同じ機体の古いサンプル
      entry("b2", "22"),
      departure("c3", "16L"),
    ];
    const [ops] = aggregateAirportOps(entries, T0);
    expect(ops?.basedOn).toBe(3);
  });

  it("updatedAt は集計時点の ISO8601", () => {
    const [ops] = aggregateAirportOps([entry("a1", "22")], T0);
    expect(ops?.updatedAt).toBe(ISO_T0);
    expect(ops?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("aggregateAirportOps: 同じ機体の重複（AC-P2-34）", () => {
  it("同じ hex が 10 分内に異なる滑走路で観測されたら、最新の 1 件だけを数える", () => {
    const entries = [
      entry("a1", "34L", { at: T0 - 120_000 }), // 2 分前は 34L
      entry("a1", "22", { at: T0 - 10_000 }), // 直近は 22（滑走路を変えた）
      entry("b2", "34L", { at: T0 - 60_000 }),
    ];
    const [ops] = aggregateAirportOps(entries, T0);
    expect(ops?.landingRunways).toEqual(["22", "34L"]); // 22 と 34L が 1 機ずつ（a1 を二重に数えない）
    expect(ops?.basedOn).toBe(2);
  });

  it("入力の順序によらず at が最新の 1 件を採る（新しい記録が先に並んでいても上書きされない）", () => {
    const entries = [entry("a1", "22", { at: T0 - 10_000 }), entry("a1", "34L", { at: T0 - 120_000 })];
    const [ops] = aggregateAirportOps(entries, T0);
    expect(ops?.landingRunways).toEqual(["22"]);
  });

  it("進入から出発に変わった機体は、最新の phase 側だけに数える", () => {
    const entries = [entry("a1", "22", { at: T0 - 120_000 }), departure("a1", "16L", { at: T0 - 10_000 })];
    const [ops] = aggregateAirportOps(entries, T0);
    expect(ops?.landingRunways).toEqual([]);
    expect(ops?.departingRunways).toEqual(["16L"]);
    expect(ops?.basedOn).toBe(1);
  });
});

describe("aggregateAirportOps: 10 分の窓（AC-P2-35）", () => {
  it("10 分ちょうどの記録は残し、超えた記録は集計から外す", () => {
    const entries = [
      entry("a1", "22", { at: T0 - AIRPORT_OPS_WINDOW_MS }),
      entry("b2", "34L", { at: T0 - AIRPORT_OPS_WINDOW_MS - 1 }),
    ];
    const [ops] = aggregateAirportOps(entries, T0);
    expect(ops?.landingRunways).toEqual(["22"]);
    expect(ops?.basedOn).toBe(1);
  });

  it("窓から外れた記録しか無い空港は出さない", () => {
    expect(aggregateAirportOps([entry("a1", "22", { at: T0 - AIRPORT_OPS_WINDOW_MS - 1 })], T0)).toEqual([]);
  });

  it("同じ機体の古い記録だけが窓から外れても、新しい記録は残る", () => {
    const entries = [
      entry("a1", "34L", { at: T0 - AIRPORT_OPS_WINDOW_MS - 1 }),
      entry("a1", "22", { at: T0 - 1000 }),
    ];
    const [ops] = aggregateAirportOps(entries, T0);
    expect(ops?.landingRunways).toEqual(["22"]);
  });
});

describe("aggregateAirportOps: 空港の分け方と出力の順", () => {
  it("空港ごとに分け、対象空港の順（RJTT → RJAA）で返す", () => {
    const entries = [
      entry("a1", "16L", { icao: "RJAA" }),
      entry("b2", "22"),
      departure("c3", "34R", { icao: "RJAA" }),
    ];
    const ops = aggregateAirportOps(entries, T0);
    expect(ops.map((o) => [o.icao, o.landingRunways, o.departingRunways, o.basedOn])).toEqual([
      ["RJTT", ["22"], [], 1],
      ["RJAA", ["16L"], ["34R"], 2],
    ]);
  });

  it("記録の無い空港は出さない（空の記録なら空配列）", () => {
    expect(aggregateAirportOps([], T0)).toEqual([]);
    expect(aggregateAirportOps([entry("a1", "22")], T0).map((o) => o.icao)).toEqual(["RJTT"]);
  });

  it("対象空港に無い ICAO の記録は捨てる", () => {
    expect(aggregateAirportOps([entry("a1", "16", { icao: "RJCC" })], T0)).toEqual([]);
    expect(aggregateAirportOps([entry("a1", "22")], T0, ["RJAA"])).toEqual([]);
  });

  it("応答の形は AirportOps（configLabel はあるときだけ）", () => {
    const [withLabel] = aggregateAirportOps([entry("a1", "22")], T0);
    expect(withLabel).toEqual({
      icao: "RJTT",
      landingRunways: ["22"],
      departingRunways: [],
      configLabel: "南風運用",
      basedOn: 1,
      updatedAt: ISO_T0,
    });

    const [withoutLabel] = aggregateAirportOps([entry("a1", "04")], T0);
    expect(Object.keys(withoutLabel ?? {})).toEqual(["icao", "landingRunways", "departingRunways", "basedOn", "updatedAt"]);
  });
});

// 対象空港の表（src/server/data/airports.ts）そのものの単体テスト。
// 滑走路端との突き合わせ（対応表の滑走路が実在するか・中心座標が端の近くにあるか）は
// src/server/data/runways.test.ts にある。ここでは引き方の規則だけを固める。
import { describe, expect, it } from "vitest";
import {
  MAGNETIC_VARIATION_DEG,
  RUNWAY_CONFIGS,
  TARGET_AIRPORTS,
  TARGET_AIRPORT_ICAOS,
  runwayConfigLabel,
  targetAirport,
} from "./airports.ts";

describe("targetAirport", () => {
  it("対象空港（羽田・成田）を中心座標つきで引ける", () => {
    expect(targetAirport("RJTT")).toEqual({ icao: "RJTT", lat: 35.552299, lon: 139.779999 });
    expect(targetAirport("RJAA")).toEqual({ icao: "RJAA", lat: 35.764702, lon: 140.386002 });
  });

  it("対象外の ICAO は undefined（推測で埋めない）", () => {
    expect(targetAirport("RJOO")).toBeUndefined();
    expect(targetAirport("RJBB")).toBeUndefined();
    expect(targetAirport("")).toBeUndefined();
  });

  it("ICAO は大文字で引く（小文字は対象外扱い）", () => {
    expect(targetAirport("rjtt")).toBeUndefined();
  });

  it("Object.prototype のキーでも undefined", () => {
    expect(targetAirport("constructor")).toBeUndefined();
    expect(targetAirport("toString")).toBeUndefined();
  });

  it("TARGET_AIRPORT_ICAOS は表の並び順の ICAO", () => {
    expect(TARGET_AIRPORT_ICAOS).toEqual(["RJTT", "RJAA"]);
    expect(TARGET_AIRPORT_ICAOS).toEqual(TARGET_AIRPORTS.map((airport) => airport.icao));
  });
});

describe("runwayConfigLabel", () => {
  it("表に有る滑走路からラベルを引ける（着陸）", () => {
    expect(runwayConfigLabel("RJTT", "22", "landing")).toBe("南風運用");
    expect(runwayConfigLabel("RJTT", "23", "landing")).toBe("南風運用");
    expect(runwayConfigLabel("RJTT", "34L", "landing")).toBe("北風運用");
    expect(runwayConfigLabel("RJAA", "16R", "landing")).toBe("南風運用");
    expect(runwayConfigLabel("RJAA", "34R", "landing")).toBe("北風運用");
  });

  it("表に有る滑走路からラベルを引ける（出発）", () => {
    expect(runwayConfigLabel("RJTT", "16L", "departing")).toBe("南風運用");
    expect(runwayConfigLabel("RJTT", "05", "departing")).toBe("北風運用");
    expect(runwayConfigLabel("RJAA", "34L", "departing")).toBe("北風運用");
  });

  it("羽田の 16L/16R への着陸は南風運用（spec F-10 2c の都心上空の進入）", () => {
    expect(runwayConfigLabel("RJTT", "16L", "landing")).toBe("南風運用");
    expect(runwayConfigLabel("RJTT", "16R", "landing")).toBe("南風運用");
  });

  it("着陸と出発は別の表として引く（用途が違えば結果も違う）", () => {
    // 羽田 34L は北風運用の着陸には出るが、出発（05 / 34R）には出ない
    expect(runwayConfigLabel("RJTT", "34L", "landing")).toBe("北風運用");
    expect(runwayConfigLabel("RJTT", "34L", "departing")).toBeUndefined();
    // 羽田 05 は逆に出発だけ
    expect(runwayConfigLabel("RJTT", "05", "landing")).toBeUndefined();
    expect(runwayConfigLabel("RJTT", "23", "departing")).toBeUndefined();
  });

  it("表に無い滑走路では undefined（推測で埋めない。spec §10.2 末尾）", () => {
    expect(runwayConfigLabel("RJTT", "09", "landing")).toBeUndefined();
    expect(runwayConfigLabel("RJAA", "22", "landing")).toBeUndefined();
    expect(runwayConfigLabel("RJTT", "", "landing")).toBeUndefined();
  });

  it("対象外の ICAO では undefined（他空港の同じ識別子に引きずられない）", () => {
    expect(runwayConfigLabel("RJOO", "34L", "landing")).toBeUndefined();
    expect(runwayConfigLabel("", "22", "landing")).toBeUndefined();
  });

  it("RUNWAY_CONFIGS の各行は空港・ラベルを持ち、着陸か出発のどちらかに滑走路がある", () => {
    for (const config of RUNWAY_CONFIGS) {
      expect(TARGET_AIRPORT_ICAOS).toContain(config.icao);
      expect(config.label).not.toBe("");
      expect(config.landing.length + config.departing.length).toBeGreaterThan(0);
    }
  });
});

describe("MAGNETIC_VARIATION_DEG", () => {
  it("生成物（runways.ts）ではなく手で保守するこのファイルにある", () => {
    // 値そのものの妥当性（12 端の実データとの整合）は runways.test.ts が検算する
    expect(MAGNETIC_VARIATION_DEG).toBe(8);
  });
});

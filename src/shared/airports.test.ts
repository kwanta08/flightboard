import { describe, expect, it } from "vitest";
import { AIRPORT_DISPLAY_NAMES, airportDisplayName } from "./airports.ts";

describe("AIRPORT_DISPLAY_NAMES", () => {
  it("対象は羽田と成田の 2 空港だけ", () => {
    expect(Object.keys(AIRPORT_DISPLAY_NAMES).sort()).toEqual(["RJAA", "RJTT"]);
  });

  it("RJTT は 羽田 / HND", () => {
    expect(AIRPORT_DISPLAY_NAMES.RJTT).toEqual({ shortName: "羽田", code: "HND" });
  });

  it("RJAA は 成田 / NRT", () => {
    expect(AIRPORT_DISPLAY_NAMES.RJAA).toEqual({ shortName: "成田", code: "NRT" });
  });
});

describe("airportDisplayName", () => {
  it("表にある ICAO は表示名を返す", () => {
    expect(airportDisplayName("RJTT")?.shortName).toBe("羽田");
    expect(airportDisplayName("RJAA")?.code).toBe("NRT");
  });

  it("表に無い ICAO は undefined（推測で埋めない）", () => {
    expect(airportDisplayName("RJOO")).toBeUndefined();
    expect(airportDisplayName("")).toBeUndefined();
  });

  it("Object.prototype のキー（constructor など）でも undefined", () => {
    expect(airportDisplayName("constructor")).toBeUndefined();
    expect(airportDisplayName("toString")).toBeUndefined();
  });

  it("小文字や前後の空白は引けない（呼び出し側が正規化する）", () => {
    expect(airportDisplayName("rjtt")).toBeUndefined();
    expect(airportDisplayName(" RJTT ")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { AIRLINE_CALLSIGN_RE, classifyAircraft } from "./classify.ts";
import {
  CARGO_AIRLINE_CODES,
  CARGO_AIRLINE_ICAO,
  KNOWN_AIRLINE_ICAO,
  PASSENGER_AIRCRAFT_TYPES,
  PASSENGER_AIRCRAFT_TYPE_CODES,
  PASSENGER_AIRLINE_CODES,
} from "./data/aircraftLists.ts";

const airborne = { onGround: false } as const;

describe("規則 1: 地上", () => {
  it("地上の航空会社便（ANA245・B763）は除外", () => {
    expect(classifyAircraft({ callsign: "ANA245", typeCode: "B763", onGround: true })).toBe("excluded");
  });

  it("地上の貨物便・不明機も除外", () => {
    expect(classifyAircraft({ callsign: "FDX5901", typeCode: "B763", onGround: true })).toBe("excluded");
    expect(classifyAircraft({ onGround: true })).toBe("excluded");
  });
});

describe("規則 2: dbFlags の軍用ビット", () => {
  it("dbFlags 1 は除外", () => {
    expect(classifyAircraft({ callsign: "ANA245", typeCode: "B763", dbFlags: 1, ...airborne })).toBe("excluded");
    expect(classifyAircraft({ callsign: "FDX5901", dbFlags: 1, ...airborne })).toBe("excluded");
    expect(classifyAircraft({ dbFlags: 1, ...airborne })).toBe("excluded");
  });

  it("dbFlags 8（LADD）は除外しない — 航空会社便なら passenger", () => {
    expect(classifyAircraft({ callsign: "ANA245", typeCode: "B763", dbFlags: 8, ...airborne })).toBe("passenger");
  });

  it("dbFlags 9（軍用＋LADD）は除外", () => {
    expect(classifyAircraft({ callsign: "ANA245", typeCode: "B763", dbFlags: 9, ...airborne })).toBe("excluded");
  });

  it("dbFlags 0・2・4・未指定は除外しない", () => {
    for (const dbFlags of [0, 2, 4, undefined]) {
      expect(classifyAircraft({ callsign: "ANA245", dbFlags, ...airborne })).toBe("passenger");
    }
  });

  it("地上かつ軍用フラグ（dbFlags 1）でも excluded", () => {
    expect(classifyAircraft({ callsign: "ANA245", dbFlags: 1, onGround: true })).toBe("excluded");
  });
});

describe("規則 3: 既知の航空会社", () => {
  it("ANA245 は passenger", () => {
    expect(classifyAircraft({ callsign: "ANA245", ...airborne })).toBe("passenger");
  });

  it("FDX5901 は cargo", () => {
    expect(classifyAircraft({ callsign: "FDX5901", ...airborne })).toBe("cargo");
  });

  it("貨物社が旅客機の機種でも cargo（FDX5901＋B763、WGN123＋B744）", () => {
    expect(classifyAircraft({ callsign: "FDX5901", typeCode: "B763", ...airborne })).toBe("cargo");
    expect(classifyAircraft({ callsign: "WGN123", typeCode: "B744", ...airborne })).toBe("cargo");
  });

  it("仕様の例示の貨物社（FDX UPS NCA GTI CLX）はすべて cargo", () => {
    for (const icao of ["FDX", "UPS", "NCA", "GTI", "CLX"]) {
      expect(classifyAircraft({ callsign: `${icao}100`, ...airborne })).toBe("cargo");
    }
  });

  it("実測の旅客航空会社（ADO ANA APJ BAW ITY JAL SFJ SKY SNJ）はすべて passenger", () => {
    for (const icao of ["ADO", "ANA", "APJ", "BAW", "ITY", "JAL", "SFJ", "SKY", "SNJ"]) {
      expect(classifyAircraft({ callsign: `${icao}1`, ...airborne })).toBe("passenger");
    }
  });

  it("追記したコードの代表（TOK123 は passenger、HKC456 は cargo）", () => {
    expect(classifyAircraft({ callsign: "TOK123", ...airborne })).toBe("passenger");
    expect(classifyAircraft({ callsign: "HKC456", ...airborne })).toBe("cargo");
  });

  it("旅客機以外の機種でも既知の航空会社なら passenger", () => {
    expect(classifyAircraft({ callsign: "JAC3741", typeCode: "AT46", ...airborne })).toBe("passenger");
  });
});

describe("規則 4: 旅客機の機種＋航空会社形式のコールサイン", () => {
  it("未知の航空会社 XYZ123＋B738 は passenger", () => {
    expect(classifyAircraft({ callsign: "XYZ123", typeCode: "B738", ...airborne })).toBe("passenger");
  });

  it("未知の航空会社 XYZ123＋GLF6 は other", () => {
    expect(classifyAircraft({ callsign: "XYZ123", typeCode: "GLF6", ...airborne })).toBe("other");
  });

  it("未知の航空会社 XYZ123 で機種が無ければ other", () => {
    expect(classifyAircraft({ callsign: "XYZ123", ...airborne })).toBe("other");
  });

  it("仕様の例示の機種（A20N A321 B738 B763 B789 E190 AT76 DH8D）はすべて passenger", () => {
    for (const typeCode of ["A20N", "A321", "B738", "B763", "B789", "E190", "AT76", "DH8D"]) {
      expect(classifyAircraft({ callsign: "XYZ123", typeCode, ...airborne })).toBe("passenger");
    }
  });

  it("旅客機の機種でもコールサインが航空会社形式でなければ other", () => {
    expect(classifyAircraft({ callsign: "JA123A", typeCode: "B738", ...airborne })).toBe("other");
    expect(classifyAircraft({ typeCode: "B738", ...airborne })).toBe("other");
  });
});

describe("規則 5: その他", () => {
  it("JA123A は other", () => {
    expect(classifyAircraft({ callsign: "JA123A", ...airborne })).toBe("other");
  });

  it("コールサイン無しは other", () => {
    expect(classifyAircraft({ ...airborne })).toBe("other");
    expect(classifyAircraft({ callsign: "", ...airborne })).toBe("other");
    expect(classifyAircraft({ callsign: "   ", typeCode: "B738", ...airborne })).toBe("other");
  });

  it("COSMO02＋KC2 は other", () => {
    expect(classifyAircraft({ callsign: "COSMO02", typeCode: "KC2", ...airborne })).toBe("other");
  });
});

describe("コールサインの形式", () => {
  it("末尾の英字は 2 文字まで（ANA245A・ANA245AB は passenger、ANA245ABC は other）", () => {
    expect(classifyAircraft({ callsign: "ANA245A", ...airborne })).toBe("passenger");
    expect(classifyAircraft({ callsign: "ANA245AB", ...airborne })).toBe("passenger");
    expect(classifyAircraft({ callsign: "ANA245ABC", ...airborne })).toBe("other");
  });

  it("数字は 1〜4 桁（ANA1・ANA1234 は passenger、ANA12345・ANA は other）", () => {
    expect(classifyAircraft({ callsign: "ANA1", ...airborne })).toBe("passenger");
    expect(classifyAircraft({ callsign: "ANA1234", ...airborne })).toBe("passenger");
    expect(classifyAircraft({ callsign: "ANA12345", ...airborne })).toBe("other");
    expect(classifyAircraft({ callsign: "ANA12345", typeCode: "B763", ...airborne })).toBe("other");
    expect(classifyAircraft({ callsign: "ANA", ...airborne })).toBe("other");
  });

  it("前後の空白があっても誤判定しない", () => {
    expect(classifyAircraft({ callsign: " ANA245 ", ...airborne })).toBe("passenger");
    expect(classifyAircraft({ callsign: "FDX5901  ", ...airborne })).toBe("cargo");
    expect(classifyAircraft({ callsign: "XYZ123 ", typeCode: " B738 ", ...airborne })).toBe("passenger");
    expect(classifyAircraft({ callsign: " JA123A ", typeCode: "B738", ...airborne })).toBe("other");
  });

  it("正規表現は §10.1 のとおり", () => {
    expect(AIRLINE_CALLSIGN_RE.source).toBe("^[A-Z]{3}\\d{1,4}[A-Z]{0,2}$");
  });
});

describe("リストの健全性", () => {
  const duplicates = (codes: readonly string[]) => codes.filter((code, i) => codes.indexOf(code) !== i);

  it("航空会社はすべて大文字英字 3 文字", () => {
    for (const code of [...PASSENGER_AIRLINE_CODES, ...CARGO_AIRLINE_CODES]) {
      expect(code).toMatch(/^[A-Z]{3}$/);
    }
  });

  it("機種はすべて大文字英数字（2〜4 文字、先頭は英字）", () => {
    for (const code of PASSENGER_AIRCRAFT_TYPE_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z0-9]{1,3}$/);
    }
  });

  it("各リストに重複が無く、旅客・貨物の航空会社が重ならない", () => {
    expect(duplicates(PASSENGER_AIRLINE_CODES)).toEqual([]);
    expect(duplicates(CARGO_AIRLINE_CODES)).toEqual([]);
    expect(duplicates(PASSENGER_AIRCRAFT_TYPE_CODES)).toEqual([]);
    expect(PASSENGER_AIRLINE_CODES.filter((code) => CARGO_AIRLINE_ICAO.has(code))).toEqual([]);
  });

  it("貨物リストはすべて既知航空会社リストに含まれる", () => {
    for (const code of CARGO_AIRLINE_ICAO) {
      expect(KNOWN_AIRLINE_ICAO.has(code)).toBe(true);
    }
  });

  it("Set は配列と同じ要素を持つ", () => {
    expect([...KNOWN_AIRLINE_ICAO].sort()).toEqual([...PASSENGER_AIRLINE_CODES, ...CARGO_AIRLINE_CODES].sort());
    expect([...CARGO_AIRLINE_ICAO].sort()).toEqual([...CARGO_AIRLINE_CODES].sort());
    expect([...PASSENGER_AIRCRAFT_TYPES].sort()).toEqual([...PASSENGER_AIRCRAFT_TYPE_CODES].sort());
  });

  it("件数の目安（既知航空会社 70 社以上、貨物 20 社以上）", () => {
    expect(KNOWN_AIRLINE_ICAO.size).toBeGreaterThanOrEqual(70);
    expect(CARGO_AIRLINE_ICAO.size).toBeGreaterThanOrEqual(20);
  });

  it("仕様の例示と実測のコードを含む", () => {
    for (const code of ["FDX", "UPS", "NCA", "GTI", "CLX", "WGN"]) expect(CARGO_AIRLINE_ICAO.has(code)).toBe(true);
    for (const code of ["ADO", "ANA", "APJ", "BAW", "ITY", "JAL", "SFJ", "SKY", "SNJ", "WGN"]) {
      expect(KNOWN_AIRLINE_ICAO.has(code)).toBe(true);
    }
    const types = ["A20N", "A321", "B738", "B763", "B789", "E190", "AT76", "DH8D"];
    const observedTypes = ["A20N", "A21N", "A320", "A359", "A35K", "B737", "B738", "B744", "B763", "B77W", "B788", "B789"];
    for (const code of [...types, ...observedTypes]) expect(PASSENGER_AIRCRAFT_TYPES.has(code)).toBe(true);
  });
});

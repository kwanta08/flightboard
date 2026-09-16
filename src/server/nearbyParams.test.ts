import { describe, expect, it } from "vitest";
import type { Flight } from "../shared/types.ts";
import { parseNearbyParams } from "./nearbyParams.ts";
import type { NearbyParams } from "./nearbyParams.ts";
import { kmToUpstreamNm } from "./providers/provider.ts";

type Query = Record<string, string | undefined>;

const BASE: Query = { lat: "35.87", lon: "139.93" };

function ok(query: Query): NearbyParams {
  const result = parseNearbyParams(query);
  if (!result.ok) throw new Error(`受理されるはずが不可になった: ${result.error}`);
  return result.value;
}

/** 不可になり、エラーメッセージがパラメータ名を含むこと */
function expectRejected(query: Query, param: string): void {
  const result = parseNearbyParams(query);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(typeof result.error).toBe("string");
  expect(result.error).toContain(param);
}

function sorted(kinds: Set<Flight["kind"]>): Flight["kind"][] {
  return [...kinds].sort();
}

describe("正常系の応答形", () => {
  it("lat・lon だけ → 既定値（radiusKm 50、radiusNm 27、kinds passenger,cargo）", () => {
    const result = parseNearbyParams(BASE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lat).toBe(35.87);
    expect(result.value.lon).toBe(139.93);
    expect(result.value.radiusKm).toBe(50);
    expect(result.value.radiusNm).toBe(27);
    expect(sorted(result.value.kinds)).toEqual(["cargo", "passenger"]);
  });

  it("すべて指定", () => {
    const value = ok({ lat: "-12.5", lon: "-45.25", radiusKm: "25", kinds: "other,passenger" });
    expect(value).toMatchObject({ lat: -12.5, lon: -45.25, radiusKm: 25, radiusNm: 14 });
    expect(sorted(value.kinds)).toEqual(["other", "passenger"]);
  });
});

describe("lat", () => {
  it.each(["-90", "90"])("%s を受理", (lat) => {
    expect(ok({ ...BASE, lat }).lat).toBe(Number(lat));
  });

  it.each([
    ["90.0001", "範囲外"],
    ["-90.0001", "範囲外"],
    ["", "空文字"],
    ["abc", "非数値"],
    ["1e1", "指数表記"],
    [" 35", "先頭空白"],
    ["35 ", "末尾空白"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["+35", "+ 符号"],
    ["35.", "小数点の後に数字無し"],
    [".5", "小数点の前に数字無し"],
    ["0x10", "16 進"],
  ])("%j は不可（%s）", (lat) => {
    expectRejected({ ...BASE, lat }, "lat");
  });

  it("欠落は不可", () => {
    expectRejected({ lon: "139.93" }, "lat");
  });

  it("値が undefined も欠落として不可", () => {
    expectRejected({ lat: undefined, lon: "139.93" }, "lat");
  });

  it('"-0" は受理し、値は -0 ではなく 0', () => {
    const { lat } = ok({ ...BASE, lat: "-0" });
    expect(Object.is(lat, 0)).toBe(true);
  });

  it("数字 400 桁は不可", () => {
    expectRejected({ ...BASE, lat: "1" + "0".repeat(400) }, "lat");
  });

  it('先頭 0 付きの "0035.5" は 35.5 として受理', () => {
    expect(ok({ ...BASE, lat: "0035.5" }).lat).toBe(35.5);
  });
});

describe("lon", () => {
  it.each(["-180", "180"])("%s を受理", (lon) => {
    expect(ok({ ...BASE, lon }).lon).toBe(Number(lon));
  });

  it.each(["180.0001", "-180.0001", "", "abc", "1e2"])("%j は不可", (lon) => {
    expectRejected({ ...BASE, lon }, "lon");
  });

  it("欠落は不可", () => {
    expectRejected({ lat: "35.87" }, "lon");
  });
});

describe("radiusKm", () => {
  it("省略 → 50", () => {
    expect(ok(BASE).radiusKm).toBe(50);
  });

  it("キーはあるが値が undefined → 50", () => {
    expect(ok({ ...BASE, radiusKm: undefined }).radiusKm).toBe(50);
  });

  it.each(["10", "100", "37.5"])("%s を受理", (radiusKm) => {
    expect(ok({ ...BASE, radiusKm }).radiusKm).toBe(Number(radiusKm));
  });

  it.each(["9.99", "100.01", "", "-50", "abc", "5e1", " 50"])("%j は不可", (radiusKm) => {
    expectRejected({ ...BASE, radiusKm }, "radiusKm");
  });
});

describe("radiusNm は kmToUpstreamNm と一致", () => {
  it.each(["10", "25", "50", "100", "37.5"])("radiusKm=%s", (radiusKm) => {
    const value = ok({ ...BASE, radiusKm });
    expect(value.radiusNm).toBe(kmToUpstreamNm(Number(radiusKm)));
  });

  it("50km → 27nm", () => {
    expect(ok({ ...BASE, radiusKm: "50" }).radiusNm).toBe(27);
  });
});

describe("kinds", () => {
  it("省略 → {passenger, cargo}", () => {
    expect(sorted(ok(BASE).kinds)).toEqual(["cargo", "passenger"]);
  });

  it("キーはあるが値が undefined → {passenger, cargo}", () => {
    expect(sorted(ok({ ...BASE, kinds: undefined }).kinds)).toEqual(["cargo", "passenger"]);
  });

  it.each([
    ["cargo", ["cargo"]],
    ["PASSENGER", ["passenger"]],
    ["cargo,cargo", ["cargo"]],
    [" cargo ", ["cargo"]],
    ["other", ["other"]],
    ["passenger, Cargo ,OTHER", ["cargo", "other", "passenger"]],
  ])("%j → %j", (kinds, expected) => {
    expect(sorted(ok({ ...BASE, kinds }).kinds)).toEqual(expected);
  });

  it.each([
    ["", "空文字"],
    ["passenger,", "末尾の空要素"],
    [",cargo", "先頭の空要素"],
    ["passenger,,cargo", "途中の空要素"],
    [" , ", "空白だけの要素"],
    ["foo", "未知の値"],
    ["passenger,foo", "未知の値を含む"],
    ["excluded", "判定結果の excluded は種類ではない"],
  ])("%j は不可（%s）", (kinds) => {
    expectRejected({ ...BASE, kinds }, "kinds");
  });

  it("省略時の Set は呼び出しごとに別物（書き換えが次の呼び出しに漏れない）", () => {
    const first = ok(BASE);
    first.kinds.add("other");
    expect(sorted(ok(BASE).kinds)).toEqual(["cargo", "passenger"]);
  });
});

describe("エラーメッセージ", () => {
  it("日本語で、不正なパラメータ名を含む", () => {
    const result = parseNearbyParams({ ...BASE, radiusKm: "abc" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("radiusKm");
    expect(result.error).toMatch(/[぀-ヿ一-鿿]/);
  });

  it("複数が不正なら最初（lat → lon → radiusKm → kinds の順）を報告する", () => {
    expectRejected({ lat: "abc", lon: "abc", radiusKm: "abc", kinds: "foo" }, "lat");
    expectRejected({ lat: "35", lon: "abc", radiusKm: "abc", kinds: "foo" }, "lon");
    expectRejected({ lat: "35", lon: "139", radiusKm: "abc", kinds: "foo" }, "radiusKm");
  });
});

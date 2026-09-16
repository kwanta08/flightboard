import { describe, expect, it } from "vitest";
import {
  accessStorage,
  formatLocationHeader,
  LOCATION_STORAGE_KEY,
  loadLocation,
  parseElevationInput,
  saveLocation,
  type LocationStorage,
} from "./locationStore.ts";

/** Map で中身を持つ偽の storage */
function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  const storage: LocationStorage = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
  return { storage, items };
}

/** 指定した生の文字列が保存されている storage */
function storageWithRaw(raw: string): LocationStorage {
  return memoryStorage({ [LOCATION_STORAGE_KEY]: raw }).storage;
}

const NAGAREYAMA = { lat: 35.8709, lon: 139.9256, elevationM: 15 };

describe("LOCATION_STORAGE_KEY", () => {
  it("キーは flightboard.location.v1", () => {
    expect(LOCATION_STORAGE_KEY).toBe("flightboard.location.v1");
  });
});

describe("saveLocation / loadLocation", () => {
  it("保存した地点をそのまま読み込める（往復）", () => {
    const { storage } = memoryStorage();
    expect(saveLocation(storage, NAGAREYAMA)).toBe(true);
    expect(loadLocation(storage)).toEqual(NAGAREYAMA);
  });

  it("キー flightboard.location.v1 に JSON で保存する", () => {
    const { storage, items } = memoryStorage();
    saveLocation(storage, NAGAREYAMA);
    expect([...items.keys()]).toEqual(["flightboard.location.v1"]);
    expect(JSON.parse(items.get("flightboard.location.v1") ?? "")).toEqual(NAGAREYAMA);
  });

  it("別のキーに置かれた値は読まない", () => {
    const { storage } = memoryStorage({ "flightboard.location": JSON.stringify(NAGAREYAMA) });
    expect(loadLocation(storage)).toBeUndefined();
  });

  it("保存値が無ければ undefined", () => {
    expect(loadLocation(memoryStorage().storage)).toBeUndefined();
  });

  it("小数の標高も往復で保たれる", () => {
    const { storage } = memoryStorage();
    saveLocation(storage, { lat: -33.8688, lon: 151.2093, elevationM: 15.5 });
    expect(loadLocation(storage)).toEqual({ lat: -33.8688, lon: 151.2093, elevationM: 15.5 });
  });

  it("範囲の端（緯度 ±90・経度 ±180・標高 -500 と 9000）は受理する", () => {
    expect(loadLocation(storageWithRaw(JSON.stringify({ lat: 90, lon: 180, elevationM: 9000 })))).toEqual({
      lat: 90,
      lon: 180,
      elevationM: 9000,
    });
    expect(loadLocation(storageWithRaw(JSON.stringify({ lat: -90, lon: -180, elevationM: -500 })))).toEqual({
      lat: -90,
      lon: -180,
      elevationM: -500,
    });
  });

  it("余分な項目は読み込み結果に含めない", () => {
    const raw = JSON.stringify({ ...NAGAREYAMA, name: "流山" });
    expect(loadLocation(storageWithRaw(raw))).toEqual(NAGAREYAMA);
  });

  it.each([
    ["JSON として不正", "{lat: 35"],
    ["空文字", ""],
    ["null", "null"],
    ["配列", "[35.8709, 139.9256, 15]"],
    ["数値", "35.8709"],
    ["文字列", '"35.8709,139.9256"'],
    ["lat が 91", JSON.stringify({ lat: 91, lon: 139.9256, elevationM: 15 })],
    ["lat が -90.0001", JSON.stringify({ lat: -90.0001, lon: 139.9256, elevationM: 15 })],
    ["lon が -181", JSON.stringify({ lat: 35.8709, lon: -181, elevationM: 15 })],
    ["lon が 180.0001", JSON.stringify({ lat: 35.8709, lon: 180.0001, elevationM: 15 })],
    ["elevationM が欠損", JSON.stringify({ lat: 35.8709, lon: 139.9256 })],
    ["elevationM が 9001", JSON.stringify({ lat: 35.8709, lon: 139.9256, elevationM: 9001 })],
    ["elevationM が -501", JSON.stringify({ lat: 35.8709, lon: 139.9256, elevationM: -501 })],
    ["elevationM が null", JSON.stringify({ lat: 35.8709, lon: 139.9256, elevationM: null })],
    ["lat が欠損", JSON.stringify({ lon: 139.9256, elevationM: 15 })],
    ["数値が文字列", JSON.stringify({ lat: "35.8709", lon: "139.9256", elevationM: "15" })],
    ["elevationM だけが文字列", JSON.stringify({ lat: 35.8709, lon: 139.9256, elevationM: "15" })],
  ])("保存値が不正（%s）なら undefined", (_name, raw) => {
    expect(loadLocation(storageWithRaw(raw))).toBeUndefined();
  });

  it("getItem が例外を投げたら undefined", () => {
    const storage: LocationStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {},
    };
    expect(loadLocation(storage)).toBeUndefined();
  });

  it("setItem が例外を投げたら saveLocation は false", () => {
    const storage: LocationStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(saveLocation(storage, NAGAREYAMA)).toBe(false);
  });

  it("storage が無い（使えない）ときは読み込みが undefined・保存が false", () => {
    expect(loadLocation(undefined)).toBeUndefined();
    expect(saveLocation(undefined, NAGAREYAMA)).toBe(false);
  });
});

describe("accessStorage", () => {
  it("取り出せた storage をそのまま返す", () => {
    const { storage } = memoryStorage();
    expect(accessStorage(() => storage)).toBe(storage);
  });

  it("storage へのアクセス自体が例外を投げたら undefined", () => {
    expect(
      accessStorage(() => {
        throw new Error("SecurityError");
      }),
    ).toBeUndefined();
  });
});

describe("parseElevationInput", () => {
  it.each([
    ["-500", -500],
    ["9000", 9000],
    ["15.5", 15.5],
    ["0", 0],
    ["15", 15],
    [" 15 ", 15],
  ])("%j を %d として受理する", (text, value) => {
    expect(parseElevationInput(text)).toEqual({ ok: true, value });
  });

  it.each([[""], ["  "], ["\t"]])("空（%j）は既定の 0m として受理する", (text) => {
    expect(parseElevationInput(text)).toEqual({ ok: true, value: 0 });
  });

  it.each([["-501"], ["9001"], ["9000.1"], ["-500.5"]])("範囲外の %j はエラー（範囲を示す）", (text) => {
    const result = parseElevationInput(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("-500");
      expect(result.error).toContain("9000");
    }
  });

  it.each([["abc"], ["1e3"], ["+15"], ["1."], [".5"], ["15m"], ["1,000"], ["１５"], ["-"]])(
    "数値の形でない %j はエラー（日本語の文言）",
    (text) => {
      const result = parseElevationInput(text);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/標高/);
      }
    },
  );

  it.each([
    ["15.5", 15.5],
    ["-3.6", -3.6],
    ["0.1", 0.1],
    ["15.0", 15],
  ])("小数 1 桁の %j は %d として受理する", (text, value) => {
    expect(parseElevationInput(text)).toEqual({ ok: true, value });
  });

  it.each([["15.55"], ["0.0000001"], ["-0.05"], ["9000.00"]])(
    "小数 2 桁以上の %j は形の誤りとしてエラー（小数は 1 桁までと示す）",
    (text) => {
      expect(parseElevationInput(text)).toEqual({ ok: false, error: expect.stringContaining("小数は 1 桁まで") });
    },
  );
});

describe("formatLocationHeader", () => {
  it("緯度・経度を小数 4 桁、標高を整数 m で表示する", () => {
    expect(formatLocationHeader(NAGAREYAMA)).toBe("地点: 35.8709, 139.9256（標高 15m）");
  });

  it("緯度・経度は小数 4 桁に丸め、標高は整数に丸める", () => {
    expect(formatLocationHeader({ lat: 35.87087, lon: 139.92561, elevationM: 15.6 })).toBe(
      "地点: 35.8709, 139.9256（標高 16m）",
    );
    expect(formatLocationHeader({ lat: 30, lon: 150, elevationM: 15.4 })).toBe("地点: 30.0000, 150.0000（標高 15m）");
  });

  it("南半球・西経・負の標高も符号つきで表示する", () => {
    expect(formatLocationHeader({ lat: -33.86882, lon: -70.66931, elevationM: -3.6 })).toBe(
      "地点: -33.8688, -70.6693（標高 -4m）",
    );
  });

  it("0 に丸まる負の標高は「0m」", () => {
    expect(formatLocationHeader({ lat: 30, lon: 150, elevationM: -0.4 })).toBe("地点: 30.0000, 150.0000（標高 0m）");
  });

  it("地点が無ければ「地点: 未設定」", () => {
    expect(formatLocationHeader(undefined)).toBe("地点: 未設定");
  });
});

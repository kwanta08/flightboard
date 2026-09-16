import { describe, expect, it } from "vitest";
import {
  accessStorage,
  addLocation,
  APP_STORAGE_KEY,
  applyLocationEdit,
  canRemoveLocation,
  defaultLocationName,
  formatLocationHeader,
  formatLocationOption,
  initLocations,
  LOCATION_STORAGE_KEY,
  loadLocation,
  loadLocations,
  nextLocationId,
  parseElevationInput,
  removeLocation,
  replaceSelectedLocation,
  saveLocation,
  saveLocations,
  selectedLocation,
  selectLocation,
  type LocationBook,
  type LocationStorage,
  type NamedLocation,
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

// ---- v2: 複数の地点（AC-P2-70） ----

const HOME: NamedLocation = { id: "loc-1", name: "地点 1", ...NAGAREYAMA };
const WORK: NamedLocation = { id: "loc-2", name: "地点 2", lat: 35.55, lon: 139.78, elevationM: 5 };

/** v2 のキーに生の文字列が入っている storage */
function storageWithV2(raw: string, v1?: string) {
  return memoryStorage(
    v1 === undefined ? { [APP_STORAGE_KEY]: raw } : { [APP_STORAGE_KEY]: raw, [LOCATION_STORAGE_KEY]: v1 },
  );
}

/** v2 のレコードとして保存されている storage */
function storageWithBook(book: LocationBook) {
  return storageWithV2(JSON.stringify({ version: 2, locations: book.locations, selectedId: book.selectedId }));
}

describe("APP_STORAGE_KEY", () => {
  it("キーは flightboard.app.v2（v1 とは別の 1 本にまとめる）", () => {
    expect(APP_STORAGE_KEY).toBe("flightboard.app.v2");
  });
});

describe("saveLocations / loadLocations", () => {
  it("保存した一覧と選択をそのまま読み込める（往復）", () => {
    const { storage } = memoryStorage();
    const book: LocationBook = { locations: [HOME, WORK], selectedId: "loc-2" };
    expect(saveLocations(storage, book)).toBe(true);
    expect(loadLocations(storage)).toEqual(book);
  });

  it("v2 のキーに version・locations・selectedId をまとめて書く", () => {
    const { storage, items } = memoryStorage();
    saveLocations(storage, { locations: [HOME, WORK], selectedId: "loc-2" });
    expect(JSON.parse(items.get(APP_STORAGE_KEY) ?? "")).toEqual({
      version: 2,
      locations: [HOME, WORK],
      selectedId: "loc-2",
    });
  });

  it("保存のたびに v1 キーへ選択中の地点を書き戻す（旧版で開いても最新の地点が出る）", () => {
    const { storage, items } = memoryStorage();
    saveLocations(storage, { locations: [HOME, WORK], selectedId: "loc-2" });
    expect(JSON.parse(items.get(LOCATION_STORAGE_KEY) ?? "")).toEqual({ lat: 35.55, lon: 139.78, elevationM: 5 });
    // v1 の API でそのまま読める（id・name は v1 には書かない）
    expect(loadLocation(storage)).toEqual({ lat: 35.55, lon: 139.78, elevationM: 5 });
  });

  it("同じキーの settings は保ったまま残す（settingsStore の保存値を壊さない）", () => {
    const { storage, items } = memoryStorage({
      [APP_STORAGE_KEY]: JSON.stringify({ version: 2, locations: [], settings: { radiusKm: 25 } }),
    });
    saveLocations(storage, { locations: [HOME], selectedId: "loc-1" });
    expect(JSON.parse(items.get(APP_STORAGE_KEY) ?? "")).toEqual({
      version: 2,
      locations: [HOME],
      selectedId: "loc-1",
      settings: { radiusKm: 25 },
    });
  });

  it("一覧が空のときは v1 キーを触らない（旧版の地点を消さない）", () => {
    const { storage, items } = memoryStorage({ [LOCATION_STORAGE_KEY]: JSON.stringify(NAGAREYAMA) });
    expect(saveLocations(storage, { locations: [], selectedId: undefined })).toBe(true);
    expect(JSON.parse(items.get(LOCATION_STORAGE_KEY) ?? "")).toEqual(NAGAREYAMA);
  });

  it("setItem が例外を投げたら false", () => {
    const storage: LocationStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(saveLocations(storage, { locations: [HOME], selectedId: "loc-1" })).toBe(false);
  });

  it("storage が無い（使えない）ときは読み込みが空の一覧・保存が false", () => {
    expect(loadLocations(undefined)).toEqual({ locations: [], selectedId: undefined });
    expect(saveLocations(undefined, { locations: [HOME], selectedId: "loc-1" })).toBe(false);
  });
});

describe("loadLocations: v1 からの移行と壊れた保存値", () => {
  it("v2 が無ければ v1 の地点を 1 件の一覧として読む（名前と識別子を付ける）", () => {
    const { storage } = memoryStorage({ [LOCATION_STORAGE_KEY]: JSON.stringify(NAGAREYAMA) });
    expect(loadLocations(storage)).toEqual({ locations: [HOME], selectedId: "loc-1" });
  });

  it.each([
    ["JSON として不正", "{version: 2"],
    ["配列", "[]"],
    ["locations が無い", JSON.stringify({ version: 2 })],
    ["locations が配列でない", JSON.stringify({ version: 2, locations: { id: "loc-1" } })],
    ["版が違う", JSON.stringify({ version: 3, locations: [] })],
    ["版が無い", JSON.stringify({ locations: [] })],
  ])("v2 が読めない（%s）ときは v1 の地点に落ちる", (_name, raw) => {
    const { storage } = storageWithV2(raw, JSON.stringify(NAGAREYAMA));
    expect(loadLocations(storage)).toEqual({ locations: [HOME], selectedId: "loc-1" });
  });

  it("v2 も v1 も無ければ空の一覧（セットアップ画面に戻る）", () => {
    expect(loadLocations(memoryStorage().storage)).toEqual({ locations: [], selectedId: undefined });
  });

  it("v2 が空の一覧なら v1 には落ちない（削除した地点を復活させない）", () => {
    const { storage } = storageWithV2(JSON.stringify({ version: 2, locations: [] }), JSON.stringify(NAGAREYAMA));
    expect(loadLocations(storage)).toEqual({ locations: [], selectedId: undefined });
  });

  it("一覧の中の不正な 1 件だけを捨てる（他の地点は残す）", () => {
    const { storage } = storageWithV2(
      JSON.stringify({
        version: 2,
        locations: [
          HOME,
          { id: "loc-9", name: "緯度が範囲外", lat: 91, lon: 0, elevationM: 0 },
          { name: "識別子なし", ...NAGAREYAMA },
          WORK,
        ],
        selectedId: "loc-2",
      }),
    );
    expect(loadLocations(storage)).toEqual({ locations: [HOME, WORK], selectedId: "loc-2" });
  });

  it("名前が無い・文字列でない地点は識別子を名前にする", () => {
    const { storage } = storageWithV2(JSON.stringify({ version: 2, locations: [{ id: "loc-1", ...NAGAREYAMA }] }));
    expect(loadLocations(storage)).toEqual({
      locations: [{ id: "loc-1", name: "loc-1", ...NAGAREYAMA }],
      selectedId: "loc-1",
    });
  });

  it("選択が一覧に無い・無いときは先頭を選ぶ", () => {
    const { storage } = storageWithV2(JSON.stringify({ version: 2, locations: [HOME, WORK], selectedId: "loc-9" }));
    expect(loadLocations(storage)).toEqual({ locations: [HOME, WORK], selectedId: "loc-1" });
  });

  it("識別子が重なる地点は先に出てきた 1 件だけを残す", () => {
    const { storage } = storageWithV2(
      JSON.stringify({ version: 2, locations: [HOME, { ...WORK, id: "loc-1" }], selectedId: "loc-1" }),
    );
    expect(loadLocations(storage)).toEqual({ locations: [HOME], selectedId: "loc-1" });
  });
});

describe("initLocations", () => {
  it("v2 が無いときは v1 の地点を v2 として書き出し、v1 キーは消さない（移行）", () => {
    const { storage, items } = memoryStorage({ [LOCATION_STORAGE_KEY]: JSON.stringify(NAGAREYAMA) });
    expect(initLocations(storage)).toEqual({ locations: [HOME], selectedId: "loc-1" });
    expect([...items.keys()].sort()).toEqual([APP_STORAGE_KEY, LOCATION_STORAGE_KEY].sort());
    expect(JSON.parse(items.get(APP_STORAGE_KEY) ?? "")).toEqual({
      version: 2,
      locations: [HOME],
      selectedId: "loc-1",
    });
    expect(loadLocation(storage)).toEqual(NAGAREYAMA);
  });

  it("v2 から読めたときは書き出さない", () => {
    const { storage, items } = storageWithBook({ locations: [HOME, WORK], selectedId: "loc-2" });
    const before = items.get(APP_STORAGE_KEY);
    expect(initLocations(storage)).toEqual({ locations: [HOME, WORK], selectedId: "loc-2" });
    expect(items.get(APP_STORAGE_KEY)).toBe(before);
    expect(items.has(LOCATION_STORAGE_KEY)).toBe(false);
  });

  it("v2 も v1 も無ければ何も書かない（セットアップ前に空のレコードを作らない）", () => {
    const { storage, items } = memoryStorage();
    expect(initLocations(storage)).toEqual({ locations: [], selectedId: undefined });
    expect([...items.keys()]).toEqual([]);
  });

  it("書き出しに失敗しても読めた内容を返す", () => {
    const storage: LocationStorage = {
      getItem: (key) => (key === LOCATION_STORAGE_KEY ? JSON.stringify(NAGAREYAMA) : null),
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(initLocations(storage)).toEqual({ locations: [HOME], selectedId: "loc-1" });
  });
});

describe("nextLocationId / defaultLocationName", () => {
  it("空の一覧では loc-1 と「地点 1」", () => {
    expect(nextLocationId([])).toBe("loc-1");
    expect(defaultLocationName([])).toBe("地点 1");
  });

  it("既存と重ならない最小の番号を使う（削除した番号は空きとして埋める）", () => {
    expect(nextLocationId([HOME, WORK])).toBe("loc-3");
    expect(defaultLocationName([HOME, WORK])).toBe("地点 3");
    expect(nextLocationId([WORK])).toBe("loc-1");
    expect(defaultLocationName([WORK])).toBe("地点 1");
  });
});

describe("addLocation / selectLocation / removeLocation / replaceSelectedLocation", () => {
  const BOOK: LocationBook = { locations: [HOME, WORK], selectedId: "loc-1" };

  it("足した地点を末尾に置き、それを選択する", () => {
    const next = addLocation(BOOK, { lat: 43.06, lon: 141.35, elevationM: 20 });
    expect(next).toEqual({
      locations: [HOME, WORK, { id: "loc-3", name: "地点 3", lat: 43.06, lon: 141.35, elevationM: 20 }],
      selectedId: "loc-3",
    });
  });

  it("空の一覧に足すと 1 件目になる", () => {
    expect(addLocation({ locations: [], selectedId: undefined }, NAGAREYAMA)).toEqual({
      locations: [HOME],
      selectedId: "loc-1",
    });
  });

  it("地点を切り替える。一覧に無い識別子では変えない", () => {
    expect(selectLocation(BOOK, "loc-2").selectedId).toBe("loc-2");
    expect(selectLocation(BOOK, "loc-9")).toBe(BOOK);
  });

  it("選択中の地点は座標・標高だけを置き換え、名前と識別子を保つ", () => {
    const next = replaceSelectedLocation(BOOK, { lat: 35.9, lon: 139.9, elevationM: 20 });
    expect(next).toEqual({
      locations: [{ id: "loc-1", name: "地点 1", lat: 35.9, lon: 139.9, elevationM: 20 }, WORK],
      selectedId: "loc-1",
    });
  });

  it("選択が無い（一覧が空）ときの置き換えは追加になる", () => {
    expect(replaceSelectedLocation({ locations: [], selectedId: undefined }, NAGAREYAMA)).toEqual({
      locations: [HOME],
      selectedId: "loc-1",
    });
  });

  it("削除したのが選択中なら残りの先頭を選ぶ", () => {
    expect(removeLocation(BOOK, "loc-1")).toEqual({ locations: [WORK], selectedId: "loc-2" });
  });

  it("選択中でない地点を削除しても選択は変わらない", () => {
    expect(removeLocation(BOOK, "loc-2")).toEqual({ locations: [HOME], selectedId: "loc-1" });
  });

  it("最後の 1 件と、一覧に無い識別子では削除しない", () => {
    const single: LocationBook = { locations: [HOME], selectedId: "loc-1" };
    expect(canRemoveLocation(single)).toBe(false);
    expect(removeLocation(single, "loc-1")).toBe(single);
    expect(canRemoveLocation(BOOK)).toBe(true);
    expect(removeLocation(BOOK, "loc-9")).toBe(BOOK);
  });

  it("選択中の地点。選択が無ければ先頭、一覧が空なら undefined", () => {
    expect(selectedLocation(BOOK)).toEqual(HOME);
    expect(selectedLocation({ locations: [HOME, WORK], selectedId: undefined })).toEqual(HOME);
    expect(selectedLocation({ locations: [], selectedId: undefined })).toBeUndefined();
  });
});

describe("applyLocationEdit", () => {
  const BOOK: LocationBook = { locations: [HOME], selectedId: "loc-1" };

  it("add なら新しい地点として足す", () => {
    expect(applyLocationEdit(BOOK, "add", { lat: 35.9, lon: 139.9, elevationM: 20 }).locations).toHaveLength(2);
  });

  it("change なら選択中の地点を置き換える", () => {
    const next = applyLocationEdit(BOOK, "change", { lat: 35.9, lon: 139.9, elevationM: 20 });
    expect(next.locations).toEqual([{ id: "loc-1", name: "地点 1", lat: 35.9, lon: 139.9, elevationM: 20 }]);
  });
});

describe("formatLocationOption", () => {
  it("名前と座標・標高を並べる", () => {
    expect(formatLocationOption(HOME)).toBe("地点 1: 35.8709, 139.9256（標高 15m）");
  });
});

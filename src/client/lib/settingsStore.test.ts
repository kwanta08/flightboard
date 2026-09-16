import { describe, expect, it } from "vitest";
import { APP_STORAGE_KEY, LOCATION_STORAGE_KEY, type LocationStorage } from "./locationStore.ts";
import {
  ALTITUDE_UNIT_OPTIONS,
  altitudeUnitFromValue,
  DEFAULT_SETTINGS,
  DEFAULT_UNITS,
  INTERVAL_MAX_SEC,
  INTERVAL_MIN_SEC,
  INTERVAL_OPTIONS,
  INTERVAL_OPTIONS_SEC,
  intervalMsFromValue,
  intervalOptionValue,
  loadSettings,
  SAVE_FAILED_MESSAGE,
  saveSettings,
  SPEED_UNIT_OPTIONS,
  speedUnitFromValue,
  type Settings,
} from "./settingsStore.ts";

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

/** v2 のキーに settings を持つ storage（locations は触らない） */
function storageWithSettings(settings: unknown, extra: Record<string, unknown> = {}) {
  return memoryStorage({ [APP_STORAGE_KEY]: JSON.stringify({ version: 2, settings, ...extra }) });
}

const CHANGED: Settings = {
  radiusKm: 25,
  intervalMs: 30_000,
  kindOption: "cargo",
  units: { altitude: "ft", speed: "kt" },
};

describe("DEFAULT_SETTINGS", () => {
  it("既定は 半径 50km・更新 10 秒・旅客機＋貨物・m と km/h（F-02・F-06・F-07・Q6）", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      radiusKm: 50,
      intervalMs: 10_000,
      kindOption: "passenger,cargo",
      units: { altitude: "m", speed: "kmh" },
    });
    expect(DEFAULT_UNITS).toEqual({ altitude: "m", speed: "kmh" });
  });
});

describe("INTERVAL_OPTIONS", () => {
  it("更新間隔の選択肢は 5〜30 秒の中にある（F-06）", () => {
    expect(INTERVAL_MIN_SEC).toBe(5);
    expect(INTERVAL_MAX_SEC).toBe(30);
    for (const sec of INTERVAL_OPTIONS_SEC) {
      expect(sec).toBeGreaterThanOrEqual(INTERVAL_MIN_SEC);
      expect(sec).toBeLessThanOrEqual(INTERVAL_MAX_SEC);
    }
    expect(INTERVAL_OPTIONS_SEC).toContain(INTERVAL_MIN_SEC);
    expect(INTERVAL_OPTIONS_SEC).toContain(INTERVAL_MAX_SEC);
    // 既定の 10 秒を選べる（設定画面の選択欄が空欄にならない）
    expect(INTERVAL_OPTIONS_SEC).toContain(DEFAULT_SETTINGS.intervalMs / 1000);
  });

  it("選択肢は「5 秒」のような文言と、秒の文字列の値を持つ", () => {
    expect(INTERVAL_OPTIONS[0]).toEqual({ sec: 5, value: "5", label: "5 秒" });
  });

  it("ms と `<select>` の値を行き来できる", () => {
    expect(intervalOptionValue(10_000)).toBe("10");
    expect(intervalMsFromValue("30")).toBe(30_000);
  });

  it("選択肢に無い値は undefined（変更しない）", () => {
    expect(intervalMsFromValue("60")).toBeUndefined();
    expect(intervalMsFromValue("")).toBeUndefined();
  });
});

describe("単位の選択肢", () => {
  it("高度は m と ft、速度は km/h と kt（F-09）", () => {
    expect(ALTITUDE_UNIT_OPTIONS.map((option) => option.value)).toEqual(["m", "ft"]);
    expect(SPEED_UNIT_OPTIONS.map((option) => option.value)).toEqual(["kmh", "kt"]);
  });

  it("`<select>` の値を単位にする。選択肢に無ければ undefined", () => {
    expect(altitudeUnitFromValue("ft")).toBe("ft");
    expect(altitudeUnitFromValue("yard")).toBeUndefined();
    expect(speedUnitFromValue("kt")).toBe("kt");
    expect(speedUnitFromValue("mph")).toBeUndefined();
  });
});

describe("saveSettings / loadSettings", () => {
  it("保存した設定をそのまま読み込める（往復）", () => {
    const { storage } = memoryStorage();
    expect(saveSettings(storage, CHANGED)).toBe(true);
    expect(loadSettings(storage)).toEqual(CHANGED);
  });

  it("地点と同じ 1 本のキー（flightboard.app.v2）の settings に書く", () => {
    const { storage, items } = memoryStorage();
    saveSettings(storage, CHANGED);
    expect([...items.keys()]).toEqual([APP_STORAGE_KEY]);
    expect(JSON.parse(items.get(APP_STORAGE_KEY) ?? "")).toEqual({ version: 2, settings: CHANGED });
  });

  it("同じキーの locations・selectedId は保ったまま残す（地点の保存値を壊さない）", () => {
    const { storage, items } = memoryStorage({
      [APP_STORAGE_KEY]: JSON.stringify({
        version: 2,
        locations: [{ id: "loc-1", name: "地点 1", lat: 35.86, lon: 139.9, elevationM: 15 }],
        selectedId: "loc-1",
      }),
    });
    saveSettings(storage, CHANGED);
    expect(JSON.parse(items.get(APP_STORAGE_KEY) ?? "")).toEqual({
      version: 2,
      locations: [{ id: "loc-1", name: "地点 1", lat: 35.86, lon: 139.9, elevationM: 15 }],
      selectedId: "loc-1",
      settings: CHANGED,
    });
  });

  it("v1 のキーは触らない（設定は v1 には無い）", () => {
    const v1 = JSON.stringify({ lat: 35.86, lon: 139.9, elevationM: 15 });
    const { storage, items } = memoryStorage({ [LOCATION_STORAGE_KEY]: v1 });
    saveSettings(storage, CHANGED);
    expect(JSON.parse(items.get(LOCATION_STORAGE_KEY) ?? "")).toEqual({ lat: 35.86, lon: 139.9, elevationM: 15 });
  });

  it("setItem が例外を投げたら false（設定画面に保存できない旨を出す）", () => {
    const storage: LocationStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(saveSettings(storage, CHANGED)).toBe(false);
  });

  it("storage が無い（使えない）ときは読み込みが既定値・保存が false", () => {
    expect(loadSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(saveSettings(undefined, CHANGED)).toBe(false);
  });

  it("保存できなかったことを伝える文言がある", () => {
    expect(SAVE_FAILED_MESSAGE).toMatch(/保存できませんでした/);
  });
});

describe("loadSettings: 無い・壊れた保存値", () => {
  it("保存値が無ければ既定値", () => {
    expect(loadSettings(memoryStorage().storage)).toEqual(DEFAULT_SETTINGS);
  });

  it.each([
    ["JSON として不正", "{version: 2"],
    ["配列", "[]"],
    ["settings が無い", JSON.stringify({ version: 2, locations: [] })],
    ["settings が配列", JSON.stringify({ version: 2, settings: [] })],
    ["settings が null", JSON.stringify({ version: 2, settings: null })],
    ["settings が文字列", JSON.stringify({ version: 2, settings: "50" })],
    ["版が違う", JSON.stringify({ version: 3, settings: { radiusKm: 25 } })],
    ["版が無い", JSON.stringify({ settings: { radiusKm: 25 } })],
  ])("読めない（%s）なら既定値", (_name, raw) => {
    expect(loadSettings(memoryStorage({ [APP_STORAGE_KEY]: raw }).storage)).toEqual(DEFAULT_SETTINGS);
  });

  it("不正な項目だけを既定値にし、正しい項目は残す", () => {
    const { storage } = storageWithSettings({
      radiusKm: 999,
      intervalMs: 25,
      kindOption: "military",
      units: { altitude: "ft", speed: "mph" },
    });
    expect(loadSettings(storage)).toEqual({
      radiusKm: DEFAULT_SETTINGS.radiusKm,
      intervalMs: DEFAULT_SETTINGS.intervalMs,
      kindOption: DEFAULT_SETTINGS.kindOption,
      units: { altitude: "ft", speed: "kmh" },
    });
  });

  it("units が無い・オブジェクトでなければ既定の単位", () => {
    expect(loadSettings(storageWithSettings({ radiusKm: 25 }).storage).units).toEqual(DEFAULT_UNITS);
    expect(loadSettings(storageWithSettings({ units: "ft" }).storage).units).toEqual(DEFAULT_UNITS);
  });

  it.each([
    ["5 秒", 5_000],
    ["30 秒", 30_000],
  ])("更新間隔の端（%s）は受理する", (_name, intervalMs) => {
    expect(loadSettings(storageWithSettings({ intervalMs }).storage).intervalMs).toBe(intervalMs);
  });

  it.each([
    ["範囲の外（3 秒）", 3_000],
    ["範囲の外（60 秒）", 60_000],
    ["選択肢に無い（7 秒）", 7_000],
    ["秒で入っている", 10],
    ["文字列", "10000"],
  ])("更新間隔が %s なら既定の 10 秒に戻す", (_name, intervalMs) => {
    expect(loadSettings(storageWithSettings({ intervalMs }).storage).intervalMs).toBe(DEFAULT_SETTINGS.intervalMs);
  });

  it.each([10, 25, 50, 100])("半径 %dkm は選択肢にあるので受理する", (radiusKm) => {
    expect(loadSettings(storageWithSettings({ radiusKm }).storage).radiusKm).toBe(radiusKm);
  });

  it.each(["passenger,cargo", "passenger", "cargo"])("表示する種類 %s は受理する", (kindOption) => {
    expect(loadSettings(storageWithSettings({ kindOption }).storage).kindOption).toBe(kindOption);
  });

  it("settings の余分な項目は読み込み結果に含めない", () => {
    expect(loadSettings(storageWithSettings({ ...CHANGED, sortMode: "callsign" }).storage)).toEqual(CHANGED);
  });

  it("getItem が例外を投げたら既定値", () => {
    const storage: LocationStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {},
    };
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });
});

// 設定（検索半径・更新間隔・表示する種類・単位）の保存と読み込み、設定画面の文言と選択肢（F-09・S-04・AC-P2-71）。
// 保存先は locationStore.ts と同じ 1 本のキー（flightboard.app.v2）の settings 部分で、locations とは互いに保ち合う。
// SettingsScreen.tsx はこの結果を描画・配線するだけにする。
import {
  DEFAULT_KIND_OPTION,
  DEFAULT_RADIUS_KM,
  kindOptionFromValue,
  RADIUS_OPTIONS,
  type KindOptionValue,
} from "./listView.ts";
import { APP_STORAGE_VERSION, readAppRecord, writeAppRecord, type LocationStorage } from "./locationStore.ts";
import { DEFAULT_POLL_INTERVAL_MS } from "./poller.ts";

// ---- 単位（Q6。既定は m・km/h。表示への反映は W7） ----

export type AltitudeUnit = "m" | "ft";
export type SpeedUnit = "kmh" | "kt";

/** 表示の単位（高度・速度） */
export type Units = { altitude: AltitudeUnit; speed: SpeedUnit };

/** 単位の既定値（仕様 Q6「既定は m と km/h」） */
export const DEFAULT_UNITS: Units = { altitude: "m", speed: "kmh" };

// ---- 更新間隔（F-06「既定 10 秒、設定で 5〜30 秒」） ----

/** 更新間隔の範囲（秒。F-06） */
export const INTERVAL_MIN_SEC = 5;
export const INTERVAL_MAX_SEC = 30;

/** 更新間隔の選択肢（秒）。F-06 の 5〜30 秒の範囲から選ばせる */
export const INTERVAL_OPTIONS_SEC: readonly number[] = [5, 10, 15, 20, 30];

// ---- 設定 ----

export type Settings = {
  /** 検索半径（km。F-02 の選択肢） */
  radiusKm: number;
  /** 自動更新の間隔（ms。poller に渡す値の単位に合わせる） */
  intervalMs: number;
  /** 表示する機体の種類 */
  kindOption: KindOptionValue;
  units: Units;
};

/** 設定の既定値。半径・種類・間隔は既存の既定（listView.ts・poller.ts）をそのまま使い、二重の出どころを作らない */
export const DEFAULT_SETTINGS: Settings = {
  radiusKm: DEFAULT_RADIUS_KM,
  intervalMs: DEFAULT_POLL_INTERVAL_MS,
  kindOption: DEFAULT_KIND_OPTION,
  units: DEFAULT_UNITS,
};

// ---- 設定の 1 項目だけを変えた設定を作る（設定画面・ツールバーの配線から組み立ての判断を無くす） ----

/** 検索半径を変えた設定 */
export function withRadiusKm(settings: Settings, radiusKm: number): Settings {
  return { ...settings, radiusKm };
}

/** 更新間隔（ms）を変えた設定 */
export function withIntervalMs(settings: Settings, intervalMs: number): Settings {
  return { ...settings, intervalMs };
}

/** 表示する機体の種類を変えた設定 */
export function withKindOption(settings: Settings, kindOption: KindOptionValue): Settings {
  return { ...settings, kindOption };
}

/** 高度の単位を変えた設定（速度の単位は保つ） */
export function withAltitudeUnit(settings: Settings, altitude: AltitudeUnit): Settings {
  return { ...settings, units: { ...settings.units, altitude } };
}

/** 速度の単位を変えた設定（高度の単位は保つ） */
export function withSpeedUnit(settings: Settings, speed: SpeedUnit): Settings {
  return { ...settings, units: { ...settings.units, speed } };
}

function parseRadiusKm(value: unknown): number {
  return RADIUS_OPTIONS.some((option) => option.km === value) ? (value as number) : DEFAULT_SETTINGS.radiusKm;
}

/** 選択肢に無い間隔は既定に戻す（画面の選択欄に出せない値を持たないようにする） */
function parseIntervalMs(value: unknown): number {
  return typeof value === "number" && INTERVAL_OPTIONS_SEC.includes(value / 1000)
    ? value
    : DEFAULT_SETTINGS.intervalMs;
}

function parseKindOption(value: unknown): KindOptionValue {
  const kindOption = typeof value === "string" ? kindOptionFromValue(value) : undefined;
  return kindOption ?? DEFAULT_SETTINGS.kindOption;
}

function parseUnits(value: unknown): Units {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ...DEFAULT_UNITS };
  }
  const { altitude, speed } = value as Record<string, unknown>;
  return {
    altitude: altitude === "m" || altitude === "ft" ? altitude : DEFAULT_UNITS.altitude,
    speed: speed === "kmh" || speed === "kt" ? speed : DEFAULT_UNITS.speed,
  };
}

/**
 * 設定を読む。無い・読めない・版が違うなら既定値。
 * 項目ごとに検証し、不正な項目だけを既定値にする（1 つの壊れた項目で設定全部を捨てない）
 */
export function loadSettings(storage: Pick<Storage, "getItem"> | undefined): Settings {
  const record = readAppRecord(storage);
  const settings = record?.version === APP_STORAGE_VERSION ? record.settings : undefined;
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return { ...DEFAULT_SETTINGS, units: { ...DEFAULT_UNITS } };
  }
  const { radiusKm, intervalMs, kindOption, units } = settings as Record<string, unknown>;
  return {
    radiusKm: parseRadiusKm(radiusKm),
    intervalMs: parseIntervalMs(intervalMs),
    kindOption: parseKindOption(kindOption),
    units: parseUnits(units),
  };
}

/** 設定を保存する。同じキーの locations・selectedId は保つ。保存できなければ false（容量超過・利用不可など） */
export function saveSettings(storage: LocationStorage | undefined, settings: Settings): boolean {
  if (storage === undefined) {
    return false;
  }
  const record = readAppRecord(storage);
  return writeAppRecord(storage, { ...record, version: APP_STORAGE_VERSION, settings });
}

// ---- 設定画面の選択肢と文言 ----

export type IntervalOption = { sec: number; value: string; label: string };

/** 更新間隔の選択肢（「10 秒」） */
export const INTERVAL_OPTIONS: readonly IntervalOption[] = INTERVAL_OPTIONS_SEC.map((sec) => ({
  sec,
  value: String(sec),
  label: `${sec} 秒`,
}));

/** 更新間隔の `<select>` の値（ms → 秒の文字列） */
export function intervalOptionValue(intervalMs: number): string {
  return String(Math.round(intervalMs / 1000));
}

/** `<select>` の値を更新間隔（ms）に。選択肢に無ければ undefined */
export function intervalMsFromValue(value: string): number | undefined {
  const option = INTERVAL_OPTIONS.find((entry) => entry.value === value);
  return option === undefined ? undefined : option.sec * 1000;
}

export type UnitOption<V> = { value: V; label: string };

/** 高度の単位の選択肢（F-09） */
export const ALTITUDE_UNIT_OPTIONS: ReadonlyArray<UnitOption<AltitudeUnit>> = [
  { value: "m", label: "m（メートル）" },
  { value: "ft", label: "ft（フィート）" },
];

/** 速度の単位の選択肢（F-09） */
export const SPEED_UNIT_OPTIONS: ReadonlyArray<UnitOption<SpeedUnit>> = [
  { value: "kmh", label: "km/h" },
  { value: "kt", label: "kt（ノット）" },
];

/** `<select>` の値を高度の単位に。選択肢に無ければ undefined */
export function altitudeUnitFromValue(value: string): AltitudeUnit | undefined {
  return ALTITUDE_UNIT_OPTIONS.find((option) => option.value === value)?.value;
}

/** `<select>` の値を速度の単位に。選択肢に無ければ undefined */
export function speedUnitFromValue(value: string): SpeedUnit | undefined {
  return SPEED_UNIT_OPTIONS.find((option) => option.value === value)?.value;
}

/** 設定画面の見出しと操作の文言（S-04） */
export const SETTINGS_TITLE = "設定";
/** ヘッダーの［設定］ボタンの文言（アクセシブルネームを兼ねる。S-02 の画面図） */
export const SETTINGS_OPEN_LABEL = "設定";
export const SETTINGS_CLOSE_LABEL = "設定を閉じる";
export const DISPLAY_SECTION_TITLE = "表示と更新";
export const INTERVAL_SELECT_LABEL = "更新間隔";
export const ALTITUDE_UNIT_SELECT_LABEL = "高度の単位";
export const SPEED_UNIT_SELECT_LABEL = "速度の単位";
/** データ提供元のクレジットの区分の見出し（AC-P2-73） */
export const CREDITS_SECTION_TITLE = "データ提供元";

/** 保存に失敗したときに設定画面へ出す文言（localStorage の容量超過・利用不可） */
export const SAVE_FAILED_MESSAGE =
  "保存できませんでした（このブラウザでは保存領域が使えないか、容量を超えています）。変更はこの画面では有効ですが、次に開いたときには元に戻ります";

/**
 * 設定画面に出す保存失敗の文言。失敗していなければ空文字
 * （領域（aria-live）は常に置いたままにして、文字だけを入れ替える）
 */
export function saveFailedMessage(saveFailed: boolean): string {
  return saveFailed ? SAVE_FAILED_MESSAGE : "";
}

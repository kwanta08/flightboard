// 観測地点（緯度・経度・標高）の保存と読み込み、標高の入力の検証、ヘッダーの地点表示（AC-B2・AC-B3・F-01）。
// localStorage は注入する（テストでは偽の storage を渡す）。

export type Location = { lat: number; lon: number; elevationM: number };

/** localStorage のキー。形式を変えるときは版を上げる（不正値は未設定として扱う） */
export const LOCATION_STORAGE_KEY = "flightboard.location.v1";

/** 地点が未設定のときのヘッダーの文言 */
export const LOCATION_UNSET_HEADER = "地点: 未設定";

/** 観測者の標高の入力範囲（m）。入力ミスを弾くための値（plan p1b「仮決めした解釈」） */
export const ELEVATION_MIN_M = -500;
export const ELEVATION_MAX_M = 9000;

export type LocationStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * storage を取り出す。ブラウザの設定によっては `window.localStorage` へのアクセス自体が例外を投げるので、
 * そのときは undefined を返す（地点は保存されないが画面は使える）
 */
export function accessStorage(access: () => LocationStorage): LocationStorage | undefined {
  try {
    return access();
  } catch {
    return undefined;
  }
}

function isNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/** 保存済みの地点を読む。無い・読めない・形式や範囲が不正なら undefined（セットアップ画面に戻る） */
export function loadLocation(storage: Pick<Storage, "getItem"> | undefined): Location | undefined {
  if (storage === undefined) {
    return undefined;
  }

  let raw: string | null;
  try {
    raw = storage.getItem(LOCATION_STORAGE_KEY);
  } catch {
    return undefined;
  }
  if (raw === null) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const { lat, lon, elevationM } = parsed as Record<string, unknown>;
  if (
    !isNumberInRange(lat, -90, 90) ||
    !isNumberInRange(lon, -180, 180) ||
    !isNumberInRange(elevationM, ELEVATION_MIN_M, ELEVATION_MAX_M)
  ) {
    return undefined;
  }
  return { lat, lon, elevationM };
}

/** 地点を保存する。保存できなければ false（容量超過・利用不可など） */
export function saveLocation(storage: Pick<Storage, "setItem"> | undefined, location: Location): boolean {
  if (storage === undefined) {
    return false;
  }
  try {
    storage.setItem(
      LOCATION_STORAGE_KEY,
      JSON.stringify({ lat: location.lat, lon: location.lon, elevationM: location.elevationM }),
    );
    return true;
  } catch {
    return false;
  }
}

export type ElevationParseResult = { ok: true; value: number } | { ok: false; error: string };

/**
 * 標高の入力の形。小数は 1 桁まで。
 * 受理した値を保存し［変更］で開き直したとき、`String` で同じ形の文字列に戻り、そのまま受理されるようにする
 * （桁を許すと 0.0000001 が "1e-7" になり、開き直した直後に標高エラーになる）
 */
const ELEVATION_PATTERN = /^-?\d+(\.\d)?$/;

/** 標高の入力欄の文字列を検証する。空（空白のみを含む）なら既定の 0m（S-01「任意」・F-01）。小数は 1 桁まで */
export function parseElevationInput(text: string): ElevationParseResult {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: true, value: 0 };
  }
  if (!ELEVATION_PATTERN.test(trimmed)) {
    return { ok: false, error: "標高は半角の数値（m、小数は 1 桁まで）で入力してください（例: 15）" };
  }
  const value = Number(trimmed);
  if (value < ELEVATION_MIN_M || value > ELEVATION_MAX_M) {
    return { ok: false, error: `標高は ${ELEVATION_MIN_M}〜${ELEVATION_MAX_M}m の範囲で入力してください` };
  }
  return { ok: true, value };
}

/** ヘッダーの地点表示。緯度・経度は小数 4 桁、標高は整数 m。地点が無ければ「地点: 未設定」 */
export function formatLocationHeader(location: Location | undefined): string {
  if (location === undefined) {
    return LOCATION_UNSET_HEADER;
  }
  const elevation = Math.round(location.elevationM);
  // Math.round(-0.4) は -0 になるが、テンプレート文字列では "0" と書かれる
  return `地点: ${location.lat.toFixed(4)}, ${location.lon.toFixed(4)}（標高 ${elevation}m）`;
}

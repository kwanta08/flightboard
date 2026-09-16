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

/** 保存されている JSON を読む。無い・読めない・オブジェクトでないなら undefined */
function readJsonObject(
  storage: Pick<Storage, "getItem"> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  if (storage === undefined) {
    return undefined;
  }

  let raw: string | null;
  try {
    raw = storage.getItem(key);
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
  return parsed as Record<string, unknown>;
}

/** 地点の 3 つの値を検証する。形式や範囲が不正なら undefined（v1 と v2 の両方から使う） */
function parseLocation(value: unknown): Location | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const { lat, lon, elevationM } = value as Record<string, unknown>;
  if (
    !isNumberInRange(lat, -90, 90) ||
    !isNumberInRange(lon, -180, 180) ||
    !isNumberInRange(elevationM, ELEVATION_MIN_M, ELEVATION_MAX_M)
  ) {
    return undefined;
  }
  return { lat, lon, elevationM };
}

/** 保存済みの地点を読む。無い・読めない・形式や範囲が不正なら undefined（セットアップ画面に戻る） */
export function loadLocation(storage: Pick<Storage, "getItem"> | undefined): Location | undefined {
  return parseLocation(readJsonObject(storage, LOCATION_STORAGE_KEY));
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

/** 地点の座標の表記（緯度・経度は小数 4 桁、標高は整数 m）。ヘッダーと設定画面の一覧で共有する */
function formatCoordinates(location: Location): string {
  const elevation = Math.round(location.elevationM);
  // Math.round(-0.4) は -0 になるが、テンプレート文字列では "0" と書かれる
  return `${location.lat.toFixed(4)}, ${location.lon.toFixed(4)}（標高 ${elevation}m）`;
}

/** ヘッダーの地点表示。緯度・経度は小数 4 桁、標高は整数 m。地点が無ければ「地点: 未設定」 */
export function formatLocationHeader(location: Location | undefined): string {
  if (location === undefined) {
    return LOCATION_UNSET_HEADER;
  }
  return `地点: ${formatCoordinates(location)}`;
}

// ---- v2: 複数の地点と設定の同居（AC-P2-70・F-01・F-09） ----

/**
 * 保存形式 v2 のキー。`{ version, locations, selectedId, settings }` を 1 本にまとめる。
 * settings の中身はここでは読まない（`settingsStore.ts` が同じキーの settings 部分を読み書きする）。
 * v1 のキー（`LOCATION_STORAGE_KEY`）は消さず、保存のたびに選択中の地点を書き戻す
 * （v2 キーを消せば v1 の挙動に戻り、移行後の編集も失われない）。
 * 同期は片方向で、**v1 → v2 は起動時の移行の 1 回だけ**（`initLocations`。v2 が読めないときに限る）。
 * 以後は v2 が正なので、旧版のアプリで v1 を書き換えてから新版を開いても v2 の一覧が勝つ（v1 の変更は取り込まれない）
 */
export const APP_STORAGE_KEY = "flightboard.app.v2";

/** 保存形式 v2 の版。合わないレコードは読めない値として扱い、v1 に落ちる */
export const APP_STORAGE_VERSION = 2;

/** 名前と識別子が付いた地点（複数登録の 1 件） */
export type NamedLocation = Location & { id: string; name: string };

/** 登録した地点の一覧と、選択中の地点の識別子（一覧が空なら `selectedId` は undefined） */
export type LocationBook = { locations: readonly NamedLocation[]; selectedId?: string };

/** セットアップ画面を開いた目的。add: 新しい地点として足す / change: 選択中の地点を置き換える */
export type LocationEditMode = "add" | "change";

/** v2 の保存値。各項目は読むときに検証するので、ここでは unknown のまま持つ */
export type AppRecord = { version?: unknown; locations?: unknown; selectedId?: unknown; settings?: unknown };

/** v2 の保存値を読む。無い・読めないなら undefined（版の検査はしない。settings と locations で別々に判断する） */
export function readAppRecord(storage: Pick<Storage, "getItem"> | undefined): AppRecord | undefined {
  return readJsonObject(storage, APP_STORAGE_KEY);
}

/** v2 の保存値を書く。保存できなければ false（容量超過・利用不可など） */
export function writeAppRecord(storage: Pick<Storage, "setItem"> | undefined, record: AppRecord): boolean {
  if (storage === undefined) {
    return false;
  }
  try {
    storage.setItem(APP_STORAGE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** 一覧の 1 件を検証する。座標が不正・識別子が無いなら undefined（その 1 件だけを捨てる） */
function parseNamedLocation(value: unknown): NamedLocation | undefined {
  const location = parseLocation(value);
  if (location === undefined) {
    return undefined;
  }
  const { id, name } = value as Record<string, unknown>;
  if (typeof id !== "string" || id === "") {
    return undefined;
  }
  return { id, name: typeof name === "string" && name !== "" ? name : id, ...location };
}

/** 一覧と選択中の識別子を整える。識別子が重複・選択が一覧に無いときは先頭を選ぶ */
function normalizeBook(locations: readonly NamedLocation[], selectedId: unknown): LocationBook {
  const unique: NamedLocation[] = [];
  for (const location of locations) {
    if (!unique.some((entry) => entry.id === location.id)) {
      unique.push(location);
    }
  }
  const selected =
    typeof selectedId === "string" && unique.some((entry) => entry.id === selectedId) ? selectedId : unique[0]?.id;
  return { locations: unique, selectedId: selected };
}

/** 読み出した一覧と、それが v2 キーから読めたか（読めなければ v1 から移行した） */
function readBook(storage: Pick<Storage, "getItem"> | undefined): { book: LocationBook; fromV2: boolean } {
  const record = readAppRecord(storage);
  if (record !== undefined && record.version === APP_STORAGE_VERSION && Array.isArray(record.locations)) {
    const locations = record.locations
      .map((entry: unknown) => parseNamedLocation(entry))
      .filter((entry): entry is NamedLocation => entry !== undefined);
    // 有効な地点が 1 件も残らなかったときは「読めなかった」と同じに扱い、下の v1 へ落ちる。
    // アプリが空の一覧を書く経路は無い（`canRemoveLocation` が最後の 1 件を消させず、`initLocations` も空なら書かない）ので、
    // 空の一覧は壊れた保存値であり、ここで v1 に落とさないと移行前の地点が次の保存で上書きされて消える
    if (locations.length > 0) {
      return { book: normalizeBook(locations, record.selectedId), fromV2: true };
    }
  }
  // v2 が無い・版が違う・壊れている（有効な地点が 0 件を含む） → v1 の単一地点に落ちる
  // （v2 の破損で既存の地点まで見えなくならないように）
  const single = loadLocation(storage);
  if (single === undefined) {
    return { book: { locations: [], selectedId: undefined }, fromV2: false };
  }
  const migrated: NamedLocation = { id: nextLocationId([]), name: defaultLocationName([]), ...single };
  return { book: { locations: [migrated], selectedId: migrated.id }, fromV2: false };
}

/**
 * 登録した地点を読む。v2 キーが無い・版が違う・壊れているときは v1 キーの単一地点に落として 1 件の一覧にする。
 * どちらも無ければ空の一覧（セットアップ画面に戻る）
 */
export function loadLocations(storage: Pick<Storage, "getItem"> | undefined): LocationBook {
  return readBook(storage).book;
}

/** 起動時の読み出しの結果。`saveFailed` は移行の書き出しに失敗したか（設定画面の保存失敗の表示に使う） */
export type LocationInit = { book: LocationBook; saveFailed: boolean };

/**
 * 起動時の読み出し。v2 キーから読めなかったときは v1 の地点を v2 として書き出す（移行。v1 キーは消さない）。
 * 書き出しに失敗しても読めた内容はそのまま返し（この起動中は使える）、失敗したことを `saveFailed` で伝える
 * （storage が読み取り専用の環境で、利用者が何かを変える前に設定画面へ出せるように）
 */
export function initLocations(storage: LocationStorage | undefined): LocationInit {
  const { book, fromV2 } = readBook(storage);
  if (!fromV2 && book.locations.length > 0) {
    return { book, saveFailed: !saveLocations(storage, book) };
  }
  return { book, saveFailed: false };
}

/**
 * 地点の一覧を v2 キーへ保存する（同じキーの settings は保つ）。
 * あわせて選択中の地点を v1 キーへ書き戻す（AC-P2-70。旧版のアプリで開いても最新の地点が出るようにする）。
 * v2 と v1 の両方に書けたときだけ true
 */
export function saveLocations(storage: LocationStorage | undefined, book: LocationBook): boolean {
  if (storage === undefined) {
    return false;
  }
  const record = readAppRecord(storage);
  const wroteV2 = writeAppRecord(storage, {
    ...record,
    version: APP_STORAGE_VERSION,
    locations: book.locations,
    selectedId: book.selectedId,
  });
  const selected = selectedLocation(book);
  // 一覧が空のときは v1 キーを触らない（消さない）
  const wroteV1 = selected === undefined || saveLocation(storage, selected);
  return wroteV2 && wroteV1;
}

/** 選択中の地点。選択が無ければ先頭、一覧が空なら undefined */
export function selectedLocation(book: LocationBook): NamedLocation | undefined {
  return book.locations.find((entry) => entry.id === book.selectedId) ?? book.locations[0];
}

/** 既存と重ならない最小の番号（識別子と既定の名前を同じ番号で作る。乱数は使わず保存値の見た目を安定させる） */
function nextLocationNumber(locations: readonly NamedLocation[]): number {
  for (let n = 1; ; n += 1) {
    if (!locations.some((entry) => entry.id === `loc-${n}`)) {
      return n;
    }
  }
}

/** 新しく足す地点の識別子（`loc-1`・`loc-2`…） */
export function nextLocationId(locations: readonly NamedLocation[]): string {
  return `loc-${nextLocationNumber(locations)}`;
}

/** 新しく足す地点の既定の名前（「地点 1」・「地点 2」…。識別子と同じ番号にする） */
export function defaultLocationName(locations: readonly NamedLocation[]): string {
  return `地点 ${nextLocationNumber(locations)}`;
}

/** 地点を足して、それを選択する */
export function addLocation(book: LocationBook, location: Location): LocationBook {
  const added: NamedLocation = {
    id: nextLocationId(book.locations),
    name: defaultLocationName(book.locations),
    ...location,
  };
  return { locations: [...book.locations, added], selectedId: added.id };
}

/** 選択中の地点の座標・標高を置き換える（名前と識別子は保つ）。選択が無ければ足す */
export function replaceSelectedLocation(book: LocationBook, location: Location): LocationBook {
  const selected = selectedLocation(book);
  if (selected === undefined) {
    return addLocation(book, location);
  }
  return {
    locations: book.locations.map((entry) => (entry.id === selected.id ? { ...entry, ...location } : entry)),
    selectedId: selected.id,
  };
}

/**
 * セットアップ画面を開いた目的の既定。
 * 目的が無い（地点が 1 つも無くてセットアップ画面に落ちた初回）ときは `change`＝選択中の地点の置き換えとして扱う
 * （一覧が空なので `replaceSelectedLocation` が 1 件目を足す。目的の既定を .tsx に置かないための関数）
 */
export function locationEditMode(editing: LocationEditMode | undefined): LocationEditMode {
  return editing ?? "change";
}

/** セットアップ画面での確定を一覧に反映する（足すか置き換えるかは開いた目的で決まる） */
export function applyLocationEdit(book: LocationBook, mode: LocationEditMode, location: Location): LocationBook {
  return mode === "add" ? addLocation(book, location) : replaceSelectedLocation(book, location);
}

/** 地点を切り替える。一覧に無い識別子なら変えない */
export function selectLocation(book: LocationBook, id: string): LocationBook {
  return book.locations.some((entry) => entry.id === id) ? { ...book, selectedId: id } : book;
}

/** 地点を削除できるか。最後の 1 件は削除させない（地点が無いとセットアップ画面に戻ってしまうため） */
export function canRemoveLocation(book: LocationBook): boolean {
  return book.locations.length > 1;
}

/**
 * 地点を削除する。削除したのが選択中なら残りの先頭を選ぶ。
 * 最後の 1 件と、一覧に無い識別子では何もしない（`canRemoveLocation`）
 */
export function removeLocation(book: LocationBook, id: string): LocationBook {
  if (!canRemoveLocation(book) || !book.locations.some((entry) => entry.id === id)) {
    return book;
  }
  const locations = book.locations.filter((entry) => entry.id !== id);
  return normalizeBook(locations, book.selectedId === id ? undefined : book.selectedId);
}

/** 地点を削除した後にフォーカスを移す先。selected-location: 選択中の地点のラジオ / settings-heading: 設定の見出し */
export type RemoveLocationFocus = "selected-location" | "settings-heading";

/**
 * ［選択中の地点を削除］の後にフォーカスを移す先（削除後の一覧で決める）。
 * まだ 2 件以上あればボタンは押せるままなので移さない（undefined）。
 * 1 件になるとボタンが無効になり、押したフォーカスが失われるので、選択中の地点のラジオへ移す。
 * `settings-heading`（移す地点が無い）は**画面の操作からは到達しない防御**で、
 * `removeLocation` が最後の 1 件を消さない（`canRemoveLocation`）ので削除後の一覧が空になることはない。
 * それでも、空の一覧を渡されたときにフォーカスを失わせないために残す
 */
export function focusAfterRemoveLocation(book: LocationBook): RemoveLocationFocus | undefined {
  if (canRemoveLocation(book)) {
    return undefined;
  }
  return selectedLocation(book) === undefined ? "settings-heading" : "selected-location";
}

/** 設定画面の地点の一覧に出す 1 行（「地点 1: 35.8709, 139.9256（標高 15m）」） */
export function formatLocationOption(location: NamedLocation): string {
  return `${location.name}: ${formatCoordinates(location)}`;
}

/** 設定画面の地点の区分の見出しと操作の文言 */
export const LOCATION_SECTION_TITLE = "地点";
export const LOCATION_ADD_LABEL = "地点を追加";
export const LOCATION_EDIT_LABEL = "選択中の地点を変更";
export const LOCATION_REMOVE_LABEL = "選択中の地点を削除";

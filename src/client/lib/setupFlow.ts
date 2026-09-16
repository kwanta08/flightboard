// 地点のセットアップ画面の判断（AC-B2・S-01・plan p1b M3-4）。SetupScreen.tsx と App.tsx はこの結果を描画するだけ。
import type { LatLon } from "../../shared/geo.ts";
import type { GeolocationFailureReason, GeolocationResult } from "./geolocation.ts";
import { parseElevationInput, type Location, type LocationEditMode } from "./locationStore.ts";

export type { LatLon };

/** Leaflet の地図上の座標（`LatLng` と同じ形。経度は ±180 の外になりうる） */
export type MapPoint = { lat: number; lng: number };

/** 地点が無いときの地図の仮の中心（仕様 6.5 の利用地点） */
export const DEFAULT_CENTER: LatLon = { lat: 35.86, lon: 139.9 };

/** セットアップ画面の地図の初期ズーム */
export const SETUP_MAP_ZOOM = 11;

/** 位置の精度がこれを超えたら「精度が低い」とする（m。S-01「精度が低い場合」の閾値。plan p1b「仮決めした解釈」） */
export const LOW_ACCURACY_THRESHOLD_M = 1000;

/** ヘッダーの［地点を変更］ボタンの文言（アクセシブルネームを兼ねる） */
export const LOCATION_CHANGE_LABEL = "地点を変更";

/**
 * ピンの出どころ。
 * current: ［変更］で開いたときの現在値 / geolocation: 測位の成功で置いた / user: 地図のクリック・ピンのドラッグで置いた
 */
export type PinSource = "current" | "geolocation" | "user";

/** 測位の進み具合。idle: 要求しない（［変更］で開いた） / pending: 結果待ち / done: 結果が届いた */
export type GeolocationPhase =
  | { phase: "idle" }
  | { phase: "pending" }
  | { phase: "done"; result: GeolocationResult };

/** セットアップ画面の状態 */
export type SetupState = {
  /** 置かれているピン（無ければピンを出さない） */
  pin?: LatLon;
  /** ピンの出どころ（ピンがあるときだけ） */
  pinSource?: PinSource;
  geolocation: GeolocationPhase;
  /** 標高の入力欄の文字列 */
  elevationText: string;
};

/** セットアップ画面を開いたときの状態と、地図の初期の中心・測位を要求するか */
export type InitialSetupState = SetupState & {
  /** 地図の初期の中心 */
  center: LatLon;
  /** マウント時に Geolocation を要求するか */
  requestGeolocation: boolean;
};

/**
 * 状態の遷移の結果。`recenter` があるときだけ地図の表示範囲をその位置に移す。
 * `recenter` を返しうるのは `applyGeolocationResult` だけで、他の遷移（`placePinByUser`・`changeElevationText`）では消える
 * （画面は遷移の結果でそのまま置き換えるだけにし、表示範囲を移すのを 1 回に限る判断をここに置く）
 */
export type SetupTransition = { state: SetupState; recenter?: LatLon };

/** セットアップ画面の見出し（［変更］と［地点を追加］で見分けが付くようにする。region のラベルも兼ねる） */
export const SETUP_TITLE = "地点の設定";
export const SETUP_ADD_TITLE = "地点を追加";

/** セットアップ画面の見出しの文言。開いた目的が「足す」なら「地点を追加」 */
export function setupTitle(mode: LocationEditMode = "change"): string {
  return mode === "add" ? SETUP_ADD_TITLE : SETUP_TITLE;
}

/**
 * セットアップ画面の初期状態。
 * - `add`（［地点を追加］で開いた）: 現在値があればその周りを見せるが**ピンは置かず**、標高は「0」。Geolocation も要求しない
 *   （現在値のピンを置くと、何もせず確定して同じ座標の地点が増えてしまう。ピンが無い間は確定できない）
 * - `change` で現在値があれば（［変更］で開いた）そこを中心・ピン・標高にし、Geolocation は要求しない
 * - `change` で現在値が無ければ（初回）仮の中心・ピン無し・標高「0」で Geolocation を要求し、結果待ちにする
 */
export function initialSetupState(current?: Location, mode: LocationEditMode = "change"): InitialSetupState {
  if (mode === "add") {
    return {
      center: current === undefined ? { ...DEFAULT_CENTER } : { lat: current.lat, lon: current.lon },
      geolocation: { phase: "idle" },
      elevationText: "0",
      requestGeolocation: false,
    };
  }
  if (current === undefined) {
    return {
      center: { ...DEFAULT_CENTER },
      geolocation: { phase: "pending" },
      elevationText: "0",
      requestGeolocation: true,
    };
  }
  const point = { lat: current.lat, lon: current.lon };
  return {
    center: point,
    pin: { ...point },
    pinSource: "current",
    geolocation: { phase: "idle" },
    // 丸めない（触らずに確定したとき保存値が変わらないように）
    elevationText: String(current.elevationM),
    requestGeolocation: false,
  };
}

/** キャンセル（メイン画面に戻る）を出すか。戻る先の地点があるときだけ */
export function canCancelSetup(current?: Location): boolean {
  return current !== undefined;
}

export type AppScreen = "setup" | "main" | "settings";

/**
 * 出す画面。地点が無い（保存値が無い・不正）か、［変更］［地点を追加］で編集中ならセットアップ。
 * 地点があり編集中でなく、［設定］を開いていれば設定画面（S-04）。
 * セットアップを設定画面より優先するので、設定画面から地点を編集して戻ると設定画面に戻る
 */
export function appScreen(location: Location | undefined, editing: boolean, settingsOpen = false): AppScreen {
  if (location === undefined || editing) {
    return "setup";
  }
  return settingsOpen ? "settings" : "main";
}

/**
 * 画面が切り替わったときにフォーカスを移す先。
 * setup-heading: セットアップの見出し / settings-heading: 設定の見出し /
 * location-change: ［地点を変更］ボタン / settings-button: ヘッダーの［設定］ボタン
 */
export type ScreenFocusTarget = "setup-heading" | "settings-heading" | "location-change" | "settings-button";

/**
 * 画面の切り替えでフォーカスを移す先。初回の表示（前の画面が無い）と、画面が変わらないときは移さない
 * （切り替えで押したボタンが消えてフォーカスが失われるのを防ぐ）。
 * メイン画面へ戻るときは、開いていた画面を開いたボタン（設定なら［設定］、セットアップなら［地点を変更］）へ戻す
 */
export function focusTargetOnScreenChange(
  previous: AppScreen | undefined,
  next: AppScreen,
): ScreenFocusTarget | undefined {
  if (previous === undefined || previous === next) {
    return undefined;
  }
  if (next === "setup") {
    return "setup-heading";
  }
  if (next === "settings") {
    return "settings-heading";
  }
  return previous === "settings" ? "settings-button" : "location-change";
}

/**
 * 位置の精度の表記。10m 単位に丸め（最小 10m）、丸めた値が 1000m 以上なら km（小数 1 桁）。
 * 例: 4 → 「約 10 m」、994 → 「約 990 m」、999・1000 → 「約 1.0 km」、12345 → 「約 12.3 km」
 */
export function formatAccuracy(accuracyM: number): string {
  const roundedM = Math.max(10, Math.round(accuracyM / 10) * 10);
  if (roundedM < 1000) {
    return `約 ${roundedM} m`;
  }
  return `約 ${(Math.round(accuracyM / 100) / 10).toFixed(1)} km`;
}

const FAILURE_REASON_TEXT: Record<GeolocationFailureReason, string> = {
  denied: "位置情報の利用が許可されていません",
  unavailable: "現在地を取得できませんでした",
  timeout: "現在地の取得に時間がかかりすぎました",
  unsupported: "このブラウザは位置情報に対応していません",
};

/** ピンが無いときの案内（ピンが無いまま確定しようとしたときのエラーにも使う） */
export const PIN_REQUIRED_MESSAGE = "地図をクリックして地点を指定してください";

/** ピンがあるときの確認の文言 */
export const CONFIRM_PIN_MESSAGE = "この場所でよいですか？";

/** 測位の結果待ちの案内 */
export const LOCATING_MESSAGE = "現在地を取得しています…";

/** 測位の精度が低いときの案内（AC-B2 の文をそのまま使う。精度はこの後ろに括弧で添える） */
const LOW_ACCURACY_MESSAGE = "位置の精度が低いため、地図をクリックして正しい地点を指定してください";

/**
 * 測位の成功で置いたピンの確認の文言。精度が低ければ地図での指定を促す。
 * どちらも文末に精度を括弧で添える（例「位置の精度が低いため、地図をクリックして正しい地点を指定してください（精度 約 5.4 km）」）
 */
function locatedPinMessage(accuracyM: number): string {
  const accuracy = `（精度 ${formatAccuracy(accuracyM)}）`;
  if (accuracyM <= LOW_ACCURACY_THRESHOLD_M) {
    return `${CONFIRM_PIN_MESSAGE}${accuracy}`;
  }
  return `${LOW_ACCURACY_MESSAGE}${accuracy}`;
}

/**
 * セットアップ画面の案内文。
 * - ピンがあり、現在値かユーザーが置いたもの → 確認の文言だけ（精度注記なし。M3-4）
 * - ピンがあり、測位の成功で置いたもの → 確認の文言に精度を添える（1km 超は精度が低い旨）
 * - ピンが無く結果待ち → 取得中
 * - ピンが無く測位に失敗 → 地図のクリックを案内し理由を添える
 * - それ以外のピン無し → 地図のクリックを案内
 */
export function setupMessage(state: SetupState): string {
  const { pin, pinSource, geolocation } = state;
  if (pin !== undefined) {
    if (pinSource === "geolocation" && geolocation.phase === "done" && geolocation.result.ok) {
      return locatedPinMessage(geolocation.result.accuracyM);
    }
    return CONFIRM_PIN_MESSAGE;
  }
  if (geolocation.phase === "pending") {
    return LOCATING_MESSAGE;
  }
  if (geolocation.phase === "done" && !geolocation.result.ok) {
    return `${PIN_REQUIRED_MESSAGE}（${FAILURE_REASON_TEXT[geolocation.result.reason]}）`;
  }
  return PIN_REQUIRED_MESSAGE;
}

/** 測位の結果から置くピン。成功ならその位置、失敗・結果無しなら undefined */
export function pinFromResult(result: GeolocationResult | undefined): LatLon | undefined {
  if (result === undefined || !result.ok) {
    return undefined;
  }
  return { lat: result.lat, lon: result.lon };
}

/**
 * 地図のクリック・ピンのドラッグで得た座標をピンにする。
 * Leaflet は横に繰り返した世界の上では経度が ±180 の外になるので [-180, 180] に折り返し、緯度は [-90, 90] に収める
 * （範囲外のまま保存すると次回の読み込みで不正値になりセットアップに戻ってしまうため）
 */
export function pinFromMapPoint(lat: number, lng: number): LatLon {
  const clampedLat = Math.min(90, Math.max(-90, lat));
  const wrappedLon = lng >= -180 && lng <= 180 ? lng : ((((lng + 180) % 360) + 360) % 360) - 180;
  return { lat: clampedLat, lon: wrappedLon };
}

/**
 * ユーザーが地図のクリック・ピンのドラッグでピンを置く。以後の測位結果ではピンを動かさない。
 * 表示範囲は移さない（`recenter` を持たない。前の遷移の `recenter` も引き継がない）
 */
export function placePinByUser(state: SetupState, point: MapPoint): SetupTransition {
  return { state: { ...state, pin: pinFromMapPoint(point.lat, point.lng), pinSource: "user" } };
}

/**
 * 測位の結果を反映する。
 * ユーザーが置いたピン（と［変更］で開いた現在値のピン）は動かさず、表示範囲も移さない（結果待ちの間の操作を上書きしない）。
 * ピンが無い（または測位で置いたピン）なら、成功のときだけ測位位置にピンを置いて表示範囲を移す。失敗ならピンを変えない
 */
export function applyGeolocationResult(state: SetupState, result: GeolocationResult): SetupTransition {
  const done: SetupState = { ...state, geolocation: { phase: "done", result } };
  const located = pinFromResult(result);
  if (located === undefined || state.pinSource === "user" || state.pinSource === "current") {
    return { state: done };
  }
  return { state: { ...done, pin: located, pinSource: "geolocation" }, recenter: { ...located } };
}

/** 標高の入力欄の文字列を変える。表示範囲は移さない（`recenter` を持たない。前の遷移の `recenter` も引き継がない） */
export function changeElevationText(state: SetupState, elevationText: string): SetupTransition {
  return { state: { ...state, elevationText } };
}

/**
 * 確定の下に出すエラー。標高の入力が不正なときだけ出す
 * （ピンが無いことは案内文と無効な確定ボタンで伝わるので、ここには出さない）
 */
export function confirmErrorText(state: SetupState): string | undefined {
  const elevation = parseElevationInput(state.elevationText);
  return elevation.ok ? undefined : elevation.error;
}

export type ConfirmResult = { ok: true; location: Location } | { ok: false; error: string };

/** ［この場所で確定］の可否と確定する地点。ピンが無い・標高が不正なら確定できない（ボタンを無効にする） */
export function confirmLocation(pin: LatLon | undefined, elevationText: string): ConfirmResult {
  if (pin === undefined) {
    return { ok: false, error: PIN_REQUIRED_MESSAGE };
  }
  const elevation = parseElevationInput(elevationText);
  if (!elevation.ok) {
    return { ok: false, error: elevation.error };
  }
  return { ok: true, location: { lat: pin.lat, lon: pin.lon, elevationM: elevation.value } };
}

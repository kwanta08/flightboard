// 一覧画面（ツールバーと一覧）の表示の判断と文言（AC-B4〜B9）。
// ListToolbar.tsx・FlightList.tsx・App.tsx はこの結果を描画・配線するだけにする。
import type { NearbyResponse } from "../../shared/types.ts";
import type { NearbyKind, NearbyParams } from "./api.ts";
import {
  buildRows,
  nextRadius,
  RADIUS_OPTIONS_KM,
  sortRows,
  summaryText,
  type FlightRow,
  type SortMode,
  type Visibility,
} from "./flightRows.ts";
import type { Units } from "./format.ts";
import { sameHex } from "./hex.ts";
import type { Location } from "./locationStore.ts";
import type { PollerState } from "./poller.ts";
import type { AppScreen } from "./setupFlow.ts";

// ---- 文言 ----

/** 一覧（listbox）のアクセシブルネーム */
export const FLIGHT_LIST_LABEL = "周辺の機体";

/** ツールバーの選択欄のラベル */
export const SORT_SELECT_LABEL = "並び替え";
export const KIND_SELECT_LABEL = "表示する種類";
export const RADIUS_SELECT_LABEL = "検索範囲";

/** 0 件のときの文言（AC-B7） */
export const EMPTY_LIST_MESSAGE = "近くに飛行機はいません";

/** 「半径を広げる」ボタンの文言の頭（AC-B7） */
export const WIDEN_RADIUS_LABEL = "半径を広げる";

/** 仰角の値に添える見出し（S-02「仰角 32°」） */
export const ELEVATION_LABEL = "仰角";

// ---- 並び替え ----

export type SortOption = { value: SortMode; label: string };

/** 並び替えの選択肢（AC-B5）。「高度順」は低い順（plan p1b「仮決めした解釈」） */
export const SORT_OPTIONS: ReadonlyArray<SortOption> = [
  { value: "distance", label: "近い順" },
  { value: "elevation", label: "仰角が高い順" },
  { value: "altitude", label: "高度順" },
  { value: "callsign", label: "便名順" },
];

export const DEFAULT_SORT: SortMode = "distance";

/** `<select>` の値を並び替えの種類に。選択肢に無ければ undefined */
export function sortModeFromValue(value: string): SortMode | undefined {
  return SORT_OPTIONS.find((option) => option.value === value)?.value;
}

// ---- 表示する種類 ----

export type KindOptionValue = "passenger,cargo" | "passenger" | "cargo";

export type KindOption = { value: KindOptionValue; label: string; kinds: ReadonlyArray<NearbyKind> };

const PASSENGER_AND_CARGO: ReadonlyArray<NearbyKind> = ["passenger", "cargo"];

/** 表示する種類の選択肢（AC-B5） */
export const KIND_OPTIONS: ReadonlyArray<KindOption> = [
  { value: "passenger,cargo", label: "旅客機＋貨物", kinds: PASSENGER_AND_CARGO },
  { value: "passenger", label: "旅客機のみ", kinds: ["passenger"] },
  { value: "cargo", label: "貨物のみ", kinds: ["cargo"] },
];

export const DEFAULT_KIND_OPTION: KindOptionValue = "passenger,cargo";

/** `<select>` の値を表示する種類に。選択肢に無ければ undefined */
export function kindOptionFromValue(value: string): KindOptionValue | undefined {
  return KIND_OPTIONS.find((option) => option.value === value)?.value;
}

function kindsFor(kindOption: KindOptionValue): ReadonlyArray<NearbyKind> {
  return KIND_OPTIONS.find((option) => option.value === kindOption)?.kinds ?? PASSENGER_AND_CARGO;
}

// ---- 半径 ----

export type RadiusOption = { km: number; value: string; label: string };

/** 半径の `<select>` の値 */
export function radiusOptionValue(km: number): string {
  return String(km);
}

/** 半径の選択肢の文言（例「半径 10km」） */
export function radiusLabel(km: number): string {
  return `半径 ${km}km`;
}

/** 半径の選択肢（AC-B5）。10 / 25 / 50 / 100 km */
export const RADIUS_OPTIONS: ReadonlyArray<RadiusOption> = RADIUS_OPTIONS_KM.map((km) => ({
  km,
  value: radiusOptionValue(km),
  label: radiusLabel(km),
}));

export const DEFAULT_RADIUS_KM = 50;

/** `<select>` の値を半径（km）に。選択肢に無ければ undefined */
export function radiusFromValue(value: string): number | undefined {
  return RADIUS_OPTIONS.find((option) => option.value === value)?.km;
}

/** 「半径を広げる（25km）」 */
export function widenRadiusLabel(km: number): string {
  return `${WIDEN_RADIUS_LABEL}（${km}km）`;
}

// ---- 取得の条件と行 ----

/**
 * 周辺の機体の取得条件。セットアップ画面の間と、地点が無いときは undefined（取得しない。
 * 地点が決まってメイン画面に戻ったら条件が決まり、取得し直す）。
 * 設定画面（S-04）の間は止めない（半径・更新間隔を変えた結果が、戻ったときに反映済みになるようにする。W6）
 */
export function nearbyParamsFor(
  screen: AppScreen,
  location: Location | undefined,
  radiusKm: number,
  kindOption: KindOptionValue,
): NearbyParams | undefined {
  if (screen === "setup" || location === undefined) {
    return undefined;
  }
  return { lat: location.lat, lon: location.lon, radiusKm, kinds: kindsFor(kindOption) };
}

/**
 * 一覧に出す行（応答の機体をすべて行にして並べる）。応答か地点が無ければ空。
 * `units` は高度・対地速度の表示の単位（省くと既定の m・km/h。F-09・AC-P2-72）。
 * 並び替えは単位に依らない（「高度順」のキーは行の `altitudeM`＝常に m）
 */
export function listRows(args: {
  data: NearbyResponse | undefined;
  location: Location | undefined;
  sortMode: SortMode;
  units?: Units;
}): FlightRow[] {
  if (args.data === undefined || args.location === undefined) {
    return [];
  }
  return sortRows(buildRows(args.data.flights, args.location, args.units), args.sortMode);
}

// ---- 一覧の本体 ----

/**
 * 一覧の本体に出すもの。
 * loading: まだ応答が無く失敗も無い / unavailable: 応答が無いまま失敗した（文言はツールバーの summaryFor に任せる） /
 * empty: 応答があり 0 件（`widenTo` は次の段の半径。100km なら無し） / rows: 行を出す
 */
export type ListBody =
  | { kind: "loading" }
  | { kind: "empty"; message: typeof EMPTY_LIST_MESSAGE; widenTo?: number }
  | { kind: "rows" }
  | { kind: "unavailable" };

export function listBody(args: {
  data: NearbyResponse | undefined;
  error: PollerState["error"];
  rows: readonly FlightRow[];
  radiusKm: number;
}): ListBody {
  if (args.data === undefined) {
    return args.error === undefined ? { kind: "loading" } : { kind: "unavailable" };
  }
  if (args.rows.length === 0) {
    const widenTo = nextRadius(args.radiusKm);
    return widenTo === undefined
      ? { kind: "empty", message: EMPTY_LIST_MESSAGE }
      : { kind: "empty", message: EMPTY_LIST_MESSAGE, widenTo };
  }
  return { kind: "rows" };
}

// ---- 「半径を広げる」の後のフォーカス（AC-B7・AC-B8） ----

/** 「半径を広げる」を押した後にフォーカスを移す先。list: 一覧 / widen-button: 次の段の「半径を広げる」 / radius-select: 半径の選択欄 */
export type WidenFocusTarget = "list" | "widen-button" | "radius-select";

/**
 * 「半径を広げる」を押した後にフォーカスを移す先（押したボタンは取得し直す間に消えるため）。
 * `pending` は新しい半径の結果を待っているか。待っていない、またはまだ結果が無い（loading・unavailable）なら undefined
 * （結果が出ないまま失敗した unavailable で待ちを終えるかは `advanceWidenFocus` が決める）。
 * 行があれば一覧、0 件で次の段があればその「半径を広げる」、0 件でこれ以上広げられなければ半径の選択欄
 */
export function focusAfterWiden(pending: boolean, body: ListBody): WidenFocusTarget | undefined {
  if (!pending) {
    return undefined;
  }
  switch (body.kind) {
    case "loading":
    case "unavailable":
      return undefined;
    case "rows":
      return "list";
    case "empty":
      return body.widenTo === undefined ? "radius-select" : "widen-button";
  }
}

/**
 * 「半径を広げる」の後の待ち。
 * idle: 待っていない /
 * requested: 押した直後。まだ古い半径の応答が残っている（poller が条件の変更でデータを消すのは、新しい半径での描画の後）/
 * waiting: 古いデータが消え、新しい半径の結果を待っている
 */
export type WidenFocusPhase = "idle" | "requested" | "waiting";

export type WidenFocusStep = { phase: WidenFocusPhase; target?: WidenFocusTarget };

/**
 * 描画のたびに「半径を広げる」の後の待ちを進める。
 * requested では、一覧の本体が loading・unavailable になる（古いデータが消えた）まで待つ（押した直後の描画の 0 件は古い半径のもの）。
 * waiting では、結果が出たら（`focusAfterWiden`）移す先を返して idle に戻る。
 * waiting のまま失敗した（unavailable）ら、半径の選択欄へ移して待ちを終える
 * （待ちに上限を設ける。再試行が数十秒後に成功しても、そのときにフォーカスを奪わない）
 */
export function advanceWidenFocus(phase: WidenFocusPhase, body: ListBody): WidenFocusStep {
  if (phase === "requested") {
    return body.kind === "loading" || body.kind === "unavailable" ? { phase: "waiting" } : { phase: "requested" };
  }
  if (phase === "waiting" && body.kind === "unavailable") {
    return { phase: "idle", target: "radius-select" };
  }
  const target = focusAfterWiden(phase === "waiting", body);
  return target === undefined ? { phase } : { phase: "idle", target };
}

/**
 * 利用者の操作の種類。
 * sort: 並び替え / kind: 表示する種類 / radius: 半径の選択欄 / location-change: 地点の［変更］ / select: 一覧・地図での機体の選択
 */
export type ListUserAction = "sort" | "kind" | "radius" | "location-change" | "select";

/**
 * 利用者の操作ごとに、「半径を広げる」の後のフォーカスの待ちをやめるか（true でやめる）。
 * 利用者が別の操作に移ったら、後から届いた結果でフォーカスを奪わない
 */
export const WIDEN_WAIT_CANCELLED_BY: Readonly<Record<ListUserAction, boolean>> = {
  sort: true,
  kind: true,
  radius: true,
  "location-change": true,
  select: true,
};

/** 利用者の操作の後の「半径を広げる」の待ち。表（`WIDEN_WAIT_CANCELLED_BY`）でやめる操作なら idle、それ以外はそのまま */
export function widenPhaseAfterUserAction(phase: WidenFocusPhase, action: ListUserAction): WidenFocusPhase {
  return WIDEN_WAIT_CANCELLED_BY[action] === true ? "idle" : phase;
}

// ---- 選択（詳細パネル）を保つか（AC-B2・AC-B12） ----

/**
 * 選択を保つか消すかを決める利用者の操作。
 * `ListUserAction` のうち機体の選択そのもの（select）を除いたもの（location-change は［地点を変更］でセットアップを開いたとき）に、
 * セットアップの［この場所で確定］（location-confirm）と［キャンセル］（location-cancel）を加える
 */
export type SelectionUserAction = Exclude<ListUserAction, "select"> | "location-confirm" | "location-cancel";

/**
 * 利用者の操作ごとに、選択を解除するか（true で解除し、詳細パネルを閉じる）。
 * 地点を確定したら解除する（前の地点で選んだ機体の詳細を、新しい地点からの距離・方角で出したままにしない）。
 * 並び替え・種類・半径と、セットアップを開いただけ・キャンセルでは保つ
 */
export const SELECTION_CLEARED_BY: Readonly<Record<SelectionUserAction, boolean>> = {
  sort: false,
  kind: false,
  radius: false,
  "location-change": false,
  "location-confirm": true,
  "location-cancel": false,
};

/** 利用者の操作の後の選択。表（`SELECTION_CLEARED_BY`）で解除する操作なら undefined、それ以外はそのまま */
export function selectionAfterUserAction(selectedHex: string | undefined, action: SelectionUserAction): string | undefined {
  return SELECTION_CLEARED_BY[action] === true ? undefined : selectedHex;
}

// ---- 詳細を閉じた後のフォーカス（AC-B8） ----

/** 詳細パネルを閉じた後にフォーカスを移す先（「半径を広げる」の後に移す先と同じ要素のうち、一覧か半径の選択欄） */
export type DetailCloseFocusTarget = Extract<WidenFocusTarget, "list" | "radius-select">;

/**
 * 詳細パネルを閉じた後にフォーカスを移す先（閉じるボタンがパネルと一緒に消えるため）。
 * 行があれば一覧、行が無い（取得中・失敗・0 件。FlightList は一覧の listbox を描画しない）なら半径の選択欄
 */
export function focusAfterDetailClose(body: ListBody): DetailCloseFocusTarget {
  return body.kind === "rows" ? "list" : "radius-select";
}

// ---- 行の表示 ----

/** 行のクラス名（styles.css と揃える） */
export const ROW_CLASS = "flight-row";
/** 仰角 10° 未満（hard・belowHorizon）の行を薄く表示する */
export const ROW_DIM_CLASS = "flight-row--dim";
export const ROW_SELECTED_CLASS = "flight-row--selected";
export const ROW_CARGO_CLASS = "flight-row--cargo";

const DIM_VISIBILITIES: ReadonlyArray<Visibility> = ["hard", "belowHorizon"];

/** 行のクラス名（空白区切り） */
export function rowClassNames(row: Pick<FlightRow, "visibility" | "isCargo">, selected: boolean): string {
  const classes = [ROW_CLASS];
  if (row.visibility !== undefined && DIM_VISIBILITIES.includes(row.visibility)) {
    classes.push(ROW_DIM_CLASS);
  }
  if (selected) {
    classes.push(ROW_SELECTED_CLASS);
  }
  if (row.isCargo) {
    classes.push(ROW_CARGO_CLASS);
  }
  return classes.join(" ");
}

/** 行が選択中か（hex は大文字小文字を区別しない） */
export function isRowSelected(hex: string, selectedHex: string | undefined): boolean {
  return selectedHex !== undefined && sameHex(hex, selectedHex);
}

/** 行の要素の id（`aria-activedescendant` と `scrollIntoView` で使う） */
export function flightRowId(hex: string): string {
  return `flight-row-${hex}`;
}

/**
 * 一覧の `aria-activedescendant`。選択中の機体が一覧にあればその行の id（行の hex で作る。hex は大文字小文字を区別しない）、
 * 無ければ undefined
 */
export function activeDescendantId(rows: ReadonlyArray<Pick<FlightRow, "hex">>, selectedHex: string | undefined): string | undefined {
  if (selectedHex === undefined) {
    return undefined;
  }
  const selected = rows.find((row) => sameHex(row.hex, selectedHex));
  return selected === undefined ? undefined : flightRowId(selected.hex);
}

/** 行の仰角の表示（「仰角 1.1°」） */
export function rowElevationText(row: Pick<FlightRow, "elevationText">): string {
  return `${ELEVATION_LABEL} ${row.elevationText}`;
}

// ---- ツールバー ----

/** 一覧の上の要約。`text` は件数と更新の文言、`detail` は要約の要素の `title`（ツールチップ）に出す失敗の文言（失敗中だけある） */
export type SummaryView = { text: string; detail?: string };

/**
 * 一覧の上の件数と更新の文言（AC-B5・AC-B9、計画 M3-1）。件数は応答の機体数（= 一覧の行数。種類の絞り込みはサーバー側で済んでいる）。
 * 失敗中だけ `detail` に失敗の文言（`PollerState.error.message`。api.ts が組み立てた「サーバーに接続できませんでした」やサーバーの `error` など）を入れる
 * （文言の「更新できません（N 秒前のデータ）」は変えずに、ツールチップで失敗の中身を見分けられるようにする）。成功・取得中は `detail` を持たない
 */
export function summaryFor(state: Pick<PollerState, "data" | "error">, now: number): SummaryView {
  const text = summaryText({
    count: state.data?.flights.length ?? 0,
    updatedAt: state.data?.updatedAt,
    now,
    failed: state.error !== undefined,
  });
  return state.error === undefined ? { text } : { text, detail: state.error.message };
}

// 詳細パネルの取得状態の遷移と出し分け（AC-B12・AC-B10 の航跡の受け渡し）。純粋関数だけを置く。
// React への配線は hooks/useFlightDetail.ts、表示の文言は lib/detailView.ts。
import type { FlightDetailResponse } from "../../shared/types.ts";
import { isAbortError } from "./api.ts";
import { sameHex } from "./hex.ts";
import type { SelectedTrack } from "./mapView.ts";

/**
 * 取得状態の種類。
 * idle: 未選択 / loading: 選択中の機体の結果がまだ無く取得中 /
 * loaded・not-found・error: 選択中の機体について最後に届いた結果（成功・404・中断以外の失敗）
 */
export type DetailStatus = "idle" | "loading" | "loaded" | "not-found" | "error";

/**
 * 詳細の取得状態。
 * `hex` は選択中の機体（未選択なら undefined で `idle`）、`status` は最後の結果（まだ結果が無ければ `loading`）、
 * `detail` は `hex` の機体について最後に取得できた詳細、
 * `pending` は最後の結果（loaded・not-found・error）を持ったまま同じ機体を取り直しているか（取り直し中だけ true。次の結果で消える）
 */
export type DetailState = { hex?: string; status: DetailStatus; detail?: FlightDetailResponse; pending?: boolean };

export type DetailEvent =
  /** 選択の変更（`hex` が undefined なら選択解除） */
  | { type: "select"; hex?: string }
  /** 選択中の機体の詳細の取得を始めた（選択の直後と、ポーリングの成功ごと） */
  | { type: "request" }
  | { type: "success"; hex: string; detail: FlightDetailResponse }
  /** 404（範囲外に出た等） */
  | { type: "not-found"; hex: string }
  /** 中断以外の失敗（期限切れを含む） */
  | { type: "failure"; hex: string };

export const INITIAL_DETAIL_STATE: DetailState = { status: "idle" };

/**
 * 取得状態の遷移。
 * - select: 別の hex に変わったら最後の結果と `detail` を消して `loading`（hex が undefined なら `idle`）。同じ hex なら変えない
 * - request: 同じ hex の取り直しでは、最後の結果（`status`）と `detail` を残したまま `pending` にする
 *   （404・失敗の案内も詳細も取得中に戻さない）。まだ結果が無い（`loading`）か、すでに取り直し中なら変えない（同じオブジェクト）。
 *   未選択なら変えない
 * - success / not-found / failure: 結果の `hex` が現在の選択と違えば捨てる。結果を最後の結果にし、`pending` を消す。
 *   404 は `not-found`（`detail` を消す）、失敗は `error`（同じ hex の `detail` があれば残す）
 * hex が同じかは大文字小文字を区別しない（`sameHex`）
 */
export function reduceDetailState(state: DetailState, event: DetailEvent): DetailState {
  switch (event.type) {
    case "select":
      if (sameSelection(event.hex, state.hex)) {
        return state;
      }
      return event.hex === undefined ? INITIAL_DETAIL_STATE : { hex: event.hex, status: "loading" };
    case "request":
      if (state.hex === undefined || state.status === "loading" || state.pending === true) {
        return state;
      }
      return { ...state, pending: true };
    case "success":
      if (!sameSelection(event.hex, state.hex)) {
        return state;
      }
      return { hex: event.hex, status: "loaded", detail: event.detail };
    case "not-found":
      if (!sameSelection(event.hex, state.hex)) {
        return state;
      }
      return { hex: event.hex, status: "not-found" };
    case "failure":
      if (!sameSelection(event.hex, state.hex)) {
        return state;
      }
      return state.detail === undefined
        ? { hex: event.hex, status: "error" }
        : { hex: event.hex, status: "error", detail: state.detail };
  }
}

/** 2 つの選択（hex。未選択は undefined）が同じ機体か。どちらも未選択なら同じ、片方だけ未選択なら違う。hex は大文字小文字を区別しない */
function sameSelection(a: string | undefined, b: string | undefined): boolean {
  return a === undefined || b === undefined ? a === b : sameHex(a, b);
}

/**
 * 選択 `hex` に合わせた取得状態。状態が同じ hex のものならそのまま、違えば選択を変えた後の状態
 * （選択を変えた描画で、前の機体の詳細や航跡を一瞬でも出さないため。reducer への反映は副作用の中で行われ、描画より遅れる）
 */
export function detailStateFor(state: DetailState, hex: string | undefined): DetailState {
  return reduceDetailState(state, { type: "select", hex });
}

/** 詳細パネルを開いているか（機体を選択中か） */
export function isDetailOpen(state: DetailState): boolean {
  return state.hex !== undefined;
}

/**
 * 詳細を取り直すきっかけのキー（ポーリングが成功した時刻 `receivedAt`）。
 * `receivedAt` が undefined（条件の変更でポーラーがデータを消した）なら前回のキー `previous` を保つ
 * （消えただけでは取り直さず、新しい条件での成功で 1 回だけ取り直す）
 */
export function detailRefreshKey(receivedAt: number | undefined, previous: number | undefined): number | undefined {
  return receivedAt ?? previous;
}

/** 取得の結果を遷移のイベントにする */
export function detailResultEvent(hex: string, result: FlightDetailResponse | "not-found"): DetailEvent {
  return result === "not-found" ? { type: "not-found", hex } : { type: "success", hex, detail: result };
}

/**
 * 詳細の要求を中断した理由。
 * timeout: 期限（ポーラーと同じ `DEFAULT_REQUEST_TIMEOUT_MS`）までに決着しなかった /
 * superseded: 選択の変更・取り直し・アンマウントで要らなくなった
 */
export type DetailAbortReason = "timeout" | "superseded";

/**
 * 取得の例外を遷移のイベントにする。
 * - 期限切れで中断した（`abortReason` が timeout）なら failure（応答が無いことを失敗として出す）
 * - 利用者の操作などで要らなくなって中断した（superseded）なら undefined（成功にも失敗にも数えない。行き違いで届いた失敗も数えない）
 * - 中断していなければ、中断の例外（`isAbortError`）なら undefined、それ以外は failure
 */
export function detailFailureEvent(hex: string, error: unknown, abortReason?: DetailAbortReason): DetailEvent | undefined {
  switch (abortReason) {
    case "timeout":
      return { type: "failure", hex };
    case "superseded":
      return undefined;
    default:
      return isAbortError(error) ? undefined : { type: "failure", hex };
  }
}

/**
 * 地図に渡す航跡（どの機体のものかの `hex` と `track` の点）。選択中の機体の詳細が取れているときだけ返す。
 * 詳細の hex（状態の hex。reducer が詳細をその hex の結果に限る）が選択と違う（まだ前の機体の詳細が残っている）なら undefined
 * （hex は大文字小文字を区別しない）。
 * `points` の参照は詳細が変わるまで同じ（呼ぶたびに作るオブジェクトの使い回しは mapView.ts の `reuseTrack`）
 */
export function trackForSelection(state: DetailState, selectedHex: string | undefined): SelectedTrack | undefined {
  if (selectedHex === undefined || state.hex === undefined || !sameHex(state.hex, selectedHex) || state.detail === undefined) {
    return undefined;
  }
  return { hex: state.hex, points: state.detail.track };
}

/**
 * パネルの本体に出すもの。最後の結果があれば、取り直し中もその結果を出す。
 * empty: 未選択 / loading: まだ結果が無く取得中 / view: 詳細がある（取り直し中・失敗中でも出す。失敗中の案内は detailView.ts が状態から決める）/
 * not-found: 最後の結果が 404 / error: 詳細が無いまま最後の取得が失敗した
 */
export type DetailBody =
  | { kind: "empty" }
  | { kind: "loading" }
  | { kind: "view"; detail: FlightDetailResponse }
  | { kind: "not-found" }
  | { kind: "error" };

export function detailBody(state: DetailState): DetailBody {
  if (state.hex === undefined) {
    return { kind: "empty" };
  }
  if (state.detail !== undefined) {
    return { kind: "view", detail: state.detail };
  }
  switch (state.status) {
    case "not-found":
      return { kind: "not-found" };
    case "error":
      return { kind: "error" };
    default:
      return { kind: "loading" };
  }
}

// 選択中の機体の詳細の取得を React に配線する（AC-B12）。
// 判断は lib/detailState.ts（状態の遷移・結果と中断の理由のイベント化・選択に合わせた状態）と lib/api.ts（要求）に置き、
// ここはブラウザの API をつなぐだけにする。
import { useEffect, useReducer } from "react";
import { fetchFlightDetail } from "../lib/api.ts";
import {
  detailFailureEvent,
  detailResultEvent,
  detailStateFor,
  INITIAL_DETAIL_STATE,
  reduceDetailState,
  type DetailAbortReason,
  type DetailState,
} from "../lib/detailState.ts";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "../lib/poller.ts";

/**
 * 選択中の機体 `hex` の詳細を取得し、その状態を返す。
 * `hex` か `refreshKey`（ポーリングが成功した時刻）が変わるたびに取得し直す（前の要求は中断し、中断は無視する）。
 * 要求は期限（ポーラーと同じ `DEFAULT_REQUEST_TIMEOUT_MS`）で中断し、期限切れは失敗に数える。
 * `hex` が undefined なら何も送らない
 */
export function useFlightDetail(hex: string | undefined, refreshKey: number | undefined): DetailState {
  const [state, dispatch] = useReducer(reduceDetailState, INITIAL_DETAIL_STATE);

  useEffect(() => {
    dispatch({ type: "select", hex });
    if (hex === undefined) return;
    dispatch({ type: "request" });
    const controller = new AbortController();
    // 中断した理由（先に起きたほう）。失敗に数えるかは lib の detailFailureEvent が決める
    let abortReason: DetailAbortReason | undefined;
    const abort = (reason: DetailAbortReason) => {
      abortReason ??= reason;
      controller.abort();
    };
    const timeoutId = window.setTimeout(() => abort("timeout"), DEFAULT_REQUEST_TIMEOUT_MS);
    fetchFlightDetail(hex, { fetch: (input, init) => window.fetch(input, init), signal: controller.signal }).then(
      (result) => {
        window.clearTimeout(timeoutId);
        dispatch(detailResultEvent(hex, result));
      },
      (error: unknown) => {
        window.clearTimeout(timeoutId);
        const event = detailFailureEvent(hex, error, abortReason);
        if (event !== undefined) dispatch(event);
      },
    );
    // 選択の変更・取り直し・アンマウントでは期限のタイマーを消して中断する（この中断は失敗に数えない）
    return () => {
      window.clearTimeout(timeoutId);
      abort("superseded");
    };
  }, [hex, refreshKey]);

  // 選択を変えた描画では reducer への反映がまだなので、選択に合わせた状態を返す
  return detailStateFor(state, hex);
}

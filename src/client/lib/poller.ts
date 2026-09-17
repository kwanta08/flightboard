// 周辺の機体の自動更新（F-06・§5・AC-B9・AC-B5）。
// 取得処理・タイマー・可視状態・時計は注入する（テストでは偽物を渡す）。React への配線は hooks/useNearby.ts。
import type { NearbyResponse } from "../../shared/types.ts";
import { isAbortError } from "./api.ts";

/** 自動更新の間隔（ms） */
export const DEFAULT_POLL_INTERVAL_MS = 10_000;

/** 要求の期限（ms）。これを過ぎても決着しなければ要求を中断し、失敗に数える */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** 失敗の例外に文言が無いときの既定の文言 */
const MESSAGE_LOAD_FAILED = "更新できませんでした";

/** 要求が期限までに決着しなかったときの文言 */
const MESSAGE_TIMEOUT = "応答がありません";

/** タブの可視状態（一覧の行の見え方の区分 `flightRows.ts` の `Visibility` とは別） */
export type TabVisibility = {
  isVisible(): boolean;
  /** 可視状態が変わるたびに `onChange` を呼ぶ。戻り値で購読を解除する */
  subscribe(onChange: () => void): () => void;
};

/** `document` の `visibilityState` と `visibilitychange` で可視状態を返す */
export function documentVisibility(
  doc: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">,
): TabVisibility {
  return {
    isVisible: () => doc.visibilityState === "visible",
    subscribe(onChange) {
      const listener = (): void => onChange();
      doc.addEventListener("visibilitychange", listener);
      return () => doc.removeEventListener("visibilitychange", listener);
    },
  };
}

export type Timers = {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
};

export type PollerState = {
  /** 最後に取得できた応答（条件のキーが変わったら消える） */
  data?: NearbyResponse;
  /** `data` を受け取った時刻（`now()`） */
  receivedAt?: number;
  /** 最後の取得が失敗しているとき（次の成功と、条件のキーの変更で消える） */
  error?: { at: number; message: string };
  /** 最新の要求が進行中か */
  loading: boolean;
};

export type PollerOptions<P> = {
  /** 条件 `params` で 1 回取得する。`signal` が中断されたら中断の例外（`isAbortError`）で失敗してよい */
  load: (params: P, signal: AbortSignal) => Promise<NearbyResponse>;
  /** 自動更新の間隔（ms）の初期値。既定 10 秒（後から `setIntervalMs` で変えられる） */
  intervalMs?: number;
  /** 要求の期限（ms）。既定 15 秒。過ぎたら要求を中断し、失敗（「応答がありません」）に数える */
  requestTimeoutMs?: number;
  /**
   * 条件を値で比べるためのキー。既定は `JSON.stringify`。
   * `start`・`setParams` で、いまの `data`・`error` を得た条件とキーが異なれば、それらを即座に消す
   */
  paramsKey?: (params: P) => string;
  timers: Timers;
  visibility: TabVisibility;
  /** 現在時刻（ms） */
  now: () => number;
};

export type Poller<P> = {
  /**
   * 条件を覚えて自動更新を始める（条件のキーが変わればデータと失敗を消す）。
   * 表示中なら進行中の要求を中断して即座に 1 本送り、刻みをそこから数え直す。停止後に呼ぶと再開する
   */
  start(params: P): void;
  /**
   * 条件を覚える（条件のキーが変わればデータと失敗を消す）。
   * 開始済みかつ表示中なら進行中の要求を中断して即座に 1 本送り、刻みをそこから数え直す
   */
  setParams(params: P): void;
  /**
   * 自動更新の間隔を変える（F-06 の設定。再読み込みなしで実行中のポーリングに反映する。AC-P2-74）。
   * 開始済みなら刻みのタイマーを作り直す（次の刻みはここから `intervalMs` 後）。要求はここでは送らない。
   * 正の有限値でなければ（0・負数・NaN・Infinity）無視して今の間隔のままにする
   */
  setIntervalMs(intervalMs: number): void;
  /** 自動更新をやめる（タイマーと可視状態の購読を解除し、進行中の要求を中断する） */
  stop(): void;
  /** 現在の状態。状態が変わるまで同じオブジェクトを返す */
  getState(): PollerState;
  /** 状態が変わるたびに `listener` を呼ぶ。戻り値で購読を解除する */
  subscribe(listener: () => void): () => void;
};

/** 送った要求。`revision` は送ったときの条件の版、`timeoutId` は期限のタイマー */
type PendingRequest = { controller: AbortController; revision: number; timeoutId: unknown };

/** 開始済みの間だけ持つ、刻みのタイマーと可視状態の購読 */
type Running = { timerId: unknown; unsubscribe: () => void };

/** 自動更新の間隔として使える値か。0・負数・NaN・Infinity は使えない（刻みが即時になり、応答のたびに送り続けてしまう） */
function isUsableIntervalMs(ms: number): boolean {
  return Number.isFinite(ms) && ms > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : MESSAGE_LOAD_FAILED;
}

/**
 * 自動更新を作る。規則:
 * - 表示中の `start`・`setParams` と、開始済みで表示に戻ったときは、進行中の要求を中断して即座に 1 本送り、
 *   刻みのタイマーを作り直す（次の刻みはその送信から `intervalMs` 後）
 * - タイマーの刻みでは、開始済み・表示中・進行中の要求が無いときだけ送る（刻みによる送信ではタイマーを作り直さない）
 * - 非表示の間は何も送らない（`start`・`setParams` は条件を覚えるだけで、進行中の要求も中断しない）
 * - `start`・`setParams` で条件のキーが変わったら、表示中・非表示にかかわらず `data`・`receivedAt`・`error` を即座に消す
 *   （古い条件のデータを新しい条件のものとして出さない）
 * - 成功で `data`・`receivedAt` を更新して `error` を消す。失敗で `data`・`receivedAt` を残して `error` を立てる（同じ条件での失敗）
 * - 要求が `requestTimeoutMs` までに決着しなければ中断し、中断ではなく失敗（「応答がありません」）に数える。その後に届いた結果は捨てる
 * - 中断した要求・最新でない要求・古い条件の要求の結果は捨てる（成功にも失敗にも数えない）
 */
export function createPoller<P>(options: PollerOptions<P>): Poller<P> {
  const {
    load,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    paramsKey = JSON.stringify,
    timers,
    visibility,
    now,
  } = options;

  /** 自動更新の間隔（`setIntervalMs` で変わる） */
  let intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  /** 最後に覚えた条件 */
  let params: { value: P } | undefined;
  /** 条件の版。条件を覚えるたびに増やし、古い条件で送った要求の結果を捨てるのに使う */
  let revision = 0;
  /** いまの `data`・`error` が属する条件のキー（条件を覚えたときに更新する。まだ条件が無ければ undefined） */
  let stateKey: string | undefined;
  /** 開始済みなら defined */
  let running: Running | undefined;
  /** 最新の要求が進行中なら defined（中断・完了・期限切れで undefined） */
  let pending: PendingRequest | undefined;
  let state: PollerState = { loading: false };
  const listeners = new Set<() => void>();

  function update(next: PollerState): void {
    state = next;
    for (const listener of [...listeners]) {
      listener();
    }
  }

  function setLoading(loading: boolean): void {
    if (state.loading !== loading) {
      update({ ...state, loading });
    }
  }

  /** 条件を覚える。キーが変わったら、古い条件で得た `data`・`receivedAt`・`error` を消す（消すものがあるときだけ通知する） */
  function remember(next: P): void {
    params = { value: next };
    revision += 1;
    const key = paramsKey(next);
    if (key === stateKey) return;
    stateKey = key;
    if (state.data !== undefined || state.receivedAt !== undefined || state.error !== undefined) {
      update({ loading: state.loading });
    }
  }

  /** 最新の要求を進行中から外し、期限のタイマーを解除する。最新の要求でなければ何もせず false */
  function release(request: PendingRequest): boolean {
    if (request !== pending) return false;
    pending = undefined;
    timers.clearTimeout(request.timeoutId);
    return true;
  }

  function abortPending(): void {
    const request = pending;
    if (request === undefined) return;
    release(request);
    request.controller.abort();
  }

  function isStartedAndVisible(): boolean {
    return running !== undefined && visibility.isVisible();
  }

  /** 完了した要求の結果を反映する。中断・置き換え・期限切れ済みの要求は捨て、古い条件の要求は進行中を解くだけにする */
  function settle(request: PendingRequest, next: () => PollerState): void {
    if (!release(request)) return;
    if (request.revision !== revision) {
      setLoading(false);
      return;
    }
    update(next());
  }

  function failedState(message: string): PollerState {
    return { ...state, error: { at: now(), message }, loading: false };
  }

  /** 期限までに決着しなかった要求を失敗に数えてから中断する（先に最新の要求から外すので、中断による失敗の結果は捨てられる） */
  function expire(request: PendingRequest): void {
    if (request !== pending) return;
    settle(request, () => failedState(MESSAGE_TIMEOUT));
    request.controller.abort();
  }

  /** 進行中の要求を中断して、覚えている条件で 1 本送る */
  function send(): void {
    if (params === undefined) return;
    abortPending();
    const request: PendingRequest = {
      controller: new AbortController(),
      revision,
      timeoutId: timers.setTimeout(() => expire(request), requestTimeoutMs),
    };
    pending = request;
    setLoading(true);

    let result: Promise<NearbyResponse>;
    try {
      result = load(params.value, request.controller.signal);
    } catch (error) {
      result = Promise.reject(error);
    }
    result.then(
      (data) => settle(request, () => ({ data, receivedAt: now(), loading: false })),
      (error: unknown) =>
        settle(request, () => (isAbortError(error) ? { ...state, loading: false } : failedState(errorMessage(error)))),
    );
  }

  /** 刻みのタイマーを作り直す（次の刻みを今から `intervalMs` 後にする） */
  function restartTimer(current: Running): void {
    timers.clearInterval(current.timerId);
    current.timerId = timers.setInterval(onTick, intervalMs);
  }

  /** 刻み以外のきっかけで即座に 1 本送る。刻みをこの送信から数え直す（直後に刻みが来て 10 秒未満で続けて送らないように） */
  function sendNow(): void {
    if (running !== undefined) restartTimer(running);
    send();
  }

  function onVisibilityChange(): void {
    if (isStartedAndVisible()) sendNow();
  }

  function onTick(): void {
    if (isStartedAndVisible() && pending === undefined) send();
  }

  return {
    start(next) {
      remember(next);
      if (running === undefined) {
        const unsubscribe = visibility.subscribe(onVisibilityChange);
        const timerId = timers.setInterval(onTick, intervalMs);
        running = { timerId, unsubscribe };
        // 作ったばかりのタイマーは今から数えているので、作り直さずに送る
        if (visibility.isVisible()) send();
        return;
      }
      if (visibility.isVisible()) sendNow();
    },

    setParams(next) {
      remember(next);
      if (isStartedAndVisible()) sendNow();
    },

    setIntervalMs(next) {
      // 使えない値は黙って無視する（公開 API なので、呼び出し側の検証に頼らない）
      if (!isUsableIntervalMs(next) || next === intervalMs) return;
      intervalMs = next;
      // 開始済みなら新しい間隔で刻み直す（進行中の要求はそのまま。間隔を変えただけで 1 本増やさない）
      if (running !== undefined) restartTimer(running);
    },

    stop() {
      const current = running;
      running = undefined;
      if (current !== undefined) {
        timers.clearInterval(current.timerId);
        current.unsubscribe();
      }
      abortPending();
      setLoading(false);
    },

    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

import { describe, expect, it, vi } from "vitest";
import type { NearbyResponse } from "../../shared/types.ts";
import {
  createPoller,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  documentVisibility,
  type PollerOptions,
  type Timers,
  type TabVisibility,
} from "./poller.ts";

type Params = { area: string };

const A: Params = { area: "A" };
const B: Params = { area: "B" };
const C: Params = { area: "C" };

function response(updatedAt: string): NearbyResponse {
  return { updatedAt, source: "adsblol", flights: [], airportOps: [] };
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/** 決着済みの Promise のコールバックを流す（ポーラーはタイマーを注入しているので実時間は進めない） */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 手で進められる偽タイマー。
 * `tick` は動いている刻み（setInterval）をすべて 1 回ずつ呼ぶ（仮想の時刻は進めず、期限（setTimeout）は呼ばない）。
 * `advance` は仮想の時刻を進め、時刻が来た刻みと期限を時刻順に呼ぶ。1 つのテストではどちらか一方だけを使う
 */
function fakeTimers() {
  type Kind = "interval" | "timeout";
  type Entry = { id: number; fn: () => void; ms: number; kind: Kind; dueAt: number };
  type Created = { id: number; fn: () => void; ms: number };
  const active = new Map<number, Entry>();
  /** 作った刻み（setInterval） */
  const created: Created[] = [];
  /** clearInterval に渡された id */
  const cleared: unknown[] = [];
  /** 作った期限（setTimeout） */
  const createdTimeouts: Created[] = [];
  /** clearTimeout に渡された id */
  const clearedTimeouts: unknown[] = [];
  let nextId = 1;
  let current = 0;

  const add = (kind: Kind, fn: () => void, ms: number): number => {
    const id = nextId++;
    active.set(id, { id, fn, ms, kind, dueAt: current + ms });
    return id;
  };
  /** 種類が合うときだけ解除する（clearInterval で期限を、clearTimeout で刻みを解除する誤りを見逃さない） */
  const remove = (kind: Kind, id: unknown): void => {
    const entry = active.get(id as number);
    if (entry?.kind === kind) active.delete(entry.id);
  };
  const activeOf = (kind: Kind): Entry[] => [...active.values()].filter((entry) => entry.kind === kind);

  const timers: Timers = {
    setInterval(fn, ms) {
      const id = add("interval", fn, ms);
      created.push({ id, fn, ms });
      return id;
    },
    clearInterval(id) {
      cleared.push(id);
      remove("interval", id);
    },
    setTimeout(fn, ms) {
      const id = add("timeout", fn, ms);
      createdTimeouts.push({ id, fn, ms });
      return id;
    },
    clearTimeout(id) {
      clearedTimeouts.push(id);
      remove("timeout", id);
    },
  };
  return {
    timers,
    created,
    cleared,
    createdTimeouts,
    clearedTimeouts,
    /** 動いている刻みをすべて `times` 刻み進める */
    tick(times = 1) {
      for (let i = 0; i < times; i++) {
        for (const entry of activeOf("interval")) {
          if (active.has(entry.id)) entry.fn();
        }
      }
    },
    /** 仮想の時刻を `ms` 進め、その間に時刻が来た刻みと期限を時刻順に呼ぶ */
    advance(ms: number) {
      const target = current + ms;
      for (;;) {
        let next: Entry | undefined;
        for (const entry of active.values()) {
          if (entry.dueAt <= target && (next === undefined || entry.dueAt < next.dueAt)) next = entry;
        }
        if (next === undefined) break;
        current = next.dueAt;
        if (next.kind === "interval") {
          next.dueAt += next.ms;
        } else {
          active.delete(next.id);
        }
        next.fn();
      }
      current = target;
    },
    /** 動いている刻みの数 */
    activeCount: () => activeOf("interval").length,
    /** 動いている期限の数 */
    activeTimeoutCount: () => activeOf("timeout").length,
  };
}

/** 手で切り替えて通知できる偽の可視状態 */
function fakeVisibility(initiallyVisible: boolean) {
  let visible = initiallyVisible;
  const listeners = new Set<() => void>();
  /** 購読されたコールバック（解除後も残す。解除前に届いた通知を後から呼ぶため） */
  const subscribed: Array<() => void> = [];
  let unsubscribeCount = 0;
  const visibility: TabVisibility = {
    isVisible: () => visible,
    subscribe(onChange) {
      listeners.add(onChange);
      subscribed.push(onChange);
      return () => {
        unsubscribeCount += 1;
        listeners.delete(onChange);
      };
    },
  };
  const set = (next: boolean) => {
    visible = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    visibility,
    subscribed,
    hide: () => set(false),
    show: () => set(true),
    listenerCount: () => listeners.size,
    unsubscribeCount: () => unsubscribeCount,
  };
}

type LoadCall = {
  params: Params;
  signal: AbortSignal;
  resolve: (data: NearbyResponse) => void;
  reject: (error: unknown) => void;
};

/** 解決を手で制御できる偽の load（中断されても自分では決着しない） */
function fakeLoad() {
  const calls: LoadCall[] = [];
  const load = (params: Params, signal: AbortSignal) =>
    new Promise<NearbyResponse>((resolve, reject) => {
      calls.push({ params, signal, resolve, reject });
    });
  const call = (index: number): LoadCall => {
    const found = calls[index];
    if (found === undefined) throw new Error(`load の ${index + 1} 回目の呼び出しがありません`);
    return found;
  };
  return { load, calls, call };
}

function setup(
  options: {
    visible?: boolean;
    intervalMs?: number;
    requestTimeoutMs?: number;
    paramsKey?: PollerOptions<Params>["paramsKey"];
    load?: PollerOptions<Params>["load"];
  } = {},
) {
  const timers = fakeTimers();
  const vis = fakeVisibility(options.visible ?? true);
  const loader = fakeLoad();
  const clock = { now: 1_000 };
  const poller = createPoller<Params>({
    load: options.load ?? loader.load,
    intervalMs: options.intervalMs,
    requestTimeoutMs: options.requestTimeoutMs,
    paramsKey: options.paramsKey,
    timers: timers.timers,
    visibility: vis.visibility,
    now: () => clock.now,
  });
  return { poller, timers, vis, loader, clock };
}

describe("createPoller: 開始と 10 秒刻み", () => {
  it("表示中に start すると即 1 回送り、以後 10 秒ごとに送る", async () => {
    const { poller, timers, loader } = setup();
    poller.start(A);
    expect(loader.calls).toHaveLength(1);
    expect(loader.call(0).params).toEqual(A);
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(10_000);
    expect(timers.created.map((t) => t.ms)).toEqual([10_000]);

    loader.call(0).resolve(response("t1"));
    await flush();
    timers.tick();
    expect(loader.calls).toHaveLength(2);

    loader.call(1).resolve(response("t2"));
    await flush();
    timers.tick();
    expect(loader.calls).toHaveLength(3);
    expect(loader.calls.map((c) => c.params)).toEqual([A, A, A]);
  });

  it("intervalMs を指定するとその間隔でタイマーを作る", () => {
    const { poller, timers } = setup({ intervalMs: 3_000 });
    poller.start(A);
    expect(timers.created.map((t) => t.ms)).toEqual([3_000]);
  });

  it("進行中の要求があれば刻みで送らず、完了した後の次の刻みで送る", async () => {
    const { poller, timers, loader } = setup();
    poller.start(A);
    timers.tick(3);
    expect(loader.calls).toHaveLength(1);
    expect(loader.call(0).signal.aborted).toBe(false);

    loader.call(0).resolve(response("t1"));
    await flush();
    expect(loader.calls).toHaveLength(1); // 完了しただけでは送らない
    timers.tick();
    expect(loader.calls).toHaveLength(2);

    // 失敗で完了した場合も同じ
    timers.tick(2);
    expect(loader.calls).toHaveLength(2);
    loader.call(1).reject(new Error("失敗"));
    await flush();
    timers.tick();
    expect(loader.calls).toHaveLength(3);
  });

  it("非表示の間は刻みで送らず、表示に戻ると刻みが何回溜まっていても即 1 回だけ送る", async () => {
    const { poller, timers, vis, loader } = setup();
    poller.start(A);
    loader.call(0).resolve(response("t1"));
    await flush();

    vis.hide();
    timers.tick(5);
    expect(loader.calls).toHaveLength(1);

    vis.show();
    expect(loader.calls).toHaveLength(2);
    await flush();
    expect(loader.calls).toHaveLength(2);
    timers.tick(); // 表示に戻した要求が進行中なので送らない
    expect(loader.calls).toHaveLength(2);
  });

  it("非表示のまま start すると 0 回、表示に戻ると 1 回", () => {
    const { poller, timers, vis, loader } = setup({ visible: false });
    poller.start(A);
    timers.tick(3);
    expect(loader.calls).toHaveLength(0);

    vis.show();
    expect(loader.calls).toHaveLength(1);
    expect(loader.call(0).params).toEqual(A);
  });

  it("非表示中に setParams すると 0 回、表示に戻ると最後の新しい条件で 1 回だけ", async () => {
    const { poller, timers, vis, loader } = setup();
    poller.start(A);
    loader.call(0).resolve(response("t1"));
    await flush();

    vis.hide();
    poller.setParams(B);
    poller.setParams(C);
    timers.tick(2);
    expect(loader.calls).toHaveLength(1);

    vis.show();
    expect(loader.calls).toHaveLength(2);
    expect(loader.call(1).params).toEqual(C);
  });

  it("非表示になっても進行中の要求は中断せず、その結果を反映する", async () => {
    const { poller, vis, loader } = setup();
    poller.start(A);
    vis.hide();
    expect(loader.call(0).signal.aborted).toBe(false);

    loader.call(0).resolve(response("t1"));
    await flush();
    expect(poller.getState().data).toEqual(response("t1"));
  });

  it("非表示中に条件を変えると、非表示の前から進行中の要求の結果は古い条件のものとして捨てる", async () => {
    const { poller, vis, loader } = setup();
    poller.start(A);
    loader.call(0).resolve(response("t1"));
    await flush();

    poller.start(A); // もう 1 本（進行中のまま非表示にする）
    vis.hide();
    poller.setParams(B);
    expect(loader.call(1).signal.aborted).toBe(false); // 非表示中の setParams は条件を覚えるだけ

    loader.call(1).resolve(response("old-A"));
    await flush();
    // 条件のキーが変わった時点で t1 は消えており、古い条件の応答 old-A も入らない
    expect(poller.getState().data).toBeUndefined();
    expect(poller.getState().loading).toBe(false);

    vis.show();
    expect(loader.call(2).params).toEqual(B);
    loader.call(2).reject(new Error("失敗"));
    await flush();
    expect(poller.getState().error?.message).toBe("失敗");
  });

  it("非表示中に条件を変えた後、古い条件の要求が失敗しても error を立てない", async () => {
    const { poller, vis, loader } = setup();
    poller.start(A);
    vis.hide();
    poller.setParams(B);
    loader.call(0).reject(new Error("古い条件の失敗"));
    await flush();
    expect(poller.getState().error).toBeUndefined();
    expect(poller.getState().loading).toBe(false);
  });
});

describe("createPoller: 条件の変更と表示への復帰での中断", () => {
  it("進行中に setParams すると旧要求を中断し、新しい条件で即 1 本だけ送り、旧要求が後から解決しても反映しない", async () => {
    const { poller, timers, loader } = setup();
    poller.start(A);
    poller.setParams(B);

    expect(loader.calls).toHaveLength(2);
    expect(loader.call(0).signal.aborted).toBe(true);
    expect(loader.call(1).signal.aborted).toBe(false);
    expect(loader.call(1).params).toEqual(B);
    timers.tick();
    expect(loader.calls).toHaveLength(2);

    loader.call(0).resolve(response("old-A"));
    await flush();
    expect(poller.getState().data).toBeUndefined();
    expect(poller.getState().receivedAt).toBeUndefined();
    expect(poller.getState().loading).toBe(true);

    loader.call(1).resolve(response("new-B"));
    await flush();
    expect(poller.getState().data).toEqual(response("new-B"));
  });

  it("新しい要求が先に解決した後で旧要求が解決しても、新しい応答を上書きしない", async () => {
    const { poller, loader } = setup();
    poller.start(A);
    poller.setParams(B);
    loader.call(1).resolve(response("new-B"));
    await flush();
    loader.call(0).resolve(response("old-A"));
    await flush();
    expect(poller.getState().data).toEqual(response("new-B"));
  });

  it("進行中に非表示→表示にすると、旧要求を中断して新しい要求を 1 本だけ送る", () => {
    const { poller, vis, loader } = setup();
    poller.start(A);
    vis.hide();
    expect(loader.call(0).signal.aborted).toBe(false);

    vis.show();
    expect(loader.calls).toHaveLength(2);
    expect(loader.call(0).signal.aborted).toBe(true);
    expect(loader.call(1).signal.aborted).toBe(false);
    expect(loader.call(1).params).toEqual(A);
  });

  it("表示中に start を続けて呼ぶと、旧要求を中断して 1 本だけ送り、タイマーと購読は 1 つのまま", () => {
    const { poller, timers, vis, loader } = setup();
    poller.start(A);
    poller.start(B);
    expect(loader.calls).toHaveLength(2);
    expect(loader.call(0).signal.aborted).toBe(true);
    expect(loader.call(1).params).toEqual(B);
    // 2 回目の start の即時送信で刻みを作り直すので、作った数ではなく動いている数が 1 つ
    expect(timers.activeCount()).toBe(1);
    expect(timers.cleared).toEqual([timers.created[0]!.id]);
    expect(vis.listenerCount()).toBe(1);
  });

  it("setParams で中断された要求が AbortError で失敗しても error を立てない", async () => {
    const { poller, loader } = setup();
    poller.start(A);
    poller.setParams(B);
    loader.call(0).reject(abortError());
    await flush();
    expect(poller.getState().error).toBeUndefined();
    expect(poller.getState().loading).toBe(true); // 新しい要求は進行中のまま
  });

  it("stop で中断された要求が AbortError で失敗しても error を立てず、data・receivedAt も変えない", async () => {
    const { poller, loader } = setup();
    poller.start(A);
    poller.stop();
    loader.call(0).reject(abortError());
    await flush();
    expect(poller.getState()).toEqual({ loading: false });
  });

  it("表示への復帰で中断された要求が AbortError で失敗しても error を立てない", async () => {
    const { poller, vis, loader } = setup();
    poller.start(A);
    vis.hide();
    vis.show();
    loader.call(0).reject(abortError());
    await flush();
    expect(poller.getState().error).toBeUndefined();
    expect(poller.getState().loading).toBe(true);
  });

  it("既に立っている error は、中断では消えない（setParams による中断・stop による中断）", async () => {
    const { poller, timers, loader, clock } = setup();
    poller.start(A);
    loader.call(0).resolve(response("t1"));
    await flush();
    const receivedAt = poller.getState().receivedAt;

    clock.now = 11_000;
    timers.tick();
    loader.call(1).reject(new Error("サーバーから取得できませんでした（HTTP 502）"));
    await flush();
    const error = poller.getState().error;
    expect(error).toEqual({ at: 11_000, message: "サーバーから取得できませんでした（HTTP 502）" });

    clock.now = 21_000;
    timers.tick();
    // 同じ条件（キー）で送り直して中断する（条件のキーが変わるとデータと失敗は消えるため。それは別のテストで確かめる）
    poller.setParams({ ...A });
    loader.call(2).reject(abortError());
    await flush();
    expect(poller.getState().error).toEqual(error);
    expect(poller.getState().data).toEqual(response("t1"));
    expect(poller.getState().receivedAt).toBe(receivedAt);

    poller.stop();
    loader.call(3).resolve(response("after-stop"));
    await flush();
    expect(poller.getState().error).toEqual(error);
    expect(poller.getState().data).toEqual(response("t1"));
  });

  it("ポーラーが中断していない要求が AbortError で失敗しても、失敗に数えない", async () => {
    const { poller, loader } = setup();
    poller.start(A);
    loader.call(0).reject(abortError());
    await flush();
    expect(poller.getState().error).toBeUndefined();
    expect(poller.getState().loading).toBe(false);
  });
});

describe("createPoller: 成功と失敗", () => {
  it("失敗すると data・receivedAt を残して error（at・message）を立て、次に成功すると error が消える", async () => {
    const { poller, timers, loader, clock } = setup();
    poller.start(A);
    clock.now = 1_500;
    loader.call(0).resolve(response("t1"));
    await flush();
    expect(poller.getState()).toEqual({ data: response("t1"), receivedAt: 1_500, loading: false });

    // 入る
    clock.now = 11_000;
    timers.tick();
    clock.now = 11_200;
    loader.call(1).reject(new Error("サーバーに接続できませんでした"));
    await flush();
    expect(poller.getState()).toEqual({
      data: response("t1"),
      receivedAt: 1_500,
      error: { at: 11_200, message: "サーバーに接続できませんでした" },
      loading: false,
    });

    // 失敗が続く間は error を更新し、data は残す
    clock.now = 21_000;
    timers.tick();
    loader.call(2).reject(new Error("サーバーから取得できませんでした（HTTP 502）"));
    await flush();
    expect(poller.getState().error).toEqual({ at: 21_000, message: "サーバーから取得できませんでした（HTTP 502）" });
    expect(poller.getState().data).toEqual(response("t1"));

    // 抜ける
    clock.now = 31_000;
    timers.tick();
    loader.call(3).resolve(response("t4"));
    await flush();
    expect(poller.getState()).toEqual({ data: response("t4"), receivedAt: 31_000, loading: false });
    expect(poller.getState().error).toBeUndefined();
  });

  it("データが一度も無いまま失敗しても error を立てる", async () => {
    const { poller, loader } = setup();
    poller.start(A);
    loader.call(0).reject(new Error("失敗"));
    await flush();
    expect(poller.getState()).toEqual({ error: { at: 1_000, message: "失敗" }, loading: false });
  });

  it("文言の無い例外は既定の文言で error を立てる", async () => {
    const { poller, loader } = setup();
    poller.start(A);
    loader.call(0).reject("文字列の例外");
    await flush();
    expect(poller.getState().error).toEqual({ at: 1_000, message: "更新できませんでした" });
  });

  it("最新でない要求の失敗は error を立てない", async () => {
    const { poller, loader } = setup();
    poller.start(A);
    poller.setParams(B);
    loader.call(0).reject(new Error("古い要求の失敗"));
    await flush();
    expect(poller.getState().error).toBeUndefined();
    expect(poller.getState().loading).toBe(true);

    loader.call(1).resolve(response("new-B"));
    await flush();
    expect(poller.getState()).toEqual({ data: response("new-B"), receivedAt: 1_000, loading: false });
  });

  it("load が同期的に例外を投げても失敗として扱う", async () => {
    const { poller } = setup({
      load: () => {
        throw new Error("同期の例外");
      },
    });
    poller.start(A);
    await flush();
    expect(poller.getState()).toEqual({ error: { at: 1_000, message: "同期の例外" }, loading: false });
  });
});

describe("createPoller: 停止と開始前（M3-3）", () => {
  it("stop で進行中の要求を中断し、loading を false にし、その結果を反映しない", async () => {
    const { poller, loader } = setup();
    poller.start(A);
    expect(poller.getState().loading).toBe(true);

    poller.stop();
    expect(loader.call(0).signal.aborted).toBe(true);
    expect(poller.getState().loading).toBe(false);

    loader.call(0).resolve(response("after-stop"));
    await flush();
    expect(poller.getState().data).toBeUndefined();
  });

  it("stop でタイマーの解除（clearInterval）と可視状態の購読解除を呼ぶ", () => {
    const { poller, timers, vis } = setup();
    poller.start(A);
    expect(vis.listenerCount()).toBe(1);
    const timerId = timers.created[0]!.id;

    poller.stop();
    expect(timers.cleared).toEqual([timerId]);
    expect(timers.activeCount()).toBe(0);
    expect(vis.unsubscribeCount()).toBe(1);
    expect(vis.listenerCount()).toBe(0);
  });

  it("stop の後は非表示→表示で 0 回（解除前に受け取った通知が後から届いても送らない）", async () => {
    const { poller, vis, loader } = setup();
    poller.start(A);
    loader.call(0).resolve(response("t1"));
    await flush();

    poller.stop();
    vis.hide();
    vis.show();
    expect(loader.calls).toHaveLength(1);

    vis.subscribed[0]!(); // 可視状態は表示中
    expect(loader.calls).toHaveLength(1);
  });

  it("stop の後は刻みで 0 回（解除前に積まれた刻みが後から届いても送らない）", async () => {
    const { poller, timers, loader } = setup();
    poller.start(A);
    loader.call(0).resolve(response("t1"));
    await flush();

    poller.stop();
    timers.tick(3);
    timers.created[0]!.fn();
    expect(loader.calls).toHaveLength(1);
  });

  it("stop の後は setParams でも送らない", async () => {
    const { poller, loader } = setup();
    poller.start(A);
    loader.call(0).resolve(response("t1"));
    await flush();

    poller.stop();
    poller.setParams(B);
    expect(loader.calls).toHaveLength(1);
  });

  it("start の前は、表示への復帰・刻み・setParams のいずれでも送らない", () => {
    const { poller, timers, vis, loader } = setup({ visible: false });
    vis.show();
    vis.hide();
    vis.show();
    poller.setParams(A);
    timers.tick(3);
    expect(loader.calls).toHaveLength(0);
    expect(vis.listenerCount()).toBe(0);
    expect(timers.created).toHaveLength(0);

    poller.start(B);
    expect(loader.calls).toHaveLength(1);
    expect(loader.call(0).params).toEqual(B);
  });

  it("stop の後に start し直すと、タイマーと購読を作り直して再開する", async () => {
    const { poller, timers, vis, loader } = setup();
    poller.start(A);
    poller.stop();
    poller.start(B);

    expect(loader.calls).toHaveLength(2);
    expect(loader.call(1).params).toEqual(B);
    expect(timers.created).toHaveLength(2);
    expect(timers.activeCount()).toBe(1);
    expect(vis.listenerCount()).toBe(1);

    loader.call(1).resolve(response("t2"));
    await flush();
    expect(poller.getState().data).toEqual(response("t2"));
    vis.hide();
    vis.show();
    expect(loader.calls).toHaveLength(3);
  });
});

describe("createPoller: 即時送信での刻みの作り直し", () => {
  it("刻みの 9 秒目に setParams で即時送信すると、完了後、1 秒後の刻みでは送らず、即時送信から 10 秒後に送る", async () => {
    const { poller, timers, loader } = setup();
    poller.start(A);
    loader.call(0).resolve(response("t1"));
    await flush();

    timers.advance(9_000);
    expect(loader.calls).toHaveLength(1);
    poller.setParams(B);
    expect(loader.calls).toHaveLength(2);
    loader.call(1).resolve(response("t2"));
    await flush();

    timers.advance(1_000); // 開始から 10 秒（作り直す前の刻みの時刻）
    expect(loader.calls).toHaveLength(2);
    timers.advance(8_999);
    expect(loader.calls).toHaveLength(2);
    timers.advance(1); // 即時送信から 10 秒
    expect(loader.calls).toHaveLength(3);
    expect(loader.call(2).params).toEqual(B);
    expect(timers.activeCount()).toBe(1);
  });

  it("表示への復帰と、開始済みでの start の即時送信でも、刻みをその送信から数え直す", async () => {
    const { poller, timers, vis, loader } = setup();
    poller.start(A);
    loader.call(0).resolve(response("t1"));
    await flush();

    // 6 秒目に表示へ復帰
    timers.advance(4_000);
    vis.hide();
    timers.advance(2_000);
    vis.show();
    expect(loader.calls).toHaveLength(2);
    loader.call(1).resolve(response("t2"));
    await flush();
    timers.advance(4_000); // 開始から 10 秒
    expect(loader.calls).toHaveLength(2);
    timers.advance(6_000); // 復帰から 10 秒
    expect(loader.calls).toHaveLength(3);
    loader.call(2).resolve(response("t3"));
    await flush();

    // 刻みの 3 秒後に、開始済みのまま start
    timers.advance(3_000);
    poller.start(A);
    expect(loader.calls).toHaveLength(4);
    loader.call(3).resolve(response("t4"));
    await flush();
    timers.advance(7_000); // 前の刻みから 10 秒
    expect(loader.calls).toHaveLength(4);
    timers.advance(3_000); // start から 10 秒
    expect(loader.calls).toHaveLength(5);
  });

  it("刻みによる送信と、非表示中の setParams ではタイマーを作り直さない", async () => {
    const { poller, timers, vis, loader } = setup();
    poller.start(A);
    loader.call(0).resolve(response("t1"));
    await flush();

    timers.advance(10_000);
    expect(loader.calls).toHaveLength(2);
    loader.call(1).resolve(response("t2"));
    await flush();
    vis.hide();
    poller.setParams(B);
    expect(timers.created).toHaveLength(1);
    expect(timers.cleared).toEqual([]);
  });
});

describe("createPoller: 要求の期限", () => {
  it("応答が返らないまま 15 秒たつと、要求を中断して失敗「応答がありません」に数え（data は残す）、次の刻みで新しい要求を送る", async () => {
    const { poller, timers, loader, clock } = setup();
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(15_000);
    poller.start(A);
    loader.call(0).resolve(response("t1"));
    await flush();

    timers.advance(10_000); // 刻みで送る（期限は 25 秒目）
    expect(loader.calls).toHaveLength(2);
    expect(timers.createdTimeouts.map((t) => t.ms)).toEqual([15_000, 15_000]);
    timers.advance(14_999); // 20 秒目の刻みは進行中なので送らない
    expect(loader.calls).toHaveLength(2);
    expect(loader.call(1).signal.aborted).toBe(false);
    expect(poller.getState().error).toBeUndefined();
    expect(poller.getState().loading).toBe(true);

    clock.now = 25_000;
    timers.advance(1); // 25 秒目: 期限
    expect(loader.call(1).signal.aborted).toBe(true);
    expect(poller.getState()).toEqual({
      data: response("t1"),
      receivedAt: 1_000,
      error: { at: 25_000, message: "応答がありません" },
      loading: false,
    });

    // 中断に応じて load が AbortError で失敗しても、中断として扱い直さない
    loader.call(1).reject(abortError());
    await flush();
    expect(poller.getState().error).toEqual({ at: 25_000, message: "応答がありません" });

    timers.advance(4_999);
    expect(loader.calls).toHaveLength(2);
    timers.advance(1); // 30 秒目: 次の刻み
    expect(loader.calls).toHaveLength(3);
    expect(loader.call(2).params).toEqual(A);
    expect(loader.call(2).signal.aborted).toBe(false);
  });

  it("期限前に成功・失敗すれば期限で error を立てず、期限のタイマーを解除する", async () => {
    const { poller, timers, loader } = setup();
    poller.start(A);
    const firstTimeout = timers.createdTimeouts[0]!.id;
    timers.advance(14_999);
    loader.call(0).resolve(response("t1"));
    await flush();
    expect(timers.clearedTimeouts).toEqual([firstTimeout]);
    expect(timers.activeTimeoutCount()).toBe(0);
    timers.advance(1); // 元の期限
    expect(poller.getState()).toEqual({ data: response("t1"), receivedAt: 1_000, loading: false });

    timers.advance(5_000); // 20 秒目の刻みで送る
    expect(loader.calls).toHaveLength(2);
    const secondTimeout = timers.createdTimeouts[1]!.id;
    loader.call(1).reject(new Error("失敗"));
    await flush();
    expect(timers.clearedTimeouts).toEqual([firstTimeout, secondTimeout]);
    expect(timers.activeTimeoutCount()).toBe(0);
    timers.advance(15_000); // 2 本目の元の期限（35 秒目）を過ぎる
    expect(poller.getState().error).toEqual({ at: 1_000, message: "失敗" });
  });

  it("requestTimeoutMs を指定するとその期限で失敗に数える", () => {
    const { poller, timers } = setup({ requestTimeoutMs: 3_000 });
    poller.start(A);
    expect(timers.createdTimeouts.map((t) => t.ms)).toEqual([3_000]);
    timers.advance(2_999);
    expect(poller.getState().error).toBeUndefined();
    timers.advance(1);
    expect(poller.getState().error).toEqual({ at: 1_000, message: "応答がありません" });
  });

  it("期限切れの後に元の要求が解決しても反映しない", async () => {
    const { poller, timers, loader } = setup();
    poller.start(A);
    timers.advance(15_000);
    expect(poller.getState()).toEqual({ error: { at: 1_000, message: "応答がありません" }, loading: false });

    loader.call(0).resolve(response("late"));
    await flush();
    expect(poller.getState()).toEqual({ error: { at: 1_000, message: "応答がありません" }, loading: false });
  });

  it("setParams で中断した要求は、その期限を過ぎても失敗に数えない（期限のタイマーを解除する）", async () => {
    const { poller, timers, loader } = setup();
    poller.start(A);
    const firstTimeout = timers.createdTimeouts[0]!.id;
    timers.advance(5_000);
    poller.setParams(B); // A の要求を中断（A の期限は 15 秒目、B の期限は 20 秒目）
    expect(loader.call(0).signal.aborted).toBe(true);
    expect(timers.clearedTimeouts).toEqual([firstTimeout]);

    timers.advance(10_000); // 15 秒目
    expect(poller.getState().error).toBeUndefined();
    expect(poller.getState().loading).toBe(true);
    expect(loader.call(1).signal.aborted).toBe(false);
    loader.call(0).reject(abortError());
    await flush();
    expect(poller.getState().error).toBeUndefined();

    loader.call(1).resolve(response("new-B"));
    await flush();
    expect(poller.getState()).toEqual({ data: response("new-B"), receivedAt: 1_000, loading: false });
  });

  it("stop で中断した要求は、その期限を過ぎても失敗に数えない（期限のタイマーを解除する）", () => {
    const { poller, timers } = setup();
    poller.start(A);
    const timeoutId = timers.createdTimeouts[0]!.id;
    poller.stop();
    expect(timers.clearedTimeouts).toEqual([timeoutId]);
    expect(timers.activeTimeoutCount()).toBe(0);
    timers.advance(15_000);
    expect(poller.getState()).toEqual({ loading: false });
  });
});

describe("createPoller: 条件のキーの変更で古い条件のデータを消す", () => {
  it("条件 A のデータがある状態で setParams(B) すると、応答を待たずに data・receivedAt・error が消え、B の成功で B のデータになる", async () => {
    const { poller, timers, loader, clock } = setup();
    poller.start(A);
    loader.call(0).resolve(response("A-1"));
    await flush();
    timers.tick();
    clock.now = 11_000;
    loader.call(1).reject(new Error("失敗"));
    await flush();
    expect(poller.getState()).toEqual({
      data: response("A-1"),
      receivedAt: 1_000,
      error: { at: 11_000, message: "失敗" },
      loading: false,
    });

    poller.setParams(B);
    expect(poller.getState()).toEqual({ loading: true });

    clock.now = 12_000;
    loader.call(2).resolve(response("B-1"));
    await flush();
    expect(poller.getState()).toEqual({ data: response("B-1"), receivedAt: 12_000, loading: false });
  });

  it("B の要求が失敗すると error は立つが、A のデータは戻らない", async () => {
    const { poller, loader } = setup();
    poller.start(A);
    loader.call(0).resolve(response("A-1"));
    await flush();

    poller.setParams(B);
    loader.call(1).reject(new Error("B の失敗"));
    await flush();
    expect(poller.getState()).toEqual({ error: { at: 1_000, message: "B の失敗" }, loading: false });
  });

  it("A のデータ取得後に A の要求が失敗しても data は A のまま。同じキーの setParams・start（別のオブジェクト）でもデータと失敗を消さない", async () => {
    const { poller, timers, loader, clock } = setup();
    poller.start(A);
    loader.call(0).resolve(response("A-1"));
    await flush();
    timers.tick();
    clock.now = 11_000;
    loader.call(1).reject(new Error("A の失敗"));
    await flush();
    const failed = {
      data: response("A-1"),
      receivedAt: 1_000,
      error: { at: 11_000, message: "A の失敗" },
      loading: false,
    };
    expect(poller.getState()).toEqual(failed);

    poller.setParams({ area: "A" });
    expect(loader.calls).toHaveLength(3); // 送り直しはする
    expect(poller.getState()).toEqual({ ...failed, loading: true });

    clock.now = 12_000;
    loader.call(2).reject(new Error("A の再失敗"));
    await flush();
    expect(poller.getState()).toEqual({ ...failed, error: { at: 12_000, message: "A の再失敗" } });

    poller.start({ area: "A" });
    expect(poller.getState()).toEqual({ ...failed, error: { at: 12_000, message: "A の再失敗" }, loading: true });
  });

  it("paramsKey を指定すると、そのキーで同じ条件かを比べる", async () => {
    const { poller, loader } = setup({ paramsKey: (params) => params.area.toLowerCase() });
    poller.start(A);
    loader.call(0).resolve(response("A-1"));
    await flush();

    poller.setParams({ area: "a" });
    expect(poller.getState().data).toEqual(response("A-1"));
    poller.setParams(B);
    expect(poller.getState().data).toBeUndefined();
  });

  it("非表示中の setParams(B) でも、送らずにデータを消して通知する", async () => {
    const { poller, vis, loader } = setup();
    poller.start(A);
    loader.call(0).resolve(response("A-1"));
    await flush();
    vis.hide();

    const seen: unknown[] = [];
    poller.subscribe(() => seen.push(poller.getState()));
    poller.setParams(B);
    expect(loader.calls).toHaveLength(1);
    expect(poller.getState()).toEqual({ loading: false });
    expect(seen).toEqual([{ loading: false }]);

    vis.show();
    expect(loader.call(1).params).toEqual(B);
    loader.call(1).resolve(response("B-1"));
    await flush();
    expect(poller.getState().data).toEqual(response("B-1"));
  });

  it("停止中に条件を変えてから start し直しても、古い条件のデータを出さない", async () => {
    const { poller, loader } = setup();
    poller.start(A);
    loader.call(0).resolve(response("A-1"));
    await flush();
    poller.stop();
    expect(poller.getState().data).toEqual(response("A-1"));

    poller.setParams(B); // useNearby は条件の変更を start より先に渡す
    expect(poller.getState()).toEqual({ loading: false });
    poller.start(B);
    expect(loader.call(1).params).toEqual(B);
    expect(poller.getState()).toEqual({ loading: true });
  });

  it("消すものが無ければ、条件のキーが変わっても通知しない", () => {
    const { poller } = setup({ visible: false });
    const listener = vi.fn();
    poller.subscribe(listener);
    poller.start(A);
    poller.setParams(B);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("createPoller: 状態の通知", () => {
  it("loading は要求が進行中の間だけ true", async () => {
    const { poller, timers, loader } = setup();
    expect(poller.getState().loading).toBe(false);

    poller.start(A);
    expect(poller.getState().loading).toBe(true);
    loader.call(0).resolve(response("t1"));
    await flush();
    expect(poller.getState().loading).toBe(false);

    timers.tick();
    expect(poller.getState().loading).toBe(true);
    loader.call(1).reject(new Error("失敗"));
    await flush();
    expect(poller.getState().loading).toBe(false);

    timers.tick();
    poller.setParams(B); // 中断して送り直す間も進行中のまま
    expect(poller.getState().loading).toBe(true);
  });

  it("状態が変わるたびにリスナーを呼び、解除した後は呼ばない", async () => {
    const { poller, timers, loader } = setup();
    const listener = vi.fn(() => poller.getState());
    const unsubscribe = poller.subscribe(listener);

    poller.start(A);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.results[0]!.value).toEqual({ loading: true });

    loader.call(0).resolve(response("t1"));
    await flush();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.results[1]!.value).toEqual({ data: response("t1"), receivedAt: 1_000, loading: false });

    timers.tick();
    loader.call(1).reject(new Error("失敗"));
    await flush();
    expect(listener).toHaveBeenCalledTimes(4);
    expect(listener.mock.results[3]!.value.error).toEqual({ at: 1_000, message: "失敗" });

    unsubscribe();
    timers.tick();
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("状態が変わらない間は getState が同じオブジェクトを返す", () => {
    const { poller, timers } = setup();
    poller.start(A);
    const state = poller.getState();
    timers.tick(2); // 進行中なので送らない
    expect(poller.getState()).toBe(state);
  });
});

describe("createPoller: 更新間隔の変更（AC-P2-74）", () => {
  it("実行中に間隔を変えると、その時点から新しい間隔で刻む（再読み込みは要らない）", async () => {
    const { poller, timers, loader } = setup();
    poller.start(A);
    loader.call(0).resolve(response("t1"));
    await flush();

    timers.advance(5_000);
    poller.setIntervalMs(5_000);
    // 間隔を変えただけでは送らない
    expect(loader.calls).toHaveLength(1);
    timers.advance(4_999);
    expect(loader.calls).toHaveLength(1);
    timers.advance(1); // 変更から 5 秒
    expect(loader.calls).toHaveLength(2);
    loader.call(1).resolve(response("t2"));
    await flush();
    timers.advance(5_000);
    expect(loader.calls).toHaveLength(3);
    // 刻みは 1 本のまま（作り直しで増やさない）
    expect(timers.activeCount()).toBe(1);
  });

  it("同じ間隔を渡したらタイマーを作り直さない", () => {
    const { poller, timers } = setup();
    poller.start(A);
    poller.setIntervalMs(DEFAULT_POLL_INTERVAL_MS);
    expect(timers.created).toHaveLength(1);
    expect(timers.cleared).toEqual([]);
  });

  it("開始前に変えた間隔は、開始したときの刻みから使う", () => {
    const { poller, timers } = setup();
    poller.setIntervalMs(30_000);
    poller.start(A);
    expect(timers.created).toHaveLength(1);
    expect(timers.created[0]?.ms).toBe(30_000);
  });

  it("進行中の要求は中断しない（間隔の変更で 1 本増やさない）", () => {
    const { poller, loader } = setup();
    poller.start(A);
    poller.setIntervalMs(5_000);
    expect(loader.calls).toHaveLength(1);
    expect(loader.call(0).signal.aborted).toBe(false);
  });

  it("停止中に変えた間隔は、再開したときの刻みから使う", () => {
    const { poller, timers } = setup();
    poller.start(A);
    poller.stop();
    poller.setIntervalMs(5_000);
    poller.start(A);
    expect(timers.created).toHaveLength(2);
    expect(timers.created[1]?.ms).toBe(5_000);
  });
});

describe("documentVisibility", () => {
  class FakeDocument extends EventTarget {
    visibilityState: DocumentVisibilityState = "visible";
  }

  it("visibilityState が visible のときだけ表示中", () => {
    const doc = new FakeDocument();
    const visibility = documentVisibility(doc);
    expect(visibility.isVisible()).toBe(true);
    doc.visibilityState = "hidden";
    expect(visibility.isVisible()).toBe(false);
    doc.visibilityState = "visible";
    expect(visibility.isVisible()).toBe(true);
  });

  it("visibilitychange を購読し、解除すると同じリスナーを外す", () => {
    const doc = new FakeDocument();
    const add = vi.spyOn(doc, "addEventListener");
    const remove = vi.spyOn(doc, "removeEventListener");
    const onChange = vi.fn();

    const unsubscribe = documentVisibility(doc).subscribe(onChange);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]![0]).toBe("visibilitychange");

    doc.dispatchEvent(new Event("visibilitychange"));
    expect(onChange).toHaveBeenCalledTimes(1);
    doc.dispatchEvent(new Event("other"));
    expect(onChange).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]![0]).toBe("visibilitychange");
    expect(remove.mock.calls[0]![1]).toBe(add.mock.calls[0]![1]);

    doc.dispatchEvent(new Event("visibilitychange"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

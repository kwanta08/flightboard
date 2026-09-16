import { describe, expect, it } from "vitest";
import type { Flight } from "../shared/types.ts";
import { cacheKey, createPositionCache } from "./positionCache.ts";
import type { CachedPositions, PositionLoadResult } from "./positionCache.ts";
import { adsbLolUrl } from "./providers/readsb.ts";

const T0 = Date.UTC(2026, 8, 15, 0, 0, 0);
const KEY = cacheKey(35.87, 139.93, 27);

function flight(hex: string): Flight {
  return {
    hex,
    position: { lat: 35.8, lon: 139.9, altitudeBaroFt: 10000, onGround: false },
    isMlat: false,
    seenPosSec: 1,
    kind: "passenger",
    source: "adsblol",
  };
}

function result(hex = "abc123", source: Flight["source"] = "adsblol"): PositionLoadResult {
  return { flights: [flight(hex)], source };
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 呼び出し回数を数える loader。既定では `result()` で即解決する */
function countingLoader(impl: () => Promise<PositionLoadResult> = async () => result()) {
  const loader = Object.assign(
    () => {
      loader.calls += 1;
      return impl();
    },
    { calls: 0 },
  );
  return loader;
}

function setup(ttlMs?: number) {
  let time = T0;
  const loaded: CachedPositions[] = [];
  const cache = createPositionCache({
    ...(ttlMs === undefined ? {} : { ttlMs }),
    now: () => time,
    onLoaded: (value) => loaded.push(value),
  });
  return {
    cache,
    loaded,
    setTime: (t: number) => {
      time = t;
    },
  };
}

describe("TTL（AC-A11）", () => {
  it("取得から 4999ms はヒット（loader 1 回、同じ値）", async () => {
    const { cache, setTime } = setup();
    const loader = countingLoader();

    const first = await cache.get(KEY, loader);
    setTime(T0 + 4999);
    const second = await cache.get(KEY, loader);

    expect(loader.calls).toBe(1);
    expect(second).toBe(first);
  });

  it("取得から 5000ms で再取得（loader 2 回、新しい値）", async () => {
    const { cache, setTime } = setup();
    let n = 0;
    const loader = countingLoader(async () => result(`00000${++n}`));

    const first = await cache.get(KEY, loader);
    setTime(T0 + 5000);
    const second = await cache.get(KEY, loader);

    expect(loader.calls).toBe(2);
    expect(second).not.toBe(first);
    expect(second.flights[0]?.hex).toBe("000002");
    expect(second.fetchedAt).toBe(T0 + 5000);
  });

  it("fetchedAt は loader の解決時点の now()（TTL もそこから数える）", async () => {
    const { cache, setTime } = setup();
    const d = deferred<PositionLoadResult>();
    const loader = countingLoader(() => d.promise);

    const pending = cache.get(KEY, loader);
    setTime(T0 + 700);
    d.resolve(result());
    const value = await pending;
    expect(value.fetchedAt).toBe(T0 + 700);

    setTime(T0 + 700 + 4999);
    await cache.get(KEY, loader);
    expect(loader.calls).toBe(1);

    setTime(T0 + 700 + 5000);
    await cache.get(KEY, loader);
    expect(loader.calls).toBe(2);
  });

  it("ttlMs は注入できる", async () => {
    const { cache, setTime } = setup(1000);
    const loader = countingLoader();

    await cache.get(KEY, loader);
    setTime(T0 + 999);
    await cache.get(KEY, loader);
    expect(loader.calls).toBe(1);

    setTime(T0 + 1000);
    await cache.get(KEY, loader);
    expect(loader.calls).toBe(2);
  });

  it("キーが違えば別々に取得する", async () => {
    const { cache } = setup();
    const loader = countingLoader();

    await cache.get(cacheKey(35.87, 139.93, 27), loader);
    await cache.get(cacheKey(35.87, 139.93, 14), loader);

    expect(loader.calls).toBe(2);
    expect(cache.size()).toBe(2);
  });

  it("値は loader の flights・source をそのまま持つ", async () => {
    const { cache } = setup();
    const loaded = result("f0f0f0", "opensky");
    const value = await cache.get(KEY, async () => loaded);
    expect(value.flights).toBe(loaded.flights);
    expect(value.source).toBe("opensky");
  });
});

describe("進行中の取得の共有（AC-A11）", () => {
  it("同じキーの同時 2 要求 → loader 1 回、両方に同じ値", async () => {
    const { cache } = setup();
    const d = deferred<PositionLoadResult>();
    const loader = countingLoader(() => d.promise);

    const a = cache.get(KEY, loader);
    const b = cache.get(KEY, loader);
    d.resolve(result());
    const [va, vb] = await Promise.all([a, b]);

    expect(loader.calls).toBe(1);
    expect(va).toBe(vb);
  });

  it("共有中に後から来た要求の loader は呼ばれない", async () => {
    const { cache } = setup();
    const d = deferred<PositionLoadResult>();
    const first = countingLoader(() => d.promise);
    const second = countingLoader();

    const a = cache.get(KEY, first);
    const b = cache.get(KEY, second);
    d.resolve(result());
    await Promise.all([a, b]);

    expect(first.calls).toBe(1);
    expect(second.calls).toBe(0);
  });

  it("進行中の取得はエントリ数に数えない", async () => {
    const { cache } = setup();
    const d = deferred<PositionLoadResult>();

    const pending = cache.get(KEY, () => d.promise);
    expect(cache.size()).toBe(0);
    d.resolve(result());
    await pending;
    expect(cache.size()).toBe(1);
  });
});

describe("失敗はキャッシュしない（AC-A11）", () => {
  it("失敗は共有していた呼び出し側も含めて両方に同じ例外で伝わる", async () => {
    const { cache } = setup();
    const d = deferred<PositionLoadResult>();
    const loader = countingLoader(() => d.promise);
    const error = new Error("upstream down");

    const a = cache.get(KEY, loader);
    const b = cache.get(KEY, loader);
    d.reject(error);

    await expect(a).rejects.toBe(error);
    await expect(b).rejects.toBe(error);
    expect(loader.calls).toBe(1);
  });

  it("失敗後の次の要求では loader を再実行する（同じ時刻でも）", async () => {
    const { cache } = setup();
    let fail = true;
    const loader = countingLoader(async () => {
      if (fail) throw new Error("upstream down");
      return result();
    });

    await expect(cache.get(KEY, loader)).rejects.toThrow("upstream down");
    expect(cache.size()).toBe(0);

    fail = false;
    const value = await cache.get(KEY, loader);
    expect(loader.calls).toBe(2);
    expect(value.flights).toHaveLength(1);
    expect(cache.size()).toBe(1);
  });

  it("同期的に例外を投げる loader でも、失敗が伝わり次の要求で再実行する", async () => {
    const { cache } = setup();
    const error = new Error("sync throw");
    let calls = 0;
    const throwing = (): Promise<PositionLoadResult> => {
      calls += 1;
      throw error;
    };

    await expect(cache.get(KEY, throwing)).rejects.toBe(error);
    await expect(cache.get(KEY, throwing)).rejects.toBe(error);
    expect(calls).toBe(2);
    expect(cache.size()).toBe(0);
  });

  it("失敗しても既存の別キーのエントリは残る", async () => {
    const { cache } = setup();
    const other = cacheKey(1, 2, 27);
    await cache.get(other, async () => result());

    await expect(cache.get(KEY, async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(cache.size()).toBe(1);
  });
});

describe("期限切れのエントリの削除（AC-A11）", () => {
  it("期限切れのエントリは別キーの get で削除される（size が減る）", async () => {
    const { cache, setTime } = setup();
    const a = cacheKey(35.1, 139.1, 27);
    const b = cacheKey(35.2, 139.2, 27);
    const c = cacheKey(35.3, 139.3, 27);

    await cache.get(a, async () => result());
    await cache.get(b, async () => result());
    expect(cache.size()).toBe(2);

    setTime(T0 + 5000);
    const d = deferred<PositionLoadResult>();
    const pending = cache.get(c, () => d.promise);
    expect(cache.size()).toBe(0);

    d.resolve(result());
    await pending;
    expect(cache.size()).toBe(1);
  });

  it("キャッシュヒットの get でも期限切れの別キーを削除し、期限内のエントリは残す", async () => {
    const { cache, setTime } = setup();
    const a = cacheKey(35.1, 139.1, 27);
    const b = cacheKey(35.2, 139.2, 27);

    await cache.get(a, async () => result());
    setTime(T0 + 1000);
    await cache.get(b, async () => result());
    expect(cache.size()).toBe(2);

    setTime(T0 + 5000);
    const loader = countingLoader();
    await cache.get(b, loader);

    expect(loader.calls).toBe(0);
    expect(cache.size()).toBe(1);
  });

  it("期限切れで削除された後に同じキーを取り直すと size は 1 のまま", async () => {
    const { cache, setTime } = setup();
    const loader = countingLoader();

    await cache.get(KEY, loader);
    setTime(T0 + 10_000);
    await cache.get(KEY, loader);

    expect(loader.calls).toBe(2);
    expect(cache.size()).toBe(1);
  });

  it("size() 自身は掃除しない（TTL 経過後も次の get までは期限切れを数え、別キーの get の後に減る）", async () => {
    const { cache, setTime } = setup();

    await cache.get(KEY, async () => result());
    setTime(T0 + 5000);
    expect(cache.size()).toBe(1);

    await cache.get(cacheKey(1, 2, 27), async () => result());
    expect(cache.size()).toBe(1);
  });
});

describe("onLoaded", () => {
  it("loader の成功ごとにちょうど 1 回、保存した値で呼ばれる", async () => {
    const { cache, loaded, setTime } = setup();

    const first = await cache.get(KEY, async () => result());
    expect(loaded).toEqual([first]);
    expect(loaded[0]).toBe(first);

    setTime(T0 + 5000);
    const second = await cache.get(KEY, async () => result());
    expect(loaded).toHaveLength(2);
    expect(loaded[1]).toBe(second);
  });

  it("キャッシュヒットでは呼ばれない", async () => {
    const { cache, loaded, setTime } = setup();

    await cache.get(KEY, async () => result());
    setTime(T0 + 4999);
    await cache.get(KEY, async () => result());

    expect(loaded).toHaveLength(1);
  });

  it("共有した要求では追加で呼ばれない（同時 2 要求で 1 回）", async () => {
    const { cache, loaded } = setup();
    const d = deferred<PositionLoadResult>();

    const a = cache.get(KEY, () => d.promise);
    const b = cache.get(KEY, () => d.promise);
    d.resolve(result());
    await Promise.all([a, b]);

    expect(loaded).toHaveLength(1);
  });

  it("失敗では呼ばれない", async () => {
    const { cache, loaded } = setup();

    await expect(cache.get(KEY, async () => Promise.reject(new Error("x")))).rejects.toThrow("x");

    expect(loaded).toHaveLength(0);
  });

  it("onLoaded は省略できる", async () => {
    const cache = createPositionCache({ now: () => T0 });
    const value = await cache.get(KEY, async () => result());
    expect(value.fetchedAt).toBe(T0);
  });

  it("onLoaded の例外は呼び出し側へ伝わるが、値は保存済み（次の要求はヒット）", async () => {
    const error = new Error("onLoaded failed");
    const cache = createPositionCache({
      now: () => T0,
      onLoaded: () => {
        throw error;
      },
    });
    const loader = countingLoader();

    await expect(cache.get(KEY, loader)).rejects.toBe(error);
    expect(cache.size()).toBe(1);

    await cache.get(KEY, loader);
    expect(loader.calls).toBe(1);
  });
});

describe("cacheKey", () => {
  it("lat・lon を小数 4 桁に丸める（35.87654, 139.92561 と 35.87649, 139.92559 は同じキー）", () => {
    expect(cacheKey(35.87654, 139.92561, 27)).toBe(cacheKey(35.87649, 139.92559, 27));
  });

  it("nm が違えば別キー", () => {
    expect(cacheKey(35.87654, 139.92561, 27)).not.toBe(cacheKey(35.87654, 139.92561, 14));
  });

  it("小数 4 桁で違えば別キー", () => {
    expect(cacheKey(35.8765, 139.9256, 27)).not.toBe(cacheKey(35.8766, 139.9256, 27));
    expect(cacheKey(35.8765, 139.9256, 27)).not.toBe(cacheKey(35.8765, 139.9257, 27));
  });

  it("lat と lon を入れ替えれば別キー", () => {
    expect(cacheKey(35, 139, 27)).not.toBe(cacheKey(139, 35, 27));
  });

  it("readsb の URL の座標と同じ表記（末尾の 0 を落とし、-0 は 0）", () => {
    expect(cacheKey(35.87, 139.93, 27)).toBe("35.87,139.93,27");
    expect(cacheKey(-0.00001, 0.00004, 6)).toBe(cacheKey(0, 0, 6));
    expect(cacheKey(-0.00001, 0.00004, 6)).toBe("0,0,6");
  });

  it("丸めが効く値（35.87005, -0.00001, 27nm）でも、キーの各要素が adsbLolUrl の URL のパスにそのまま現れる", () => {
    const parts = cacheKey(35.87005, -0.00001, 27).split(",");
    const url = new URL(adsbLolUrl({ lat: 35.87005, lon: -0.00001, radiusNm: 27 }));

    // 丸めが効いていること（入力の表記のままではない）
    expect(parts).toHaveLength(3);
    expect(parts[0]).not.toBe("35.87005");
    expect(parts[1]).toBe("0");

    expect(url.pathname).toBe(`/v2/point/${parts[0]}/${parts[1]}/${parts[2]}`);
    expect(url.pathname.split("/").slice(3)).toEqual(parts);
  });
});

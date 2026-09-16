import { describe, expect, it } from "vitest";
import type { Flight } from "../../shared/types.ts";
import { createFallbackProvider } from "./fallback.ts";
import { UpstreamError } from "./provider.ts";
import type { NearbyQuery, PositionProvider } from "./provider.ts";

type Source = Flight["source"];

/** 偽提供元の振る舞い。変更するまで毎回同じ結果を返す */
type Behavior =
  | { type: "ok" }
  | { type: "fail" }
  | { type: "rateLimited"; retryAfterSec?: number }
  | { type: "throw"; error: unknown };

const OK: Behavior = { type: "ok" };
const FAIL: Behavior = { type: "fail" };
const rateLimited = (retryAfterSec?: number): Behavior => ({ type: "rateLimited", retryAfterSec });

const T0 = Date.UTC(2026, 8, 15, 0, 0, 0);
const query: NearbyQuery = { lat: 35.87, lon: 139.93, radiusNm: 27 };

type FakeProvider = PositionProvider & { behavior: Behavior; calls: number; lastError?: unknown };

function flightFrom(source: Source): Flight {
  return {
    hex: `f0c00${source.length}`,
    position: { lat: 35.8, lon: 139.9, altitudeBaroFt: 10000, onGround: false },
    isMlat: false,
    seenPosSec: 1,
    kind: "passenger",
    source,
  };
}

function setup() {
  let time = T0;
  const log: Source[] = [];
  /** 各提供元が受け取った検索条件（呼ばれた順）。確かめるのは偽提供元の外（fallback の try/catch に飲まれないように） */
  const received: NearbyQuery[] = [];

  const fake = (id: Source): FakeProvider => {
    const provider: FakeProvider = {
      id,
      behavior: OK,
      calls: 0,
      async fetchNearby(q) {
        received.push(q);
        provider.calls += 1;
        log.push(id);
        const b = provider.behavior;
        let error: unknown;
        switch (b.type) {
          case "ok":
            return [flightFrom(id)];
          case "fail":
            error = new UpstreamError(`${id}: HTTP 500`, { status: 500 });
            break;
          case "rateLimited":
            error = new UpstreamError(`${id}: HTTP 429`, { status: 429, retryAfterSec: b.retryAfterSec });
            break;
          case "throw":
            error = b.error;
            break;
        }
        provider.lastError = error;
        throw error;
      },
    };
    return provider;
  };

  const lol = fake("adsblol");
  const fi = fake("adsbfi");
  const sky = fake("opensky");
  const fallback = createFallbackProvider([lol, fi, sky], { now: () => time });

  return {
    lol,
    fi,
    sky,
    /** T0 からの経過 ms を設定する */
    at(ms: number) {
      time = T0 + ms;
    },
    /** 1 回の要求で呼ばれた提供元の順序と結果。呼ばれた提供元が受け取った検索条件は、渡したものそのもの */
    async request(): Promise<{ order: Source[]; result?: { flights: Flight[]; source: Source }; error?: unknown }> {
      const start = log.length;
      const receivedStart = received.length;
      let outcome: { result?: { flights: Flight[]; source: Source }; error?: unknown };
      try {
        outcome = { result: await fallback.fetchNearby(query) };
      } catch (error) {
        outcome = { error };
      }
      const order = log.slice(start);
      const passed = received.slice(receivedStart);
      expect(passed).toHaveLength(order.length);
      for (const q of passed) expect(q).toBe(query);
      return { order, ...outcome };
    },
    set(lolBehavior: Behavior, fiBehavior: Behavior, skyBehavior: Behavior) {
      lol.behavior = lolBehavior;
      fi.behavior = fiBehavior;
      sky.behavior = skyBehavior;
    },
  };
}

describe("優先順と最初の成功（AC-A4）", () => {
  it("主が成功 → 呼び出し 1 本、source は主", async () => {
    const s = setup();
    const { order, result } = await s.request();
    expect(order).toEqual(["adsblol"]);
    expect(result).toEqual({ flights: [flightFrom("adsblol")], source: "adsblol" });
  });

  it("主失敗 → 副成功 → 2 本、source は副", async () => {
    const s = setup();
    s.set(FAIL, OK, OK);
    const { order, result } = await s.request();
    expect(order).toEqual(["adsblol", "adsbfi"]);
    expect(result).toEqual({ flights: [flightFrom("adsbfi")], source: "adsbfi" });
  });

  it("全滅 → 3 本、最後の失敗の UpstreamError", async () => {
    const s = setup();
    s.set(FAIL, FAIL, FAIL);
    const { order, error } = await s.request();
    expect(order).toEqual(["adsblol", "adsbfi", "opensky"]);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toBe(s.sky.lastError);
  });

  it("UpstreamError 以外の例外も失敗として扱い、次の提供元に進む（後回しにもなる）", async () => {
    const s = setup();
    s.set({ type: "throw", error: new TypeError("boom") }, OK, OK);
    const first = await s.request();
    expect(first.order).toEqual(["adsblol", "adsbfi"]);
    expect(first.result?.source).toBe("adsbfi");

    s.at(1_000);
    s.set(OK, FAIL, FAIL);
    expect((await s.request()).order).toEqual(["adsbfi", "opensky", "adsblol"]);
  });

  it("最後の失敗が UpstreamError 以外なら UpstreamError に包み cause に入れる", async () => {
    const s = setup();
    const cause = new Error("unexpected");
    s.set(FAIL, FAIL, { type: "throw", error: cause });
    const { order, error } = await s.request();
    expect(order).toHaveLength(3);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).status).toBeUndefined();
    expect((error as UpstreamError).cause).toBe(cause);
  });
});

describe("失敗した提供元の後回し（AC-A5）", () => {
  it("主の失敗から 59.9 秒後の要求では主が最後に回る", async () => {
    const s = setup();
    s.set(FAIL, OK, OK);
    await s.request();

    s.at(59_900);
    s.set(FAIL, FAIL, FAIL);
    expect((await s.request()).order).toEqual(["adsbfi", "opensky", "adsblol"]);
  });

  it("主の失敗から 60 秒後の要求では主が先頭に戻る", async () => {
    const s = setup();
    s.set(FAIL, OK, OK);
    await s.request();

    s.at(60_000);
    s.set(FAIL, FAIL, FAIL);
    expect((await s.request()).order).toEqual(["adsblol", "adsbfi", "opensky"]);
  });

  it("後回しでない提供元を先に、後回し同士は優先順に試す", async () => {
    const s = setup();
    s.set(FAIL, FAIL, OK);
    expect((await s.request()).order).toEqual(["adsblol", "adsbfi", "opensky"]);

    s.at(1_000);
    s.set(FAIL, FAIL, FAIL);
    expect((await s.request()).order).toEqual(["opensky", "adsblol", "adsbfi"]);
  });

  it("後回し中の主が（最後に試されて）成功したら後回しが解除され、次の要求で先頭に戻る", async () => {
    const s = setup();
    s.set(FAIL, OK, OK);
    await s.request(); // 主は 60 秒後まで後回し

    // 副・予備は 429（後回しにはならない・5 秒で明ける）、主が最後に試されて成功
    s.at(10_000);
    s.set(OK, rateLimited(5), rateLimited(5));
    const recovered = await s.request();
    expect(recovered.order).toEqual(["adsbfi", "opensky", "adsblol"]);
    expect(recovered.result?.source).toBe("adsblol");

    // 主の元の後回し期限（60 秒）より前でも、主が先頭
    s.at(20_000);
    s.set(OK, OK, OK);
    const next = await s.request();
    expect(next.order).toEqual(["adsblol"]);
    expect(next.result?.source).toBe("adsblol");
  });

  it("全員「後回し」中でも 3 本試す", async () => {
    const s = setup();
    s.set(FAIL, FAIL, FAIL);
    await s.request();

    s.at(1_000);
    const { order, error } = await s.request();
    expect(order).toEqual(["adsblol", "adsbfi", "opensky"]);
    expect(error).toBeInstanceOf(UpstreamError);
  });

  it("failureCooldownMs は注入できる", async () => {
    let time = T0;
    const calls: Source[] = [];
    const provider = (id: Source, fail: () => boolean): PositionProvider => ({
      id,
      async fetchNearby() {
        calls.push(id);
        if (fail()) throw new UpstreamError(`${id}: HTTP 500`, { status: 500 });
        return [];
      },
    });
    let primaryFails = true;
    const fallback = createFallbackProvider(
      [provider("adsblol", () => primaryFails), provider("adsbfi", () => false)],
      { now: () => time, failureCooldownMs: 10_000 },
    );
    await fallback.fetchNearby(query);
    primaryFails = false;

    time = T0 + 9_999;
    calls.length = 0;
    await fallback.fetchNearby(query);
    expect(calls).toEqual(["adsbfi"]);

    time = T0 + 10_000;
    calls.length = 0;
    await fallback.fetchNearby(query);
    expect(calls).toEqual(["adsblol"]);
  });
});

describe("HTTP 429 の提供元は試さない（AC-A5）", () => {
  it("retryAfterSec=120 の提供元は 119 秒後も試さず、120 秒後に試す", async () => {
    const s = setup();
    s.set(rateLimited(120), OK, OK);
    expect((await s.request()).order).toEqual(["adsblol", "adsbfi"]);

    s.at(119_000);
    s.set(OK, FAIL, FAIL);
    const during = await s.request();
    expect(during.order).toEqual(["adsbfi", "opensky"]);
    expect(during.error).toBeInstanceOf(UpstreamError);

    s.at(120_000);
    const after = await s.request();
    expect(after.order).toEqual(["adsblol"]);
    expect(after.result?.source).toBe("adsblol");
    expect(s.lol.calls).toBe(2);
  });

  it("429 で retryAfterSec 無し → 60 秒", async () => {
    const s = setup();
    s.set(rateLimited(), OK, OK);
    await s.request();

    s.at(59_999);
    s.set(OK, FAIL, FAIL);
    expect((await s.request()).order).toEqual(["adsbfi", "opensky"]);

    s.at(60_000);
    expect((await s.request()).order).toEqual(["adsblol"]);
  });

  it("retryAfterSec=200000 → 86400 秒で頭打ち（86399 秒後は試さず 86400 秒後に試す）", async () => {
    const s = setup();
    s.set(rateLimited(200_000), OK, OK);
    await s.request();

    s.at(86_399_000);
    s.set(OK, FAIL, FAIL);
    expect((await s.request()).order).toEqual(["adsbfi", "opensky"]);

    s.at(86_400_000);
    expect((await s.request()).order).toEqual(["adsblol"]);
  });

  it("defaultRateLimitMs は注入できる", async () => {
    let time = T0;
    const calls: Source[] = [];
    const provider = (id: Source, rateLimited: () => boolean): PositionProvider => ({
      id,
      async fetchNearby() {
        calls.push(id);
        if (rateLimited()) throw new UpstreamError(`${id}: HTTP 429`, { status: 429 });
        return [];
      },
    });
    let primaryRateLimited = true;
    const fallback = createFallbackProvider(
      [provider("adsblol", () => primaryRateLimited), provider("adsbfi", () => false)],
      { now: () => time, defaultRateLimitMs: 10_000 },
    );
    await fallback.fetchNearby(query);
    expect(calls).toEqual(["adsblol", "adsbfi"]);
    primaryRateLimited = false;

    time = T0 + 9_999;
    calls.length = 0;
    await fallback.fetchNearby(query);
    expect(calls).toEqual(["adsbfi"]);

    time = T0 + 10_000;
    calls.length = 0;
    await fallback.fetchNearby(query);
    expect(calls).toEqual(["adsblol"]);
  });

  it("maxRateLimitMs は注入できる", async () => {
    let time = T0;
    const calls: Source[] = [];
    const provider = (id: Source, rateLimited: () => boolean): PositionProvider => ({
      id,
      async fetchNearby() {
        calls.push(id);
        if (rateLimited()) throw new UpstreamError(`${id}: HTTP 429`, { status: 429, retryAfterSec: 100 });
        return [];
      },
    });
    let primaryRateLimited = true;
    const fallback = createFallbackProvider(
      [provider("adsblol", () => primaryRateLimited), provider("adsbfi", () => false)],
      { now: () => time, maxRateLimitMs: 30_000 },
    );
    await fallback.fetchNearby(query);
    expect(calls).toEqual(["adsblol", "adsbfi"]);
    primaryRateLimited = false;

    time = T0 + 29_999;
    calls.length = 0;
    await fallback.fetchNearby(query);
    expect(calls).toEqual(["adsbfi"]);

    time = T0 + 30_000;
    calls.length = 0;
    await fallback.fetchNearby(query);
    expect(calls).toEqual(["adsblol"]);
  });

  it("429 中の提供元は試さない（呼び出し本数が減る）", async () => {
    const s = setup();
    s.set(rateLimited(120), rateLimited(120), OK);
    expect((await s.request()).order).toEqual(["adsblol", "adsbfi", "opensky"]);

    s.at(1_000);
    s.set(FAIL, FAIL, FAIL);
    const { order, error } = await s.request();
    expect(order).toEqual(["opensky"]);
    expect(error).toBe(s.sky.lastError);
  });

  it("429 は後回しにしない（明けたら優先順どおり先頭）", async () => {
    const s = setup();
    s.set(rateLimited(5), OK, OK);
    await s.request();

    s.at(5_000);
    s.set(FAIL, FAIL, FAIL);
    expect((await s.request()).order).toEqual(["adsblol", "adsbfi", "opensky"]);
  });

  it("全員 429 中 → 提供元の呼び出し 0 回で UpstreamError（status 無し、最も早く試せる時刻をメッセージに含む）", async () => {
    const s = setup();
    s.set(rateLimited(300), rateLimited(120), rateLimited(600));
    const first = await s.request();
    expect(first.order).toEqual(["adsblol", "adsbfi", "opensky"]);
    expect(first.error).toBeInstanceOf(UpstreamError);
    expect((first.error as UpstreamError).status).toBe(429);

    s.at(1_000);
    s.set(OK, OK, OK);
    const blocked = await s.request();
    expect(blocked.order).toEqual([]);
    expect(blocked.result).toBeUndefined();
    expect(blocked.error).toBeInstanceOf(UpstreamError);
    expect((blocked.error as UpstreamError).status).toBeUndefined();
    expect((blocked.error as UpstreamError).message).toContain(new Date(T0 + 120_000).toISOString());
    expect(s.lol.calls + s.fi.calls + s.sky.calls).toBe(3);

    // 最も早い 120 秒で副が試せるようになる
    s.at(120_000);
    const reopened = await s.request();
    expect(reopened.order).toEqual(["adsbfi"]);
    expect(reopened.result?.source).toBe("adsbfi");
  });
});

describe("構成", () => {
  it("提供元が空なら作成時に例外", () => {
    expect(() => createFallbackProvider([], { now: () => T0 })).toThrow();
  });
});

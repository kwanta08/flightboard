import { afterEach, describe, expect, it, vi } from "vitest";
import { UpstreamError } from "../providers/provider.ts";
import type { FetchLike } from "../providers/provider.ts";
import { createAdsbdbClient } from "./client.ts";
import type { AdsbdbAircraft, AdsbdbClient, AircraftLookup, RouteLookup } from "./client.ts";
import { createEnrichment } from "./enrichment.ts";
import type { Enrichment, EnrichmentOptions } from "./enrichment.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const T0 = Date.UTC(2026, 8, 15, 0, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

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

/** 待っているマイクロタスクをすべて流す */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

type RouteCall = { callsign: string } & Deferred<RouteLookup>;
type AircraftCall = { hex: string } & Deferred<AircraftLookup>;

/** 照会ごとに Deferred を作り、解決を手で制御できる偽クライアント */
function manualClient() {
  const routeCalls: RouteCall[] = [];
  const aircraftCalls: AircraftCall[] = [];
  const client: AdsbdbClient = {
    lookupRoute(callsign) {
      const d = deferred<RouteLookup>();
      routeCalls.push({ callsign, ...d });
      return d.promise;
    },
    lookupAircraft(hex) {
      const d = deferred<AircraftLookup>();
      aircraftCalls.push({ hex, ...d });
      return d.promise;
    },
  };
  return { client, routeCalls, aircraftCalls };
}

function setup(options: Partial<Omit<EnrichmentOptions, "client" | "now">> = {}) {
  let time = T0;
  const fake = manualClient();
  const enrichment = createEnrichment({ client: fake.client, now: () => time, ...options });
  return {
    ...fake,
    enrichment,
    setTime: (t: number) => {
      time = t;
    },
  };
}

function foundRoute(callsign: string): Extract<RouteLookup, { status: "found" }> {
  return {
    status: "found",
    airline: { icao: callsign.slice(0, 3), iata: "NH", name: "All Nippon Airways" },
    route: {
      origin: { icao: "RJTT", iata: "HND", name: "Tokyo Haneda International Airport", municipality: "Tokyo" },
      destination: { icao: "RJOO", iata: "ITM", name: "Osaka International Airport", municipality: "Osaka" },
      source: "adsbdb",
    },
  };
}

const UNKNOWN = { status: "unknown" } as const;

const AIRCRAFT: AdsbdbAircraft = {
  model: "Boeing 787 9",
  photo: { url: "https://image.airport-data.com/aircraft/000000001.jpg", credit: "airport-data.com（adsbdb 経由）" },
};

function callsigns(calls: RouteCall[]): string[] {
  return calls.map((c) => c.callsign);
}

describe("enqueueRoutes の重複排除（AC-A13）", () => {
  it("同じコールサインを 2 回積んでも照会は 1 回", async () => {
    const s = setup();
    s.enrichment.enqueueRoutes(["ANA245", "ANA245"]);
    s.enrichment.enqueueRoutes(["ANA245"]);
    await flush();

    expect(callsigns(s.routeCalls)).toEqual(["ANA245"]);
    s.routeCalls[0]!.resolve(foundRoute("ANA245"));
    await flush();
    expect(callsigns(s.routeCalls)).toEqual(["ANA245"]);
  });

  it("照会中・キュー内のコールサインは積まない", async () => {
    const s = setup();
    s.enrichment.enqueueRoutes(["ANA245", "JAL123"]);
    await flush();
    expect(callsigns(s.routeCalls)).toEqual(["ANA245"]);
    expect(s.enrichment.sizes().queue).toBe(1);

    // ANA245 は照会中、JAL123 はキュー内
    s.enrichment.enqueueRoutes(new Set(["ANA245", "JAL123", "SKY1"]));
    expect(s.enrichment.sizes().queue).toBe(2);

    s.routeCalls[0]!.resolve(foundRoute("ANA245"));
    await flush();
    s.routeCalls[1]!.resolve(UNKNOWN);
    await flush();
    s.routeCalls[2]!.resolve(UNKNOWN);
    await flush();

    expect(callsigns(s.routeCalls)).toEqual(["ANA245", "JAL123", "SKY1"]);
    expect(s.enrichment.sizes().queue).toBe(0);
  });

  it("空文字は積まない", async () => {
    const s = setup();
    s.enrichment.enqueueRoutes(["", "ANA245", ""]);
    await flush();
    s.routeCalls[0]?.resolve(UNKNOWN);
    await flush();
    expect(callsigns(s.routeCalls)).toEqual(["ANA245"]);
  });

  it("maxQueue: 3 で 5 件積むと照会は 3 件", async () => {
    const s = setup({ maxQueue: 3 });
    s.enrichment.enqueueRoutes(["A1", "A2", "A3", "A4", "A5"]);
    for (let i = 0; i < 5; i++) {
      await flush();
      s.routeCalls[i]?.resolve(UNKNOWN);
    }
    await flush();
    expect(callsigns(s.routeCalls)).toEqual(["A1", "A2", "A3"]);
  });

  it("maxQueue の既定は 500", async () => {
    const lookups: string[] = [];
    const enrichment = createEnrichment({
      client: {
        lookupRoute: async (callsign) => {
          lookups.push(callsign);
          return UNKNOWN;
        },
        lookupAircraft: async () => UNKNOWN,
      },
      now: () => T0,
    });
    enrichment.enqueueRoutes(Array.from({ length: 600 }, (_, i) => `CS${i}`));
    for (let i = 0; i < 10 && enrichment.sizes().queue > 0; i++) await flush();
    expect(lookups).toHaveLength(500);
    expect(lookups[499]).toBe("CS499");
  });
});

describe("enqueueRoutes は照会を待たない（AC-A13）", () => {
  it("偽クライアントが解決しなくても戻り、worker は 1 件ずつ完了を待って次へ進む", async () => {
    const s = setup();
    const returned: unknown = s.enrichment.enqueueRoutes(["ANA245", "JAL123", "SKY1"]);
    expect(returned).toBeUndefined();

    await flush();
    // 先頭の照会が終わるまで次の照会を始めない（全件を一度に投入しない）
    expect(callsigns(s.routeCalls)).toEqual(["ANA245"]);
    expect(s.enrichment.sizes().queue).toBe(2);

    s.routeCalls[0]!.resolve(foundRoute("ANA245"));
    await flush();
    expect(callsigns(s.routeCalls)).toEqual(["ANA245", "JAL123"]);
  });
});

describe("getRoute（AC-A13）", () => {
  it("found は値を返す（airline と route）。照会前・照会中は undefined", async () => {
    const s = setup();
    expect(s.enrichment.getRoute("ANA245")).toBeUndefined();
    s.enrichment.enqueueRoutes(["ANA245"]);
    await flush();
    expect(s.enrichment.getRoute("ANA245")).toBeUndefined();

    const result = foundRoute("ANA245");
    s.routeCalls[0]!.resolve(result);
    await flush();
    expect(s.enrichment.getRoute("ANA245")).toStrictEqual({ airline: result.airline, route: result.route });
  });

  it("airline の無い found は route だけを返す", async () => {
    const s = setup();
    s.enrichment.enqueueRoutes(["XYZ1"]);
    await flush();
    const { route } = foundRoute("XYZ1");
    s.routeCalls[0]!.resolve({ status: "found", route });
    await flush();
    const value = s.enrichment.getRoute("XYZ1");
    expect(value).toStrictEqual({ route });
    expect(value !== undefined && "airline" in value).toBe(false);
  });

  it("unknown は undefined", async () => {
    const s = setup();
    s.enrichment.enqueueRoutes(["XYZ999"]);
    await flush();
    s.routeCalls[0]!.resolve(UNKNOWN);
    await flush();
    expect(s.enrichment.getRoute("XYZ999")).toBeUndefined();
    expect(s.enrichment.sizes().routes).toBe(1);
  });

  it("通信失敗は undefined", async () => {
    const s = setup();
    s.enrichment.enqueueRoutes(["ANA245"]);
    await flush();
    s.routeCalls[0]!.reject(new UpstreamError("adsbdb: HTTP 500", { status: 500 }));
    await flush();
    expect(s.enrichment.getRoute("ANA245")).toBeUndefined();
    expect(s.enrichment.sizes().routes).toBe(1);
  });
});

describe("ルートの TTL（AC-A13）", () => {
  it.each([
    ["found", foundRoute("ANA245") as RouteLookup],
    ["unknown", UNKNOWN as RouteLookup],
  ])("%s は 6 時間未満はキャッシュ（再度積んでも照会しない）、6 時間で再照会", async (kind, result) => {
    const s = setup();
    s.enrichment.enqueueRoutes(["ANA245"]);
    await flush();
    s.setTime(T0 + 1000); // 保存時刻は照会の完了時
    s.routeCalls[0]!.resolve(result);
    await flush();

    s.setTime(T0 + 1000 + 6 * HOUR - 1);
    s.enrichment.enqueueRoutes(["ANA245"]);
    await flush();
    expect(s.routeCalls).toHaveLength(1);
    expect(s.enrichment.getRoute("ANA245") !== undefined).toBe(kind === "found");

    s.setTime(T0 + 1000 + 6 * HOUR);
    expect(s.enrichment.getRoute("ANA245")).toBeUndefined();
    s.enrichment.enqueueRoutes(["ANA245"]);
    await flush();
    expect(callsigns(s.routeCalls)).toEqual(["ANA245", "ANA245"]);
  });

  it.each([
    ["UpstreamError", () => new UpstreamError("adsbdb: timed out after 5000ms")],
    ["UpstreamError 以外の例外", () => new TypeError("boom")],
  ])("通信失敗（%s）は 5 分未満はキャッシュ、5 分で再照会", async (_label, makeError) => {
    const s = setup();
    s.enrichment.enqueueRoutes(["ANA245"]);
    await flush();
    s.routeCalls[0]!.reject(makeError());
    await flush();

    s.setTime(T0 + 5 * MINUTE - 1);
    s.enrichment.enqueueRoutes(["ANA245"]);
    await flush();
    expect(s.routeCalls).toHaveLength(1);

    s.setTime(T0 + 5 * MINUTE);
    s.enrichment.enqueueRoutes(["ANA245"]);
    await flush();
    expect(s.routeCalls).toHaveLength(2);
  });

  it("TTL は注入できる", async () => {
    const s = setup({ routeTtlMs: 1000, errorTtlMs: 100 });
    s.enrichment.enqueueRoutes(["A1", "A2"]);
    await flush();
    s.routeCalls[0]!.resolve(UNKNOWN);
    await flush();
    s.routeCalls[1]!.reject(new Error("down"));
    await flush();

    s.setTime(T0 + 100);
    s.enrichment.enqueueRoutes(["A1", "A2"]);
    await flush();
    expect(callsigns(s.routeCalls)).toEqual(["A1", "A2", "A2"]);
    s.routeCalls[2]!.resolve(UNKNOWN);
    await flush();

    s.setTime(T0 + 1000);
    s.enrichment.enqueueRoutes(["A1"]);
    await flush();
    expect(callsigns(s.routeCalls)).toEqual(["A1", "A2", "A2", "A1"]);
  });
});

describe("worker は例外で止まらない（AC-A13）", () => {
  it("照会中の例外の後も次のコールサインの照会が進む", async () => {
    const s = setup();
    s.enrichment.enqueueRoutes(["ANA245", "JAL123"]);
    await flush();
    s.routeCalls[0]!.reject(new UpstreamError("adsbdb: request failed"));
    await flush();

    expect(callsigns(s.routeCalls)).toEqual(["ANA245", "JAL123"]);
    s.routeCalls[1]!.resolve(foundRoute("JAL123"));
    await flush();
    expect(s.enrichment.getRoute("JAL123")).toBeDefined();
  });

  it("クライアントが同期で例外を投げても次へ進み、後から積んだものも照会する", async () => {
    const lookups: string[] = [];
    const enrichment = createEnrichment({
      client: {
        lookupRoute(callsign) {
          lookups.push(callsign);
          if (callsign === "BAD1") throw new Error("sync boom");
          return Promise.resolve(foundRoute(callsign));
        },
        lookupAircraft: async () => UNKNOWN,
      },
      now: () => T0,
    });

    enrichment.enqueueRoutes(["BAD1", "ANA245"]);
    await flush();
    enrichment.enqueueRoutes(["JAL123"]);
    await flush();

    expect(lookups).toEqual(["BAD1", "ANA245", "JAL123"]);
    expect(enrichment.getRoute("BAD1")).toBeUndefined();
    expect(enrichment.getRoute("ANA245")).toBeDefined();
    expect(enrichment.getRoute("JAL123")).toBeDefined();
  });
});

describe("getAircraft（AC-A16）", () => {
  it("found の値を返す", async () => {
    const s = setup();
    const pending = s.enrichment.getAircraft("869236");
    await flush();
    expect(s.aircraftCalls.map((c) => c.hex)).toEqual(["869236"]);
    s.aircraftCalls[0]!.resolve({ status: "found", aircraft: AIRCRAFT });
    expect(await pending).toStrictEqual(AIRCRAFT);
  });

  it("unknown は undefined", async () => {
    const s = setup();
    const pending = s.enrichment.getAircraft("abcdef");
    await flush();
    s.aircraftCalls[0]!.resolve(UNKNOWN);
    expect(await pending).toBeUndefined();
  });

  it.each([
    ["UpstreamError", () => new UpstreamError("adsbdb: HTTP 500", { status: 500 })],
    ["UpstreamError 以外の例外", () => new TypeError("boom")],
  ])("通信失敗（%s）は undefined を返し、投げない", async (_label, makeError) => {
    const s = setup();
    const pending = s.enrichment.getAircraft("869236");
    await flush();
    s.aircraftCalls[0]!.reject(makeError());
    await expect(pending).resolves.toBeUndefined();
  });

  it("クライアントが同期で例外を投げても undefined を返す", async () => {
    const enrichment = createEnrichment({
      client: {
        lookupRoute: async () => UNKNOWN,
        lookupAircraft: () => {
          throw new Error("sync boom");
        },
      },
      now: () => T0,
    });
    await expect(enrichment.getAircraft("869236")).resolves.toBeUndefined();
  });

  it.each([
    ["found", { status: "found", aircraft: AIRCRAFT } as AircraftLookup, AIRCRAFT],
    ["unknown", UNKNOWN as AircraftLookup, undefined],
  ])("%s は 7 日未満はキャッシュ（照会しない）、7 日で再照会", async (_kind, result, expected) => {
    const s = setup();
    const first = s.enrichment.getAircraft("869236");
    await flush();
    s.aircraftCalls[0]!.resolve(result);
    expect(await first).toStrictEqual(expected);

    s.setTime(T0 + 7 * DAY - 1);
    expect(await s.enrichment.getAircraft("869236")).toStrictEqual(expected);
    expect(s.aircraftCalls).toHaveLength(1);

    s.setTime(T0 + 7 * DAY);
    const again = s.enrichment.getAircraft("869236");
    await flush();
    expect(s.aircraftCalls).toHaveLength(2);
    s.aircraftCalls[1]!.resolve({ status: "found", aircraft: { model: "Airbus A350 900" } });
    expect(await again).toStrictEqual({ model: "Airbus A350 900" });
  });

  it("通信失敗は 5 分未満はキャッシュ（照会せず undefined）、5 分で再照会", async () => {
    const s = setup();
    const first = s.enrichment.getAircraft("869236");
    await flush();
    s.aircraftCalls[0]!.reject(new UpstreamError("adsbdb: request failed"));
    expect(await first).toBeUndefined();

    s.setTime(T0 + 5 * MINUTE - 1);
    expect(await s.enrichment.getAircraft("869236")).toBeUndefined();
    expect(s.aircraftCalls).toHaveLength(1);

    s.setTime(T0 + 5 * MINUTE);
    const again = s.enrichment.getAircraft("869236");
    await flush();
    expect(s.aircraftCalls).toHaveLength(2);
    s.aircraftCalls[1]!.resolve({ status: "found", aircraft: AIRCRAFT });
    expect(await again).toStrictEqual(AIRCRAFT);
  });

  it("同じ hex の同時呼び出しは照会を 1 回に共有する（別の hex は別に照会）", async () => {
    const s = setup();
    const a = s.enrichment.getAircraft("869236");
    const b = s.enrichment.getAircraft("869236");
    const c = s.enrichment.getAircraft("abcdef");
    await flush();
    expect(s.aircraftCalls.map((call) => call.hex)).toEqual(["869236", "abcdef"]);

    s.aircraftCalls[0]!.resolve({ status: "found", aircraft: AIRCRAFT });
    s.aircraftCalls[1]!.resolve(UNKNOWN);
    expect(await a).toStrictEqual(AIRCRAFT);
    expect(await b).toStrictEqual(AIRCRAFT);
    expect(await c).toBeUndefined();

    // 完了後はキャッシュから返す
    expect(await s.enrichment.getAircraft("869236")).toStrictEqual(AIRCRAFT);
    expect(s.aircraftCalls).toHaveLength(2);
  });

  it("同時呼び出しの共有は失敗でも undefined を返し、完了後は 5 分キャッシュ", async () => {
    const s = setup();
    const a = s.enrichment.getAircraft("869236");
    const b = s.enrichment.getAircraft("869236");
    await flush();
    s.aircraftCalls[0]!.reject(new Error("down"));
    expect(await a).toBeUndefined();
    expect(await b).toBeUndefined();
    expect(await s.enrichment.getAircraft("869236")).toBeUndefined();
    expect(s.aircraftCalls).toHaveLength(1);
  });

  it("TTL は注入できる", async () => {
    const s = setup({ aircraftTtlMs: 1000 });
    const first = s.enrichment.getAircraft("869236");
    await flush();
    s.aircraftCalls[0]!.resolve(UNKNOWN);
    await first;

    s.setTime(T0 + 999);
    await s.enrichment.getAircraft("869236");
    expect(s.aircraftCalls).toHaveLength(1);

    s.setTime(T0 + 1000);
    void s.enrichment.getAircraft("869236");
    await flush();
    expect(s.aircraftCalls).toHaveLength(2);
  });
});

describe("期限切れのエントリの掃除", () => {
  /** ルート 3 件（found・unknown・通信失敗）と機体 2 件（found・通信失敗）を T0 に保存する */
  async function populated() {
    const s = setup();
    s.enrichment.enqueueRoutes(["FOUND1", "UNKNOWN1", "FAILED1"]);
    await flush();
    s.routeCalls[0]!.resolve(foundRoute("FOUND1"));
    await flush();
    s.routeCalls[1]!.resolve(UNKNOWN);
    await flush();
    s.routeCalls[2]!.reject(new Error("down"));
    await flush();

    const found = s.enrichment.getAircraft("aaaaaa");
    const failed = s.enrichment.getAircraft("bbbbbb");
    await flush();
    s.aircraftCalls[0]!.resolve({ status: "found", aircraft: AIRCRAFT });
    s.aircraftCalls[1]!.reject(new Error("down"));
    await Promise.all([found, failed]);

    expect(s.enrichment.sizes()).toEqual({ routes: 3, aircraft: 2, queue: 0 });
    return s;
  }

  it("sizes() も期限切れを掃除してから数える（ほかの呼び出しが無くても）", async () => {
    const s = await populated();
    s.setTime(T0 + 5 * MINUTE);
    expect(s.enrichment.sizes()).toEqual({ routes: 2, aircraft: 1, queue: 0 });
    s.setTime(T0 + 8 * DAY);
    expect(s.enrichment.sizes()).toEqual({ routes: 0, aircraft: 0, queue: 0 });
  });

  // sizes() も掃除するので、各呼び出しが掃除することは sizes() を使わずに確かめる:
  // 削除していなければ、時計を期限内の時刻に戻したとき保存した値がそのまま返る
  it.each<[string, (enrichment: Enrichment) => void]>([
    ["getRoute", (enrichment) => void enrichment.getRoute("OTHER")],
    ["enqueueRoutes（空の入力）", (enrichment) => enrichment.enqueueRoutes([])],
    ["getAircraft", (enrichment) => void enrichment.getAircraft("cccccc")],
  ])("%s の呼び出しで削除した期限切れのエントリは、時計が戻っても返らない", async (_label, call) => {
    const s = await populated();
    s.setTime(T0 + 7 * DAY);
    call(s.enrichment);

    s.setTime(T0 + 5 * MINUTE - 1);
    expect(s.enrichment.getRoute("FOUND1")).toBeUndefined();
    const aircraftCallsBefore = s.aircraftCalls.length;
    void s.enrichment.getAircraft("aaaaaa");
    expect(s.aircraftCalls).toHaveLength(aircraftCallsBefore + 1);
  });

  it("getRoute の呼び出しで期限切れを削除する", async () => {
    const s = await populated();
    s.setTime(T0 + 5 * MINUTE);
    s.enrichment.getRoute("OTHER");
    expect(s.enrichment.sizes()).toEqual({ routes: 2, aircraft: 1, queue: 0 });

    s.setTime(T0 + 6 * HOUR);
    s.enrichment.getRoute("OTHER");
    expect(s.enrichment.sizes()).toEqual({ routes: 0, aircraft: 1, queue: 0 });

    s.setTime(T0 + 7 * DAY);
    s.enrichment.getRoute("OTHER");
    expect(s.enrichment.sizes()).toEqual({ routes: 0, aircraft: 0, queue: 0 });
  });

  it("enqueueRoutes の呼び出しで期限切れを削除する（空の入力でも）", async () => {
    const s = await populated();
    s.setTime(T0 + 6 * HOUR);
    s.enrichment.enqueueRoutes([]);
    expect(s.enrichment.sizes()).toEqual({ routes: 0, aircraft: 1, queue: 0 });

    s.setTime(T0 + 7 * DAY);
    s.enrichment.enqueueRoutes([]);
    expect(s.enrichment.sizes()).toEqual({ routes: 0, aircraft: 0, queue: 0 });
  });

  it("getAircraft の呼び出しで期限切れを削除する", async () => {
    const s = await populated();
    s.setTime(T0 + 7 * DAY);
    void s.enrichment.getAircraft("cccccc");
    expect(s.enrichment.sizes()).toEqual({ routes: 0, aircraft: 0, queue: 0 });
  });

  it("期限内のエントリは残る", async () => {
    const s = await populated();
    s.setTime(T0 + 6 * HOUR - 1);
    s.enrichment.getRoute("OTHER");
    expect(s.enrichment.sizes()).toEqual({ routes: 2, aircraft: 1, queue: 0 });
    expect(s.enrichment.getRoute("FOUND1")).toBeDefined();
  });
});

function rateLimited(retryAfterSec?: number): UpstreamError {
  return new UpstreamError("adsbdb: HTTP 429", { status: 429, retryAfterSec });
}

describe("adsbdb のレート制限（HTTP 429）で照会を休止する（MAJOR-1）", () => {
  const FIVE = ["A1", "A2", "A3", "A4", "A5"];

  /** 5 件積み、1 件目の照会を T0 に 429（retryAfterSec: 30）で失敗させる */
  async function rateLimitedAfterFive() {
    const s = setup();
    s.enrichment.enqueueRoutes(FIVE);
    await flush();
    expect(callsigns(s.routeCalls)).toEqual(["A1"]);
    s.routeCalls[0]!.reject(rateLimited(30));
    await flush();
    return s;
  }

  it("5 件積んで 1 件目の照会が 429 → 残り 4 件は照会せず、キューを空にし（sizes().queue が 0）、1 件目は失敗としてキャッシュしない", async () => {
    const s = await rateLimitedAfterFive();
    expect(callsigns(s.routeCalls)).toEqual(["A1"]);
    expect(FIVE.map((cs) => s.enrichment.getRoute(cs))).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(s.enrichment.sizes()).toEqual({ routes: 0, aircraft: 0, queue: 0 });
  });

  it("30 秒未満の enqueueRoutes は積まず照会もせず、30 秒後の enqueueRoutes で渡したものだけを照会する（429 を受けた A1 も渡せば照会する）", async () => {
    const s = await rateLimitedAfterFive();

    s.setTime(T0 + 30_000 - 1);
    s.enrichment.enqueueRoutes([...FIVE, "A6"]);
    await flush();
    expect(s.routeCalls).toHaveLength(1);
    expect(s.enrichment.sizes().queue).toBe(0);
    expect(s.enrichment.getRoute("A1")).toBeUndefined();

    s.setTime(T0 + 30_000);
    s.enrichment.enqueueRoutes(["A1", "A3", "A6"]);
    for (let i = 1; i <= 3; i++) {
      await flush();
      const call = s.routeCalls[i]!;
      call.resolve(foundRoute(call.callsign));
    }
    await flush();
    expect(callsigns(s.routeCalls)).toEqual(["A1", "A1", "A3", "A6"]);
    expect(["A1", "A3", "A6"].every((cs) => s.enrichment.getRoute(cs) !== undefined)).toBe(true);
    expect(["A2", "A4", "A5"].map((cs) => s.enrichment.getRoute(cs))).toEqual([undefined, undefined, undefined]);
    expect(s.enrichment.sizes().queue).toBe(0);
  });

  it("休止中の getAircraft は照会せず undefined を返し（キャッシュもしない）、明けた後は照会する。期限内のキャッシュは休止中も返す", async () => {
    const s = setup();
    const cachedLookup = s.enrichment.getAircraft("aaaaaa");
    s.aircraftCalls[0]!.resolve({ status: "found", aircraft: AIRCRAFT });
    expect(await cachedLookup).toStrictEqual(AIRCRAFT);

    s.enrichment.enqueueRoutes(["A1"]);
    await flush();
    s.routeCalls[0]!.reject(rateLimited(30));
    await flush();

    s.setTime(T0 + 30_000 - 1);
    expect(await s.enrichment.getAircraft("869236")).toBeUndefined();
    expect(await s.enrichment.getAircraft("aaaaaa")).toStrictEqual(AIRCRAFT);
    expect(s.aircraftCalls).toHaveLength(1);
    expect(s.enrichment.sizes().aircraft).toBe(1);

    s.setTime(T0 + 30_000);
    const pending = s.enrichment.getAircraft("869236");
    expect(s.aircraftCalls.map((c) => c.hex)).toEqual(["aaaaaa", "869236"]);
    s.aircraftCalls[1]!.resolve({ status: "found", aircraft: AIRCRAFT });
    expect(await pending).toStrictEqual(AIRCRAFT);
  });

  it("getAircraft 自身の 429 で休止してキューを空にし、その間は機体・ルートとも照会しない（照会中だったルートの次へも進まない）", async () => {
    const s = setup();
    s.enrichment.enqueueRoutes(["A1", "A2"]);
    await flush();
    expect(callsigns(s.routeCalls)).toEqual(["A1"]);
    expect(s.enrichment.sizes().queue).toBe(1);

    const first = s.enrichment.getAircraft("869236");
    s.aircraftCalls[0]!.reject(rateLimited(30));
    expect(await first).toBeUndefined();
    expect(s.enrichment.sizes().queue).toBe(0);

    // 休止の前に始めたルート照会の結果は保存するが、worker は次へ進まない
    s.routeCalls[0]!.resolve(foundRoute("A1"));
    await flush();
    expect(callsigns(s.routeCalls)).toEqual(["A1"]);
    expect(s.enrichment.getRoute("A1")).toBeDefined();

    s.setTime(T0 + 30_000 - 1);
    s.enrichment.enqueueRoutes(["A2", "A3"]);
    expect(await s.enrichment.getAircraft("869236")).toBeUndefined();
    await flush();
    expect(s.routeCalls).toHaveLength(1);
    expect(s.aircraftCalls).toHaveLength(1);
    expect(s.enrichment.sizes()).toEqual({ routes: 1, aircraft: 0, queue: 0 });

    s.setTime(T0 + 30_000);
    s.enrichment.enqueueRoutes(["A2", "A3"]);
    void s.enrichment.getAircraft("869236");
    await flush();
    expect(callsigns(s.routeCalls)).toEqual(["A1", "A2"]);
    expect(s.aircraftCalls.map((c) => c.hex)).toEqual(["869236", "869236"]);
  });

  it.each<[string, number | undefined, number]>([
    ["retryAfterSec が無い → 60 秒", undefined, 60_000],
    ["retryAfterSec: 200000 → 86400 秒で頭打ち", 200_000, 86_400_000],
  ])("休止の長さ: %s", async (_label, retryAfterSec, pauseMs) => {
    const s = setup();
    s.enrichment.enqueueRoutes(["A1"]);
    await flush();
    s.routeCalls[0]!.reject(rateLimited(retryAfterSec));
    await flush();

    s.setTime(T0 + pauseMs - 1);
    s.enrichment.enqueueRoutes(["A1"]);
    await flush();
    expect(s.routeCalls).toHaveLength(1);

    s.setTime(T0 + pauseMs);
    s.enrichment.enqueueRoutes(["A1"]);
    await flush();
    expect(callsigns(s.routeCalls)).toEqual(["A1", "A1"]);
  });

  it("429 以外の失敗（HTTP 500）は従来どおり 5 分キャッシュし、worker も止めない", async () => {
    const s = setup();
    s.enrichment.enqueueRoutes(["A1", "A2"]);
    await flush();
    s.routeCalls[0]!.reject(new UpstreamError("adsbdb: HTTP 500", { status: 500 }));
    await flush();
    expect(callsigns(s.routeCalls)).toEqual(["A1", "A2"]);
    s.routeCalls[1]!.resolve(UNKNOWN);
    const aircraftLookup = s.enrichment.getAircraft("869236");
    s.aircraftCalls[0]!.reject(new UpstreamError("adsbdb: HTTP 500", { status: 500 }));
    expect(await aircraftLookup).toBeUndefined();
    await flush();

    s.setTime(T0 + 5 * MINUTE - 1);
    s.enrichment.enqueueRoutes(["A1"]);
    expect(await s.enrichment.getAircraft("869236")).toBeUndefined();
    await flush();
    expect(s.routeCalls).toHaveLength(2);
    expect(s.aircraftCalls).toHaveLength(1);

    s.setTime(T0 + 5 * MINUTE);
    s.enrichment.enqueueRoutes(["A1"]);
    void s.enrichment.getAircraft("869236");
    await flush();
    expect(callsigns(s.routeCalls)).toEqual(["A1", "A2", "A1"]);
    expect(s.aircraftCalls).toHaveLength(2);
  });

  it("休止に入るときに空にしたキューは上限の枠を残さず、明けた後の enqueueRoutes で渡したものを上限まで積める（maxQueue: 2）", async () => {
    const s = setup({ maxQueue: 2 });
    s.enrichment.enqueueRoutes(["A1", "A2"]);
    await flush();
    s.enrichment.enqueueRoutes(["A3"]);
    expect(s.enrichment.sizes().queue).toBe(2);

    s.routeCalls[0]!.reject(rateLimited(30));
    await flush();
    expect(s.enrichment.sizes().queue).toBe(0);

    // 休止前にキューにあった A2 は照会せず、渡した A3・A4 を積む（上限 2 なので A5 は積まない）
    s.setTime(T0 + 30_000);
    s.enrichment.enqueueRoutes(["A3", "A4", "A5"]);
    for (let i = 1; i <= 3; i++) {
      await flush();
      s.routeCalls[i]?.resolve(UNKNOWN);
    }
    await flush();
    expect(callsigns(s.routeCalls)).toEqual(["A1", "A3", "A4"]);

    s.enrichment.enqueueRoutes(["A5"]);
    await flush();
    expect(callsigns(s.routeCalls)).toEqual(["A1", "A3", "A4", "A5"]);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const airport = (icao: string) => ({ icao_code: icao, iata_code: "", name: `${icao} Airport`, municipality: "", latitude: 35, longitude: 139 });

describe("本物のクライアントでの HTTP 429（MAJOR-1）", () => {
  it("ルート照会の 429（Retry-After: 30）の後、キューを空にして 30 秒間は adsbdb に要求を送らず、明けた後の enqueueRoutes で渡したものを先頭から照会する", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let time = T0;
    let limited = true;
    const requests: { path: string; at: number }[] = [];
    const fetchImpl: FetchLike = async (url) => {
      const path = new URL(url).pathname;
      requests.push({ path, at: time });
      if (limited) return new Response("slow down", { status: 429, headers: { "Retry-After": "30" } });
      return path.startsWith("/v0/aircraft/")
        ? jsonResponse({ response: { aircraft: { manufacturer: "Boeing", type: "787 9", url_photo: null } } })
        : jsonResponse({ response: { flightroute: { airline: null, origin: airport("RJTT"), destination: airport("RJOO") } } });
    };
    const client = createAdsbdbClient({
      fetch: fetchImpl,
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    });
    const enrichment = createEnrichment({ client, now: () => time });

    const queued = Array.from({ length: 5 }, (_, i) => `ANA${100 + i}`);
    enrichment.enqueueRoutes(queued);
    for (let i = 0; i < 10; i++) await flush();
    expect(requests.map((r) => r.path)).toEqual(["/v0/callsign/ANA100"]);
    expect(enrichment.sizes()).toEqual({ routes: 0, aircraft: 0, queue: 0 });
    limited = false;

    time = T0 + 30_000 - 1;
    enrichment.enqueueRoutes(queued);
    expect(await enrichment.getAircraft("869236")).toBeUndefined();
    for (let i = 0; i < 10; i++) await flush();
    expect(requests).toHaveLength(1);
    expect(enrichment.sizes().queue).toBe(0);

    time = T0 + 30_000;
    enrichment.enqueueRoutes(queued);
    for (let i = 0; i < 1000 && enrichment.sizes().routes < 5; i++) await flush();
    expect(requests.map((r) => r.path)).toEqual(["/v0/callsign/ANA100", ...queued.map((cs) => `/v0/callsign/${cs}`)]);
    expect(requests.map((r) => r.at - T0)).toEqual([0, 30_000, 30_120, 30_240, 30_360, 30_480]);
    expect(queued.every((cs) => enrichment.getRoute(cs) !== undefined)).toBe(true);
  });

  it('クライアントが既に制限中（即時拒否の 429）なら、enqueueRoutes・getAircraft は要求を送らず、A1 はキューに残らず、明けた後の enqueueRoutes(["A1"]) で照会する', async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let time = T0;
    let limited = true;
    const requests: { path: string; at: number }[] = [];
    const fetchImpl: FetchLike = async (url) => {
      const path = new URL(url).pathname;
      requests.push({ path, at: time });
      if (limited) return new Response("slow down", { status: 429, headers: { "Retry-After": "30" } });
      return path.startsWith("/v0/aircraft/")
        ? jsonResponse({ response: { aircraft: { manufacturer: "Boeing", type: "787 9", url_photo: null } } })
        : jsonResponse({ response: { flightroute: { airline: null, origin: airport("RJTT"), destination: airport("RJOO") } } });
    };
    const client = createAdsbdbClient({
      fetch: fetchImpl,
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    });

    // enrichment を通さずにクライアントだけが 429 を受ける（enrichment はまだ休止していない）
    const direct = await client.lookupRoute("ANA245").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(direct).toBeInstanceOf(UpstreamError);
    expect((direct as UpstreamError).status).toBe(429);
    expect((direct as UpstreamError).retryAfterSec).toBe(30);
    expect(requests).toHaveLength(1);
    limited = false;

    const enrichment = createEnrichment({ client, now: () => time });
    enrichment.enqueueRoutes(["A1"]);
    expect(await enrichment.getAircraft("abc123")).toBeUndefined();
    for (let i = 0; i < 10; i++) await flush();
    expect(requests).toHaveLength(1);
    expect(enrichment.getRoute("A1")).toBeUndefined();
    expect(enrichment.sizes()).toEqual({ routes: 0, aircraft: 0, queue: 0 });

    time = T0 + 30_000 - 1;
    enrichment.enqueueRoutes(["A1"]);
    for (let i = 0; i < 10; i++) await flush();
    expect(requests).toHaveLength(1);
    expect(enrichment.sizes().queue).toBe(0);

    time = T0 + 30_000;
    enrichment.enqueueRoutes(["A1"]);
    for (let i = 0; i < 1000 && enrichment.getRoute("A1") === undefined; i++) await flush();
    expect(requests.map((r) => r.path)).toEqual(["/v0/callsign/ANA245", "/v0/callsign/A1"]);
    expect(requests.map((r) => r.at - T0)).toEqual([0, 30_000]);
    expect(enrichment.getRoute("A1")).toBeDefined();
    expect(enrichment.sizes()).toEqual({ routes: 1, aircraft: 0, queue: 0 });
  });
});

describe("機体情報の照会はルートのキューより先に処理される（AC-A14）", () => {
  it("本物のクライアントで、ルートを 10 件積んだ直後の getAircraft は adsbdb への要求の 2 番目以内に届く", async () => {
    let time = T0;
    const requests: { path: string; at: number }[] = [];
    const fetchImpl: FetchLike = async (url) => {
      const path = new URL(url).pathname;
      requests.push({ path, at: time });
      return path.startsWith("/v0/aircraft/")
        ? jsonResponse({ response: { aircraft: { manufacturer: "Boeing", type: "787 9", url_photo: null } } })
        : jsonResponse({ response: { flightroute: { airline: null, origin: airport("RJTT"), destination: airport("RJOO") } } });
    };
    const client = createAdsbdbClient({
      fetch: fetchImpl,
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    });
    const enrichment = createEnrichment({ client, now: () => time });

    const queued = Array.from({ length: 10 }, (_, i) => `ANA${100 + i}`);
    enrichment.enqueueRoutes(queued);
    const aircraft = await enrichment.getAircraft("869236");
    expect(aircraft).toStrictEqual({ model: "Boeing 787 9" });

    for (let i = 0; i < 1000 && enrichment.sizes().routes < 10; i++) await flush();
    expect(requests).toHaveLength(11);

    const aircraftIndex = requests.findIndex((r) => r.path === "/v0/aircraft/869236");
    expect(aircraftIndex).toBeGreaterThanOrEqual(0);
    expect(aircraftIndex).toBeLessThanOrEqual(1);

    for (let i = 1; i < requests.length; i++) {
      expect(requests[i]!.at - requests[i - 1]!.at).toBeGreaterThanOrEqual(120);
    }
    expect(queued.every((cs) => enrichment.getRoute(cs) !== undefined)).toBe(true);
  });
});

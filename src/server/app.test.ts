import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EARTH_RADIUS_KM, haversineKm } from "../shared/geo.ts";
import type { Flight, TrackPoint } from "../shared/types.ts";
import { ADSBDB_PHOTO_CREDIT } from "./adsbdb/client.ts";
import type { AdsbdbAircraft, AdsbdbClient } from "./adsbdb/client.ts";
import { createEnrichment } from "./adsbdb/enrichment.ts";
import type { RouteInfo } from "./adsbdb/enrichment.ts";
import { createApp, selectFlights } from "./app.ts";
import type { AppOptions } from "./app.ts";
import { createPositionCache } from "./positionCache.ts";
import type { CachedPositions } from "./positionCache.ts";
import { UpstreamError } from "./providers/provider.ts";
import type { NearbyQuery, PositionFetchResult } from "./providers/provider.ts";
import { createTrackStore } from "./trackStore.ts";
import type { TrackedFlight } from "./trackStore.ts";

const T0 = Date.UTC(2026, 8, 15, 0, 0, 0);
const CENTER = { lat: 35.87, lon: 139.93 };
const NEARBY = "/api/nearby?lat=35.87&lon=139.93";

/** 検索中心から真北（負なら真南）に km 離れた地点。経線に沿う移動なので haversine の距離は km に一致する */
function offsetNorth(km: number): { lat: number; lon: number } {
  return { lat: CENTER.lat + (km / EARTH_RADIUS_KM) * (180 / Math.PI), lon: CENTER.lon };
}

/** `callsign` を明示的に undefined にするとコールサイン無しの機体になる（省略時は "ANA245"） */
type FlightOverrides = { km?: number; seenPosSec?: number; kind?: Flight["kind"]; callsign?: string | undefined };

function flight(hex: string, overrides: FlightOverrides = {}): Flight {
  const { lat, lon } = offsetNorth(overrides.km ?? 1);
  const callsign = "callsign" in overrides ? overrides.callsign : "ANA245";
  return {
    hex,
    ...(callsign === undefined ? {} : { callsign }),
    position: { lat, lon, altitudeBaroFt: 10000, onGround: false },
    isMlat: false,
    seenPosSec: overrides.seenPosSec ?? 1,
    kind: overrides.kind ?? "passenger",
    source: "adsblol",
  };
}

type Loader = (q: NearbyQuery) => Promise<PositionFetchResult>;

function returns(flights: Flight[], source: Flight["source"] = "adsblol"): Loader {
  return async () => ({ flights, source });
}

/** 呼び出し回数と受け取った検索条件を記録する偽の位置取得。`impl` は途中で差し替えられる */
function fakePositions(impl: Loader) {
  const fake = {
    calls: 0,
    queries: [] as NearbyQuery[],
    impl,
    fetchNearby(q: NearbyQuery): Promise<PositionFetchResult> {
      fake.calls += 1;
      fake.queries.push(q);
      return fake.impl(q);
    },
  };
  return fake;
}

type SetupOptions = Omit<AppOptions, "positions" | "now">;

/** `options` を関数で渡すと、偽時計の `now` を受け取って作れる（同じ時計の trackStore・enrichment を渡すため） */
function setup(impl: Loader, options: SetupOptions | ((now: () => number) => SetupOptions) = {}) {
  let time = T0;
  const now = () => time;
  const positions = fakePositions(impl);
  const app = createApp({ positions, now, ...(typeof options === "function" ? options(now) : options) });
  return {
    app,
    positions,
    advance(ms: number) {
      time += ms;
    },
    async get(path: string) {
      const res = await app.request(path);
      const body = (await res.json()) as Record<string, unknown>;
      return { res, body };
    },
  };
}

function hexes(body: Record<string, unknown>): string[] {
  return (body.flights as Flight[]).map((f) => f.hex);
}

function flightByHex(body: Record<string, unknown>, hex: string): Flight | undefined {
  return (body.flights as Flight[]).find((f) => f.hex === hex);
}

function expectApiError(body: Record<string, unknown>): void {
  expect(Object.keys(body)).toEqual(["error"]);
  expect(typeof body.error).toBe("string");
  expect((body.error as string).length).toBeGreaterThan(0);
}

describe("GET /api/nearby: パラメータ検証（AC-A2）", () => {
  it.each([
    ["lat 欠落", "/api/nearby?lon=139.93"],
    ["radiusKm=9（範囲外）", `${NEARBY}&radiusKm=9`],
    ["kinds=foo（未知の種類）", `${NEARBY}&kinds=foo`],
    ["lat が空値", "/api/nearby?lat=&lon=139.93"],
    ["kinds の空要素", `${NEARBY}&kinds=passenger,`],
    ["lat=abc（非数値）", "/api/nearby?lat=abc&lon=139.93"],
    ["radiusKm=1e1（指数表記）", `${NEARBY}&radiusKm=1e1`],
  ])("%s は 400 { error } で、位置を取得しない", async (_label, path) => {
    const t = setup(returns([flight("aaa111")]));
    const { res, body } = await t.get(path);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expectApiError(body);
    expect(t.positions.calls).toBe(0);
  });
});

describe("GET /api/nearby: 応答の形（AC-A10）", () => {
  it("200 で NearbyResponse を JSON で返す", async () => {
    const t = setup(returns([flight("aaa111", { km: 2, seenPosSec: 3 })], "adsbfi"));
    const { res, body } = await t.get(NEARBY);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(body).toEqual({
      updatedAt: new Date(T0).toISOString(),
      source: "adsbfi",
      flights: [flight("aaa111", { km: 2, seenPosSec: 3 })],
      airportOps: [],
    });
    expect(Object.keys(body).sort()).toEqual(["airportOps", "flights", "source", "updatedAt"]);
  });

  it("上流へは検索中心と海里に換算した半径を渡す（radiusKm 省略時 50km → 27nm）", async () => {
    const t = setup(returns([]));
    await t.get(NEARBY);
    expect(t.positions.queries).toEqual([{ lat: 35.87, lon: 139.93, radiusNm: 27 }]);
  });
});

describe("GET /api/nearby: 位置の鮮度（AC-A8）", () => {
  it("取得直後は seenPosSec 60 の機体を返し、60.001 の機体は返さない", async () => {
    const t = setup(returns([flight("aaa060", { seenPosSec: 60 }), flight("bbb061", { seenPosSec: 60.001 })]));
    const { res, body } = await t.get(NEARBY);
    expect(res.status).toBe(200);
    expect(hexes(body)).toEqual(["aaa060"]);
    expect(flightByHex(body, "aaa060")?.seenPosSec).toBe(60);
  });

  it("取得から 3 秒後の同キーはキャッシュから返し、経過秒を足した seenPosSec で判定して返す", async () => {
    const t = setup(
      returns([
        flight("aaa057", { km: 1, seenPosSec: 57 }),
        flight("bbb058", { km: 2, seenPosSec: 58 }),
        flight("ccc050", { km: 3, seenPosSec: 50 }),
      ]),
    );

    const first = await t.get(NEARBY);
    expect(hexes(first.body)).toEqual(["aaa057", "bbb058", "ccc050"]);
    expect(t.positions.calls).toBe(1);

    t.advance(3000);
    const second = await t.get(NEARBY);
    expect(second.res.status).toBe(200);
    expect(t.positions.calls).toBe(1);
    expect(second.body.updatedAt).toBe(new Date(T0).toISOString());
    expect(hexes(second.body)).toEqual(["aaa057", "ccc050"]);
    expect(flightByHex(second.body, "aaa057")?.seenPosSec).toBe(60);
    expect(flightByHex(second.body, "ccc050")?.seenPosSec).toBe(53);

    // キャッシュの値は書き換わっていない（書き換わっていれば 53 + 4 = 57 になる）
    t.advance(1000);
    const third = await t.get(NEARBY);
    expect(t.positions.calls).toBe(1);
    expect(flightByHex(third.body, "ccc050")?.seenPosSec).toBe(54);
  });

  it("取得後に時計が 1 秒戻っても、同キーはキャッシュから返し seenPosSec を減らさない", async () => {
    const t = setup(returns([flight("aaa111", { seenPosSec: 10 })]));
    const first = await t.get(NEARBY);
    expect(flightByHex(first.body, "aaa111")?.seenPosSec).toBe(10);

    t.advance(-1000);
    const second = await t.get(NEARBY);
    expect(second.res.status).toBe(200);
    expect(t.positions.calls).toBe(1);
    expect(flightByHex(second.body, "aaa111")?.seenPosSec).toBe(10);
  });
});

describe("GET /api/nearby: 種類（AC-A7 の kinds）", () => {
  const mixed = [
    flight("aaa111", { km: 1, kind: "passenger" }),
    flight("bbb222", { km: 2, kind: "cargo" }),
    flight("ccc333", { km: 3, kind: "other" }),
  ];

  it("kinds=cargo なら貨物機だけを返す", async () => {
    const t = setup(returns(mixed));
    const { body } = await t.get(`${NEARBY}&kinds=cargo`);
    expect(hexes(body)).toEqual(["bbb222"]);
  });

  it("kinds 省略時は passenger と cargo を返し、other は返さない", async () => {
    const t = setup(returns(mixed));
    const { body } = await t.get(NEARBY);
    expect(hexes(body)).toEqual(["aaa111", "bbb222"]);
  });
});

describe("GET /api/nearby: 半径と並び順（AC-A9）", () => {
  it("テスト用の地点は中心から指定の距離にある", () => {
    expect(haversineKm(CENTER, offsetNorth(10.1))).toBeCloseTo(10.1, 9);
    expect(haversineKm(CENTER, offsetNorth(-9.9))).toBeCloseTo(9.9, 9);
  });

  it("radiusKm=10 で中心から 10.1km の機体を除外し、9.9km の機体を返す", async () => {
    const t = setup(
      returns([
        flight("aaa101", { km: 10.1 }),
        flight("bbb099", { km: 9.9 }),
        flight("ccc101", { km: -10.1 }),
        flight("ddd099", { km: -9.9 }),
      ]),
    );
    const { body } = await t.get(`${NEARBY}&radiusKm=10`);
    expect(hexes(body).sort()).toEqual(["bbb099", "ddd099"]);
  });

  it("radiusKm 省略時（50km）は 50.1km の機体を除外し、49.9km の機体を返す", async () => {
    const t = setup(returns([flight("aaa501", { km: 50.1 }), flight("bbb499", { km: -49.9 })]));
    const { body } = await t.get(NEARBY);
    expect(hexes(body)).toEqual(["bbb499"]);
  });

  it("機体を水平距離の昇順に並べる", async () => {
    const t = setup(
      returns([
        flight("d30000", { km: 30 }),
        flight("b05000", { km: -5 }),
        flight("c12000", { km: 12 }),
        flight("a00500", { km: 0.5 }),
        flight("e20000", { km: -20.5 }),
      ]),
    );
    const { body } = await t.get(NEARBY);
    expect(hexes(body)).toEqual(["a00500", "b05000", "c12000", "e20000", "d30000"]);
  });
});

describe("GET /api/nearby: 位置の取得回数とキャッシュ（AC-A4・AC-A11）", () => {
  it("1 要求あたりの取得は 1 回以下で、同一キーは 5 秒以内ならキャッシュから返す", async () => {
    const t = setup(returns([flight("aaa111")]));
    const requests: [path: string, expectedCalls: number][] = [
      [NEARBY, 1],
      [NEARBY, 1],
      [`${NEARBY}&kinds=cargo`, 1], // kinds はキーに含まれない
      [`${NEARBY}&radiusKm=49.9`, 1], // 27nm で同じキー
      [`${NEARBY}&radiusKm=50.5`, 2], // 28nm で別のキー
      ["/api/nearby?lat=35.5&lon=139.93", 3], // 別の地点
    ];
    let previous = 0;
    for (const [path, expectedCalls] of requests) {
      const { res } = await t.get(path);
      expect(res.status).toBe(200);
      expect(t.positions.calls - previous).toBeLessThanOrEqual(1);
      expect(t.positions.calls).toBe(expectedCalls);
      previous = t.positions.calls;
    }

    t.advance(5000);
    await t.get(NEARBY);
    expect(t.positions.calls).toBe(4);
  });

  it("同一キーの同時要求は取得 1 回を共有する", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const t = setup(async () => {
      await gate;
      return { flights: [flight("aaa111")], source: "adsblol" };
    });

    const pending = [t.get(NEARBY), t.get(`${NEARBY}&kinds=passenger`)];
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    const results = await Promise.all(pending);

    expect(results.map((r) => r.res.status)).toEqual([200, 200]);
    expect(t.positions.calls).toBe(1);
  });
});

describe("createApp: onPositionsLoaded とキャッシュ", () => {
  it("キャッシュミスで取得に成功したときに 1 回呼び、5 秒以内の同キー（キャッシュヒット）では呼ばない", async () => {
    const loaded: CachedPositions[] = [];
    const t = setup(returns([flight("aaa111")], "adsbfi"), {
      onPositionsLoaded: (value) => {
        loaded.push(value);
      },
    });

    const first = await t.get(NEARBY);
    expect(first.res.status).toBe(200);
    expect(t.positions.calls).toBe(1);
    // createApp と同じ now で作ったキャッシュなので、fetchedAt は偽時計の時刻になる
    expect(loaded).toEqual([{ flights: [flight("aaa111")], source: "adsbfi", fetchedAt: T0 }]);

    t.advance(4999);
    const second = await t.get(NEARBY);
    expect(second.res.status).toBe(200);
    expect(t.positions.calls).toBe(1);
    expect(loaded).toHaveLength(1);

    t.advance(1); // 取得から 5 秒でキャッシュミス
    await t.get(NEARBY);
    expect(t.positions.calls).toBe(2);
    expect(loaded.map((v) => v.fetchedAt)).toEqual([T0, T0 + 5000]);
  });

  it("cache と onPositionsLoaded を同時に指定すると作成時に TypeError を投げる", () => {
    const positions = fakePositions(returns([]));
    const now = () => T0;
    const cache = createPositionCache({ now });
    expect(() => createApp({ positions, now, cache, onPositionsLoaded: () => undefined })).toThrow(TypeError);
    expect(() => createApp({ positions, now, cache })).not.toThrow();
    expect(() => createApp({ positions, now, onPositionsLoaded: () => undefined })).not.toThrow();
  });
});

describe("GET /api/nearby: 取得の失敗（AC-A10・AC-A11）", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("UpstreamError は 502 { error } で上流の詳細を含めず、失敗はキャッシュしない", async () => {
    const t = setup(async () => {
      throw new UpstreamError("adsblol: HTTP 503 https://api.adsb.lol/v2/point/35.87/139.93/27 <html>down</html>", {
        status: 503,
      });
    });

    const failed = await t.get(NEARBY);
    expect(failed.res.status).toBe(502);
    expect(failed.res.headers.get("content-type")).toMatch(/^application\/json/);
    expectApiError(failed.body);
    const message = failed.body.error as string;
    expect(message).not.toMatch(/adsb|https?:|503|html/i);
    expect(t.positions.calls).toBe(1);

    t.positions.impl = returns([flight("aaa111")], "opensky");
    const retried = await t.get(NEARBY);
    expect(t.positions.calls).toBe(2);
    expect(retried.res.status).toBe(200);
    expect(retried.body.source).toBe("opensky");
    expect(hexes(retried.body)).toEqual(["aaa111"]);
  });

  it("UpstreamError 以外の例外は 500 { error } で例外の中身を含めない", async () => {
    const t = setup(async () => {
      throw new Error("boom: secret detail");
    });

    const { res, body } = await t.get(NEARBY);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expectApiError(body);
    expect(body.error).not.toMatch(/boom|secret/);
  });
});

describe("未定義のパス（AC-A10）", () => {
  it.each(["/api/unknown", "/api", "/api/nearby/extra"])("%s は 404 { error }", async (path) => {
    const t = setup(returns([]));
    const { res, body } = await t.get(path);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expectApiError(body);
    expect(t.positions.calls).toBe(0);
  });
});

describe("selectFlights", () => {
  const options = {
    center: CENTER,
    radiusKm: 50,
    kinds: new Set<Flight["kind"]>(["passenger", "cargo"]),
  };

  it("入力の配列と各機体オブジェクトを書き換えない", () => {
    const input = [
      flight("c30000", { km: 30, seenPosSec: 10 }),
      flight("a01000", { km: 1, seenPosSec: 59 }), // 経過 5 秒で 64 → 除外
      flight("b05000", { km: -5, seenPosSec: 0, kind: "cargo" }),
      flight("d00000", { km: 2, kind: "other" }),
      flight("e99000", { km: 99 }),
    ];
    const before = structuredClone(input);

    const result = selectFlights(input, { ...options, ageSec: 5 });

    expect(input).toEqual(before);
    expect(result.map((f) => [f.hex, f.seenPosSec])).toEqual([
      ["b05000", 5],
      ["c30000", 15],
    ]);
    for (const selected of result) {
      expect(input).not.toContain(selected);
    }
  });

  it("同じ距離の機体は hex の昇順に並べる", () => {
    const input = [flight("bbb222", { km: 7 }), flight("aaa111", { km: 7 }), flight("ccc333", { km: 3 })];
    const result = selectFlights(input, { ...options, ageSec: 0 });
    expect(result.map((f) => f.hex)).toEqual(["ccc333", "aaa111", "bbb222"]);
  });

  it("seenPosSec が 60 ちょうどになる機体は返し、超える機体は返さない", () => {
    const input = [flight("aaa111", { seenPosSec: 55 }), flight("bbb222", { seenPosSec: 55.5 })];
    const result = selectFlights(input, { ...options, ageSec: 5 });
    expect(result.map((f) => [f.hex, f.seenPosSec])).toEqual([["aaa111", 60]]);
  });
});

// ---- W8: ルート情報の付与・航跡・詳細 API ----

const HND = {
  icao: "RJTT",
  iata: "HND",
  name: "Tokyo Haneda International Airport",
  municipality: "Tokyo",
  lat: 35.552299,
  lon: 139.779999,
};
const FUK = { icao: "RJFF", iata: "FUK", name: "Fukuoka Airport", municipality: "Fukuoka", lat: 33.585899, lon: 130.451004 };

const ANA245_ROUTE: RouteInfo = {
  airline: { icao: "ANA", iata: "NH", name: "All Nippon Airways" },
  route: { origin: HND, destination: FUK, source: "adsbdb" },
};

/** adsbdb の航空会社が null だった便（M2-1）。route だけを持つ */
const NCA001_ROUTE: RouteInfo = { route: { origin: FUK, destination: HND, source: "adsbdb" } };

const B789: AdsbdbAircraft = {
  model: "Boeing 787 9",
  photo: { url: "https://example.test/photo.jpg", thumbnailUrl: "https://example.test/thumb.jpg", credit: ADSBDB_PHOTO_CREDIT },
};

/** 呼び出しを記録する偽の enrichment。`routes`・`aircraftImpl`・`enqueueImpl` は途中で差し替えられる */
function fakeEnrichment(routes: Record<string, RouteInfo> = {}) {
  const fake = {
    routes: new Map<string, RouteInfo>(Object.entries(routes)),
    routeLookups: [] as string[],
    enqueued: [] as string[][],
    aircraftCalls: [] as string[],
    aircraftImpl: (_hex: string): Promise<AdsbdbAircraft | undefined> => Promise.resolve(undefined),
    enqueueImpl: (_callsigns: string[]): void => undefined,
    getRoute(callsign: string): RouteInfo | undefined {
      fake.routeLookups.push(callsign);
      return fake.routes.get(callsign);
    },
    enqueueRoutes(callsigns: Iterable<string>): void {
      const list = [...callsigns];
      fake.enqueued.push(list);
      fake.enqueueImpl(list);
    },
    getAircraft(hex: string): Promise<AdsbdbAircraft | undefined> {
      fake.aircraftCalls.push(hex);
      return fake.aircraftImpl(hex);
    },
  };
  return fake;
}

/** 呼び出しを記録する偽の tracks。`get` は `entries` から返す。`recordImpl` は途中で差し替えられる */
function fakeTracks(entries: Record<string, TrackedFlight> = {}) {
  const fake = {
    entries: new Map<string, TrackedFlight>(Object.entries(entries)),
    recorded: [] as { flights: Flight[]; fetchedAt: number }[],
    gets: [] as string[],
    recordImpl: (): void => undefined,
    record(flights: readonly Flight[], fetchedAt: number): void {
      fake.recorded.push({ flights: [...flights], fetchedAt });
      fake.recordImpl();
    },
    get(hex: string): TrackedFlight | undefined {
      fake.gets.push(hex);
      return fake.entries.get(hex);
    },
  };
  return fake;
}

/** `promise` が `ms` 以内に決着しなければ失敗する（待ってしまう実装を、テストの既定タイムアウトより早く検出する） */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${ms}ms 以内に応答しませんでした`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** 待っているマイクロタスクを流す */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 決して決着しない Promise */
function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** `flight()` の既定（高度 10000ft）で、中心から北に km の位置の航跡点 */
function trackPoint(km: number, atMs: number): TrackPoint {
  const { lat, lon } = offsetNorth(km);
  return { lat, lon, altitudeFt: 10000, at: iso(atMs) };
}

describe("GET /api/nearby: ルート情報の付与（AC-A13）", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("キャッシュ済みのルートを旅客機・貨物機のコピーに付け、未取得の旅客機・貨物機のコールサインだけを距離順に 1 回ずつ積む", async () => {
    const enrichment = fakeEnrichment({ ANA245: ANA245_ROUTE, NCA001: NCA001_ROUTE, JA123A: ANA245_ROUTE });
    const loaded = [
      flight("aaa111", { km: 1, callsign: "ANA245" }),
      flight("bbb222", { km: 2, kind: "cargo", callsign: "FDX5901" }),
      flight("ccc333", { km: 3, kind: "other", callsign: "JA123A" }), // ルートがキャッシュにあっても other には付けない
      flight("ddd444", { km: 4, callsign: undefined }),
      flight("eee555", { km: 5, callsign: "SKY001" }),
      flight("fff666", { km: 6, kind: "cargo", callsign: "NCA001" }),
      flight("ggg777", { km: 7, callsign: "FDX5901" }),
      flight("hhh888", { km: 8, kind: "other", callsign: "XYZ123" }),
    ];
    const t = setup(returns(loaded), { enrichment });

    const { res, body } = await t.get(`${NEARBY}&kinds=passenger,cargo,other`);

    expect(res.status).toBe(200);
    expect(body.flights).toEqual([
      { ...loaded[0], airline: ANA245_ROUTE.airline, route: ANA245_ROUTE.route },
      loaded[1],
      loaded[2],
      loaded[3],
      loaded[4],
      { ...loaded[5], route: NCA001_ROUTE.route },
      loaded[6],
      loaded[7],
    ]);
    expect(flightByHex(body, "fff666")).not.toHaveProperty("airline");
    expect(flightByHex(body, "ccc333")).not.toHaveProperty("route");
    expect(enrichment.enqueued).toEqual([["FDX5901", "SKY001"]]);
    expect([...new Set(enrichment.routeLookups)].sort()).toEqual(["ANA245", "FDX5901", "NCA001", "SKY001"]);
    expect(enrichment.aircraftCalls).toEqual([]);
  });

  it("初回はルートを付けずに積み、ルートがキャッシュに入った後の要求（位置はキャッシュヒット）で付ける。位置のキャッシュの値は書き換えない", async () => {
    const enrichment = fakeEnrichment();
    const t = setup(returns([flight("aaa111", { callsign: "ANA245" })]), { enrichment });

    const first = await t.get(NEARBY);
    expect(flightByHex(first.body, "aaa111")).not.toHaveProperty("route");
    expect(enrichment.enqueued).toEqual([["ANA245"]]);

    enrichment.routes.set("ANA245", ANA245_ROUTE);
    t.advance(3000);
    const second = await t.get(NEARBY);
    expect(t.positions.calls).toBe(1);
    expect(flightByHex(second.body, "aaa111")).toMatchObject({ airline: ANA245_ROUTE.airline, route: ANA245_ROUTE.route });
    // 全機のルートがあれば積まない
    expect(enrichment.enqueued).toEqual([["ANA245"]]);

    // 付けたルートがキャッシュの機体に残っていない
    enrichment.routes.delete("ANA245");
    t.advance(1000);
    const third = await t.get(NEARBY);
    expect(t.positions.calls).toBe(1);
    expect(flightByHex(third.body, "aaa111")).not.toHaveProperty("route");
    expect(flightByHex(third.body, "aaa111")).not.toHaveProperty("airline");
  });

  it("enqueueRoutes が同期で例外を投げても 200 で機体（キャッシュ済みのルート付き）を返し、エラーを console.error に出す", async () => {
    const enrichment = fakeEnrichment({ ANA245: ANA245_ROUTE });
    enrichment.enqueueImpl = () => {
      throw new Error("queue broken");
    };
    const t = setup(returns([flight("aaa111", { callsign: "ANA245" }), flight("bbb222", { km: 2, callsign: "JAL001" })]), {
      enrichment,
    });

    const { res, body } = await t.get(NEARBY);
    expect(res.status).toBe(200);
    expect(hexes(body)).toEqual(["aaa111", "bbb222"]);
    expect(flightByHex(body, "aaa111")?.route).toEqual(ANA245_ROUTE.route);
    expect(enrichment.enqueued).toEqual([["JAL001"]]);
    expect(consoleError).toHaveBeenCalled();
  });

  it("/api/nearby は getAircraft を呼ばず、未取得のコールサインを enqueueRoutes に 1 回渡す", async () => {
    const enrichment = fakeEnrichment();
    const pendingLookups: Promise<unknown>[] = [];
    enrichment.aircraftImpl = () => never();
    enrichment.enqueueImpl = (callsigns) => {
      pendingLookups.push(...callsigns.map(() => never()));
    };
    const t = setup(returns([flight("aaa111", { callsign: "ANA245" })]), { enrichment });

    const { res, body } = await within(t.get(NEARBY), 1000);
    expect(res.status).toBe(200);
    expect(hexes(body)).toEqual(["aaa111"]);
    expect(enrichment.enqueued).toEqual([["ANA245"]]);
    expect(pendingLookups).toHaveLength(1);
    expect(enrichment.aircraftCalls).toEqual([]);
  });

  it("本物の createEnrichment で adsbdb の照会が決着しないままでも応答し、照会はバックグラウンドで始まる", async () => {
    const routeLookups: string[] = [];
    const aircraftLookups: string[] = [];
    const client: AdsbdbClient = {
      lookupRoute(callsign) {
        routeLookups.push(callsign);
        return never();
      },
      lookupAircraft(hex) {
        aircraftLookups.push(hex);
        return never();
      },
    };
    const t = setup(returns([flight("aaa111", { callsign: "ANA245" }), flight("bbb222", { km: 2, callsign: "JAL001" })]), (now) => ({
      enrichment: createEnrichment({ client, now }),
    }));

    const first = await within(t.get(NEARBY), 1000);
    expect(first.res.status).toBe(200);
    expect(flightByHex(first.body, "aaa111")).not.toHaveProperty("route");
    await flush();
    // worker は 1 件ずつ照会するので、先頭の照会が決着しない間は 2 件目を始めない
    expect(routeLookups).toEqual(["ANA245"]);

    t.advance(1000);
    const second = await within(t.get(NEARBY), 1000);
    expect(second.res.status).toBe(200);
    await flush();
    expect(routeLookups).toEqual(["ANA245"]);
    expect(aircraftLookups).toEqual([]);
  });
});

describe("createApp: 航跡の記録（AC-A15・M-W5）", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("キャッシュミスで取得したときだけ、取得した全機体（絞り込み前）と fetchedAt を tracks.record に渡す", async () => {
    const tracks = fakeTracks();
    const loaded = [
      flight("aaa111", { km: 1 }),
      flight("bbb222", { km: 2, kind: "other" }),
      flight("ccc333", { km: 60 }), // 半径外
      flight("ddd444", { km: 3, seenPosSec: 61 }), // 60 秒超
    ];
    const t = setup(returns(loaded), { tracks });

    await t.get(`${NEARBY}&kinds=cargo`);
    expect(tracks.recorded).toEqual([{ flights: loaded, fetchedAt: T0 }]);

    t.advance(4999);
    await t.get(NEARBY);
    expect(t.positions.calls).toBe(1);
    expect(tracks.recorded).toHaveLength(1);

    t.advance(1);
    await t.get(NEARBY);
    expect(t.positions.calls).toBe(2);
    expect(tracks.recorded.map((r) => r.fetchedAt)).toEqual([T0, T0 + 5000]);
  });

  it("本物の trackStore では、キャッシュミスのたびに点が増え、キャッシュヒットでは増えない", async () => {
    let km = 1;
    const t = setup(
      async () => ({ flights: [flight("aaa111", { km: km++ })], source: "adsblol" }),
      (now) => ({ tracks: createTrackStore({ now }) }),
    );

    await t.get(NEARBY); // 取得 1 回目（km 1）
    t.advance(3000);
    await t.get(NEARBY); // キャッシュヒット
    const afterHit = await t.get("/api/flights/aaa111");
    expect(afterHit.body.track).toEqual([trackPoint(1, T0 - 1000)]);

    t.advance(2000);
    await t.get(NEARBY); // 取得 2 回目（km 2）
    const afterMiss = await t.get("/api/flights/aaa111");
    expect(t.positions.calls).toBe(2);
    expect(afterMiss.body.track).toEqual([trackPoint(1, T0 - 1000), trackPoint(2, T0 + 4000)]);
  });

  it("tracks と onPositionsLoaded を両方渡すと、航跡の記録 → onPositionsLoaded の順に 1 回ずつ呼ぶ", async () => {
    const calls: string[] = [];
    const tracks = fakeTracks();
    tracks.recordImpl = () => {
      calls.push("record");
    };
    const t = setup(returns([flight("aaa111")]), {
      tracks,
      onPositionsLoaded: () => {
        calls.push("onPositionsLoaded");
      },
    });

    await t.get(NEARBY);
    expect(calls).toEqual(["record", "onPositionsLoaded"]);
  });

  it("tracks.record が例外を投げても /api/nearby は 200 で機体を返し、エラーを console.error に出して onPositionsLoaded も呼ぶ", async () => {
    const tracks = fakeTracks();
    tracks.recordImpl = () => {
      throw new Error("record failed");
    };
    const loadedValues: CachedPositions[] = [];
    const t = setup(returns([flight("aaa111")]), {
      tracks,
      onPositionsLoaded: (value) => {
        loadedValues.push(value);
      },
    });

    const first = await t.get(NEARBY);
    expect(first.res.status).toBe(200);
    expect(hexes(first.body)).toEqual(["aaa111"]);
    expect(tracks.recorded).toHaveLength(1);
    expect(loadedValues).toHaveLength(1);
    expect(consoleError).toHaveBeenCalled();

    // 位置は保存されていて、次の要求はキャッシュから返る
    t.advance(1000);
    const second = await t.get(NEARBY);
    expect(second.res.status).toBe(200);
    expect(t.positions.calls).toBe(1);
  });

  it("tracks と cache を同時に指定すると作成時に TypeError を投げる", () => {
    const positions = fakePositions(returns([]));
    const now = () => T0;
    const cache = createPositionCache({ now });
    expect(() => createApp({ positions, now, cache, tracks: createTrackStore({ now }) })).toThrow(TypeError);
    expect(() => createApp({ positions, now, cache, enrichment: fakeEnrichment() })).not.toThrow();
    expect(() => createApp({ positions, now, tracks: createTrackStore({ now }) })).not.toThrow();
  });
});

describe("GET /api/flights/:hex（AC-A16）", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  /** 本物の trackStore と偽の enrichment で作り、`/api/nearby` を 1 回呼んで（時刻 T0）機体を記録した状態にする */
  async function setupDetail(loaded: Flight[], enrichment = fakeEnrichment({ ANA245: ANA245_ROUTE })) {
    const t = setup(returns(loaded), (now) => ({ tracks: createTrackStore({ now }), enrichment }));
    const nearby = await t.get(NEARBY);
    expect(nearby.res.status).toBe(200);
    return { ...t, enrichment };
  }

  it.each(["ABC", "zzzzzz", "1234567", "abc12", "~abc12", "abc123~", "~~abc123", "abc%20123", "abcdeg"])(
    "hex=%s は 400 { error } で、tracks を見ない",
    async (hex) => {
      const tracks = fakeTracks();
      const t = setup(returns([]), { tracks });
      const { res, body } = await t.get(`/api/flights/${hex}`);
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toMatch(/^application\/json/);
      expectApiError(body);
      expect(tracks.gets).toEqual([]);
    },
  );

  it.each([
    ["ABC123", "abc123"],
    ["AbC12f", "abc12f"],
    ["~ABC123", "~abc123"],
  ])("大文字を含む hex=%s は小文字化して受理する", async (requested, stored) => {
    const t = await setupDetail([flight(stored)]);
    const { res, body } = await t.get(`/api/flights/${requested}`);
    expect(res.status).toBe(200);
    expect((body.flight as Flight).hex).toBe(stored);
    expect(t.enrichment.aircraftCalls).toEqual([stored]);
  });

  it("200 で FlightDetailResponse（updatedAt・route と aircraft 付きの flight・古い順の track）を返す", async () => {
    const enrichment = fakeEnrichment({ ANA245: ANA245_ROUTE });
    enrichment.aircraftImpl = async () => B789;
    const t = await setupDetail([flight("abc123", { km: 2, seenPosSec: 3 })], enrichment);
    t.advance(5000);
    t.positions.impl = returns([flight("abc123", { km: 3, seenPosSec: 1 })]);
    await t.get(NEARBY); // 取得 2 回目（時刻 T0 + 5000）
    t.advance(2000);

    const { res, body } = await t.get("/api/flights/abc123");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(body).toEqual({
      updatedAt: iso(T0 + 5000),
      flight: {
        ...flight("abc123", { km: 3, seenPosSec: 3 }),
        airline: ANA245_ROUTE.airline,
        route: ANA245_ROUTE.route,
        aircraft: B789,
      },
      track: [trackPoint(2, T0 - 3000), trackPoint(3, T0 + 4000)],
    });
    expect(Object.keys(body).sort()).toEqual(["flight", "track", "updatedAt"]);
    expect((body.flight as Flight).aircraft?.photo?.credit).toBe(ADSBDB_PHOTO_CREDIT);
    expect(t.enrichment.aircraftCalls).toEqual(["abc123"]);
  });

  it("保持から 30 秒後の詳細では seenPosSec が保持時の値 +30 になり、保持している値は書き換えない（M2-3）", async () => {
    const t = await setupDetail([flight("abc123", { seenPosSec: 5 })]);

    t.advance(30_000);
    const first = await t.get("/api/flights/abc123");
    expect(first.res.status).toBe(200);
    expect((first.body.flight as Flight).seenPosSec).toBe(35);
    expect(first.body.updatedAt).toBe(iso(T0));

    t.advance(1000);
    const second = await t.get("/api/flights/abc123");
    expect((second.body.flight as Flight).seenPosSec).toBe(36);
  });

  it("seenPosSec が 60 ちょうどまでは 200、60 を超えた・保持から 61 秒経過は 404 { error }", async () => {
    const t = await setupDetail([flight("abc123", { seenPosSec: 0 })]);

    t.advance(60_000);
    const atLimit = await t.get("/api/flights/abc123");
    expect(atLimit.res.status).toBe(200);
    expect((atLimit.body.flight as Flight).seenPosSec).toBe(60);

    t.advance(1);
    const justOver = await t.get("/api/flights/abc123");
    expect(justOver.res.status).toBe(404);
    expectApiError(justOver.body);

    t.advance(999); // 保持から 61 秒
    const expired = await t.get("/api/flights/abc123");
    expect(expired.res.status).toBe(404);
    expect(expired.res.headers.get("content-type")).toMatch(/^application\/json/);
    expectApiError(expired.body);
  });

  it("機体情報を待つ間の経過も seenPosSec に含める（保持から 50 秒で要求し照会に 5 秒かかれば、保持時の値 +55）（M2-3）", async () => {
    const t = await setupDetail([flight("abc123", { seenPosSec: 2 })]);
    t.enrichment.aircraftImpl = async () => {
      await flush();
      t.advance(5000);
      return B789;
    };

    t.advance(50_000);
    const { res, body } = await t.get("/api/flights/abc123");
    expect(res.status).toBe(200);
    expect((body.flight as Flight).seenPosSec).toBe(2 + 55);
    expect((body.flight as Flight).aircraft).toEqual(B789);
    expect(body.updatedAt).toBe(iso(T0));
    expect(t.enrichment.aircraftCalls).toEqual(["abc123"]);
  });

  it("機体情報を待つ間に seenPosSec が 60 秒を超えたら 404 { error }（保持から 58 秒で要求し、照会に 5 秒かかる）", async () => {
    const t = await setupDetail([flight("abc123", { seenPosSec: 0 })]);
    t.enrichment.aircraftImpl = async () => {
      await flush();
      t.advance(5000);
      return B789;
    };

    t.advance(58_000);
    const { res, body } = await t.get("/api/flights/abc123");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expectApiError(body);
    expect(t.enrichment.aircraftCalls).toEqual(["abc123"]);
  });

  it("保持していない hex は 404 { error } で、機体情報を照会しない", async () => {
    const t = await setupDetail([flight("abc123")]);
    const { res, body } = await t.get("/api/flights/def456");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expectApiError(body);
    expect(t.enrichment.aircraftCalls).toEqual([]);
  });

  it("tracks を渡していなければ、位置を取得した機体でも 404 { error }", async () => {
    const enrichment = fakeEnrichment({ ANA245: ANA245_ROUTE });
    const t = setup(returns([flight("abc123")]), { enrichment });
    expect((await t.get(NEARBY)).res.status).toBe(200);

    const { res, body } = await t.get("/api/flights/abc123");
    expect(res.status).toBe(404);
    expectApiError(body);
    expect(enrichment.aircraftCalls).toEqual([]);
  });

  it("other の機体は 404 { error }（本物の trackStore は記録せず、tracks が返しても詳細は返さない）", async () => {
    const t = await setupDetail([flight("abc123", { kind: "other" })]);
    const notRecorded = await t.get("/api/flights/abc123");
    expect(notRecorded.res.status).toBe(404);
    expectApiError(notRecorded.body);

    const tracks = fakeTracks({ abc123: { flight: flight("abc123", { kind: "other" }), fetchedAt: T0, points: [] } });
    const enrichment = fakeEnrichment();
    const withFake = setup(returns([]), { tracks, enrichment });
    const held = await withFake.get("/api/flights/abc123");
    expect(tracks.gets).toEqual(["abc123"]);
    expect(held.res.status).toBe(404);
    expectApiError(held.body);
    expect(enrichment.aircraftCalls).toEqual([]);
  });

  it("ルートが未取得なら route・airline を付けずに返し、そのコールサインを積む", async () => {
    const t = await setupDetail([flight("abc123", { callsign: "JAL001" })], fakeEnrichment());
    t.enrichment.enqueued.length = 0; // /api/nearby で積んだ分を除く

    const { res, body } = await t.get("/api/flights/abc123");
    expect(res.status).toBe(200);
    expect(body.flight).not.toHaveProperty("route");
    expect(body.flight).not.toHaveProperty("airline");
    expect(t.enrichment.enqueued).toEqual([["JAL001"]]);
  });

  it("本物の createEnrichment で、ルート未取得の機体の詳細では lookupAircraft を lookupRoute より先に呼ぶ（AC-A14）", async () => {
    const lookups: string[] = [];
    const client: AdsbdbClient = {
      async lookupRoute(callsign) {
        lookups.push(`route:${callsign}`);
        return { status: "unknown" };
      },
      async lookupAircraft(hex) {
        lookups.push(`aircraft:${hex}`);
        return { status: "found", aircraft: B789 };
      },
    };
    const tracks = fakeTracks({ abc123: { flight: flight("abc123", { callsign: "JAL001" }), fetchedAt: T0, points: [] } });
    const t = setup(returns([]), (now) => ({ tracks, enrichment: createEnrichment({ client, now }) }));

    const { res, body } = await t.get("/api/flights/abc123");
    expect(res.status).toBe(200);
    expect((body.flight as Flight).aircraft).toEqual(B789);
    expect(body.flight).not.toHaveProperty("route");
    expect(lookups).toEqual(["aircraft:abc123", "route:JAL001"]);
  });

  it("getAircraft が undefined（未知・取得失敗）なら aircraft を付けずに 200", async () => {
    const t = await setupDetail([flight("abc123")]);
    const { res, body } = await t.get("/api/flights/abc123");
    expect(res.status).toBe(200);
    expect(body.flight).not.toHaveProperty("aircraft");
    expect((body.flight as Flight).route).toEqual(ANA245_ROUTE.route);
    expect(t.enrichment.aircraftCalls).toEqual(["abc123"]);
  });

  it.each<[string, () => Promise<AdsbdbAircraft | undefined>]>([
    ["reject する", () => Promise.reject(new Error("adsbdb down"))],
    [
      "同期で例外を投げる",
      () => {
        throw new Error("adsbdb broken");
      },
    ],
  ])("getAircraft が%s場合も aircraft を付けずに 200 で、console.error に出す", async (_label, impl) => {
    const enrichment = fakeEnrichment({ ANA245: ANA245_ROUTE });
    enrichment.aircraftImpl = impl;
    const t = await setupDetail([flight("abc123")], enrichment);

    const { res, body } = await t.get("/api/flights/abc123");
    expect(res.status).toBe(200);
    expect(body.flight).not.toHaveProperty("aircraft");
    expect((body.flight as Flight).route).toEqual(ANA245_ROUTE.route);
    expect(consoleError).toHaveBeenCalled();
  });

  it("enrichment を渡していなければ route・aircraft を付けずに 200", async () => {
    const t = setup(returns([flight("abc123", { seenPosSec: 2 })]), (now) => ({ tracks: createTrackStore({ now }) }));
    await t.get(NEARBY);

    const { res, body } = await t.get("/api/flights/abc123");
    expect(res.status).toBe(200);
    expect(body).toEqual({ updatedAt: iso(T0), flight: flight("abc123", { seenPosSec: 2 }), track: [trackPoint(1, T0 - 2000)] });
  });

  it("機体情報を待つ間に /api/nearby が同じ機体の新しい位置を記録したら、待った後に取り直した保持値で updatedAt・track・seenPosSec を決める（MINOR-1）", async () => {
    const enrichment = fakeEnrichment({ ANA245: ANA245_ROUTE });
    let resolveAircraft!: (value: AdsbdbAircraft | undefined) => void;
    enrichment.aircraftImpl = () =>
      new Promise<AdsbdbAircraft | undefined>((resolve) => {
        resolveAircraft = resolve;
      });
    const t = await setupDetail([flight("abc123", { km: 1, seenPosSec: 1 })], enrichment); // 取得 1 回目（時刻 T0）

    // T0 + 5000 に詳細を要求する（この時点の保持値は T0 の取得）。機体情報の照会を始めて待つ
    t.advance(5000);
    const detail = t.get("/api/flights/abc123");
    for (let i = 0; i < 10 && t.enrichment.aircraftCalls.length === 0; i++) await flush();
    expect(t.enrichment.aircraftCalls).toEqual(["abc123"]);

    // 照会が解決する前に、同じキーの /api/nearby がキャッシュミスして同じ機体の新しい位置を記録する（時刻 T0 + 5000）
    t.positions.impl = returns([flight("abc123", { km: 2, seenPosSec: 2 })]);
    expect((await t.get(NEARBY)).res.status).toBe(200);
    expect(t.positions.calls).toBe(2);

    t.advance(1000);
    resolveAircraft(B789);
    const { res, body } = await detail;
    expect(res.status).toBe(200);
    expect(body).toEqual({
      updatedAt: iso(T0 + 5000),
      flight: {
        // 新しい保持値 2 ＋ その取得からの 1 秒（待つ前の保持値のままなら 1 ＋ 6 = 7、位置も 1km のまま）
        ...flight("abc123", { km: 2, seenPosSec: 3 }),
        airline: ANA245_ROUTE.airline,
        route: ANA245_ROUTE.route,
        aircraft: B789,
      },
      track: [trackPoint(1, T0 - 1000), trackPoint(2, T0 + 3000)],
    });
  });

  it("機体情報を待つ間に保持している機体が無くなったら（取り直しが undefined）404 { error }（MINOR-1）", async () => {
    const enrichment = fakeEnrichment({ ANA245: ANA245_ROUTE });
    let resolveAircraft!: (value: AdsbdbAircraft | undefined) => void;
    enrichment.aircraftImpl = () =>
      new Promise<AdsbdbAircraft | undefined>((resolve) => {
        resolveAircraft = resolve;
      });
    const tracks = fakeTracks({ abc123: { flight: flight("abc123"), fetchedAt: T0, points: [] } });
    const t = setup(returns([]), { tracks, enrichment });

    const detail = t.get("/api/flights/abc123");
    for (let i = 0; i < 10 && enrichment.aircraftCalls.length === 0; i++) await flush();
    expect(enrichment.aircraftCalls).toEqual(["abc123"]);

    tracks.entries.delete("abc123");
    resolveAircraft(B789);
    const { res, body } = await detail;
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expectApiError(body);
    expect(tracks.gets).toEqual(["abc123", "abc123"]);
  });

  it.each(["/api/flights/abc123/extra", "/api/flights/", "/api/flights"])("%s は 404 { error }", async (path) => {
    const t = await setupDetail([flight("abc123")]);
    const { res, body } = await t.get(path);
    expect(res.status).toBe(404);
    expectApiError(body);
  });
});

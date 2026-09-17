import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EARTH_RADIUS_KM, destinationPoint, haversineKm } from "../shared/geo.ts";
import type { LatLon } from "../shared/geo.ts";
import type { Flight, TrackPoint } from "../shared/types.ts";
import type { AdsbdbAircraft, AdsbdbClient } from "./adsbdb/client.ts";
import { createEnrichment } from "./adsbdb/enrichment.ts";
import type { RouteInfo } from "./adsbdb/enrichment.ts";
import { AIRPORT_FETCH_RADIUS_NM, createAirportOpsSource } from "./airportOpsSource.ts";
import { createApp, selectFlights } from "./app.ts";
import type { AppOptions } from "./app.ts";
import { TARGET_AIRPORTS } from "./data/airports.ts";
import { RUNWAY_ENDS } from "./data/runways.ts";
import { runwayBearingDeg } from "./estimate/runway.ts";
import { createPositionCache } from "./positionCache.ts";
import type { CachedPositions } from "./positionCache.ts";
import { UpstreamError } from "./providers/provider.ts";
import type { NearbyQuery, PositionFetchResult, PositionSource } from "./providers/provider.ts";
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

/**
 * `options` を関数で渡すと、偽時計の `now` と偽の位置取得を受け取って作れる
 * （同じ時計の trackStore・enrichment や、同じ提供元を共有する airportOps を渡すため）
 */
function setup(impl: Loader, options: SetupOptions | ((now: () => number, positions: PositionSource) => SetupOptions) = {}) {
  let time = T0;
  const now = () => time;
  const positions = fakePositions(impl);
  const app = createApp({ positions, now, ...(typeof options === "function" ? options(now, positions) : options) });
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

/**
 * ルートの出発地・到着地が RJTT の機体に付く推定（W3 で `estimate` を無条件で付けた。AC-P2-40 / 54）。
 * `flight()` の機体は trackDeg・verticalRateFpm を持たないので幾何では決まらず、
 * 「滑走路が決まらない進入／出発・route の裏付けあり」の行（confidence 0.5）になる。
 * `distanceText` は機体から RJTT までの水平距離（検索中心から北に km 離すほど遠くなる）
 */
function hndRouteEstimate(phase: "departure" | "arrival", distanceText: string): NonNullable<Flight["estimate"]> {
  return {
    phase,
    confidence: 0.5,
    // evidence の空港名は shortName に統一されている（W9 MINOR-3）
    evidence: [`羽田まで ${distanceText}km`, `adsbdb: 羽田 ${phase === "departure" ? "発" : "着"}`],
    airport: { icao: "RJTT", name: "羽田" },
  };
}

const B789: AdsbdbAircraft = { model: "Boeing 787 9" };

/** planespotters が返す写真（撮影者名と写真ページのリンクが必須。仕様 §13） */
const PHOTO = {
  url: "https://t.plnspttrs.net/00142/1974079_280.jpg",
  thumbnailUrl: "https://t.plnspttrs.net/00142/1974079_t.jpg",
  credit: "Demo Borstell",
  link: "https://www.planespotters.net/photo/1974079/ja618a",
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

/**
 * 呼び出しを記録する偽の tracks。`get`・`points` は `entries` から返す。`recordImpl` は途中で差し替えられる。
 * `points` は保持している点をそのまま返す（`TrackPoint` は `lat`/`lon` を持つので推定にそのまま渡せる）
 */
function fakeTracks(entries: Record<string, TrackedFlight> = {}) {
  const fake = {
    entries: new Map<string, TrackedFlight>(Object.entries(entries)),
    recorded: [] as { flights: Flight[]; fetchedAt: number }[],
    gets: [] as string[],
    pointsLookups: [] as string[],
    recordImpl: (): void => undefined,
    record(flights: readonly Flight[], fetchedAt: number): void {
      fake.recorded.push({ flights: [...flights], fetchedAt });
      fake.recordImpl();
    },
    get(hex: string): TrackedFlight | undefined {
      fake.gets.push(hex);
      return fake.entries.get(hex);
    },
    points(hex: string): readonly LatLon[] {
      fake.pointsLookups.push(hex);
      return fake.entries.get(hex.toLowerCase())?.points ?? [];
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
      // RJTT 発着のルートが付いた機体には推定も付く（AC-P2-40）。ルートの無い機体には付かない
      { ...loaded[0], airline: ANA245_ROUTE.airline, route: ANA245_ROUTE.route, estimate: hndRouteEstimate("departure", "38.8") },
      loaded[1],
      loaded[2],
      loaded[3],
      loaded[4],
      { ...loaded[5], route: NCA001_ROUTE.route, estimate: hndRouteEstimate("arrival", "43.5") },
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
        estimate: hndRouteEstimate("departure", "40.6"), // AC-P2-54: 詳細にも推定が入る
        aircraft: B789,
      },
      track: [trackPoint(2, T0 - 3000), trackPoint(3, T0 + 4000)],
    });
    expect(Object.keys(body).sort()).toEqual(["flight", "track", "updatedAt"]);
    expect(t.enrichment.aircraftCalls).toEqual(["abc123"]);
  });

  it("写真の提供元があれば aircraft.photo に付ける（機体情報が無くても付く）", async () => {
    const calls: string[] = [];
    const photos = {
      getPhoto: (hex: string) => {
        calls.push(hex);
        return Promise.resolve(PHOTO);
      },
    };
    const t = setup(returns([flight("abc123")]), (now) => ({ tracks: createTrackStore({ now }), photos }));
    await t.get(NEARBY);

    const { res, body } = await t.get("/api/flights/abc123");
    expect(res.status).toBe(200);
    expect((body.flight as Flight).aircraft).toEqual({ photo: PHOTO });
    expect(calls).toEqual(["abc123"]);
  });

  it("写真の照会が失敗しても 200 で返し、写真を付けない", async () => {
    const photos = { getPhoto: () => Promise.reject(new Error("boom")) };
    const t = setup(returns([flight("abc123")]), (now) => ({ tracks: createTrackStore({ now }), photos }));
    await t.get(NEARBY);

    const { res, body } = await t.get("/api/flights/abc123");
    expect(res.status).toBe(200);
    expect((body.flight as Flight).aircraft).toBeUndefined();
  });

  it("機体情報と写真の両方があれば 1 つの aircraft にまとめる", async () => {
    const photos = { getPhoto: () => Promise.resolve(PHOTO) };
    const enrichment = fakeEnrichment({ ANA245: ANA245_ROUTE });
    enrichment.aircraftImpl = async () => B789;
    const t = setup(returns([flight("abc123")]), (now) => ({ tracks: createTrackStore({ now }), enrichment, photos }));
    await t.get(NEARBY);

    const { body } = await t.get("/api/flights/abc123");
    expect((body.flight as Flight).aircraft).toEqual({ ...B789, photo: PHOTO });
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
        estimate: hndRouteEstimate("departure", "39.7"), // 取り直した位置（2km）から RJTT までの距離
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

// ---- W3: 経路の推定の付与・運用方向・空港中心の取得 ----

const HANEDA = TARGET_AIRPORTS[0]!;

/**
 * RJTT 22 の進入側の延長線上 8km に機体を**合成**する（estimate.test.ts と同じ作り方。実測の生値ではない）。
 * 検索中心からは約 28.6km なので、既定の半径 50km の観測取得にも入る
 */
function arrivingFlight(hex: string): Flight {
  const end = RUNWAY_ENDS.find((other) => other.icao === "RJTT" && other.ident === "22")!;
  const bearing = runwayBearingDeg(end, RUNWAY_ENDS)!;
  const position = destinationPoint(end, bearing + 180, 8);
  return {
    hex,
    callsign: "JAL001",
    position: { lat: position.lat, lon: position.lon, altitudeBaroFt: 2000, onGround: false },
    trackDeg: ((bearing % 360) + 360) % 360,
    verticalRateFpm: -704,
    isMlat: false,
    seenPosSec: 1,
    kind: "passenger",
    source: "adsblol",
  };
}

/** 上の合成機体に付く推定（滑走路まで決まった進入） */
const ARRIVAL_ESTIMATE: NonNullable<Flight["estimate"]> = {
  phase: "arrival",
  airport: { icao: "RJTT", name: "羽田" },
  runway: "22",
  confidence: 0.9,
  evidence: ["方位のズレ 0.0°", "滑走路まで 8.0km", "降下中 -704fpm"],
};

/** 観測取得（半径 27NM）と空港中心の取得（半径 60NM）で別の応答を返す偽の位置取得 */
function byQuery(observed: Flight[], airport: (q: NearbyQuery) => Flight[]): Loader {
  return async (q) => ({
    flights: q.radiusNm === AIRPORT_FETCH_RADIUS_NM ? airport(q) : observed,
    source: "adsblol",
  });
}

describe("GET /api/nearby: 経路の推定の付与（AC-P2-40）", () => {
  it("推定が決まる機体にだけ estimate を付ける（airportOps を指定していなくても付く）", async () => {
    const t = setup(returns([arrivingFlight("abc123"), flight("ddd444", { km: 1, callsign: undefined })]));

    const { res, body } = await t.get(NEARBY);
    expect(res.status).toBe(200);
    expect(flightByHex(body, "abc123")?.estimate).toEqual(ARRIVAL_ESTIMATE);
    // 進行方向・昇降率が無い機体は phase が決まらないので推定を付けない
    expect(flightByHex(body, "ddd444")).not.toHaveProperty("estimate");
    // airportOps を渡していないので運用方向は空のまま
    expect(body.airportOps).toEqual([]);
  });

  it("位置のキャッシュに推定を書き戻さない（キャッシュヒットでも同じ推定を付ける）", async () => {
    const loaded = [arrivingFlight("abc123")];
    const t = setup(returns(loaded));

    await t.get(NEARBY);
    expect(loaded[0]).not.toHaveProperty("estimate");

    t.advance(3000);
    const cached = await t.get(NEARBY);
    expect(t.positions.calls).toBe(1);
    expect(flightByHex(cached.body, "abc123")?.estimate).toEqual(ARRIVAL_ESTIMATE);
  });
});

describe("GET /api/nearby: 運用方向（AC-P2-33・60〜62）", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  /** 本物の airportOpsSource を、アプリと同じ時計・同じ提供元インスタンスで配線する */
  function setupOps(impl: Loader) {
    return setup(impl, (now, positions) => ({ airportOps: createAirportOpsSource({ positions, now }) }));
  }

  it("推定が 1 件以上あれば airportOps が空でなくなる（AC-P2-33）", async () => {
    const t = setupOps(byQuery([arrivingFlight("abc123")], () => []));

    const { res, body } = await t.get(NEARBY);
    expect(res.status).toBe(200);
    expect(body.airportOps).toEqual([
      {
        icao: "RJTT",
        landingRunways: ["22"],
        departingRunways: [],
        configLabel: "南風運用",
        basedOn: 1,
        updatedAt: iso(T0),
      },
    ]);
  });

  it("観測点の応答に含まれず空港取得の応答にだけ含まれる機体も集計に使う（AC-P2-60）", async () => {
    const t = setupOps(byQuery([], (q) => (q.lat === HANEDA.lat ? [arrivingFlight("abc123")] : [])));

    const first = await t.get(NEARBY);
    expect(hexes(first.body)).toEqual([]); // 観測取得には含まれない
    expect(first.body.airportOps).toEqual([]); // 空港取得はまだ決着していない

    await flush();
    const second = await t.get(NEARBY); // 位置はキャッシュヒット（観測取得は増えない）
    expect(t.positions.queries.filter((q) => q.radiusNm !== AIRPORT_FETCH_RADIUS_NM)).toHaveLength(1);
    expect(hexes(second.body)).toEqual([]);
    expect(second.body.airportOps).toEqual([
      {
        icao: "RJTT",
        landingRunways: ["22"],
        departingRunways: [],
        configLabel: "南風運用",
        basedOn: 1,
        updatedAt: iso(T0),
      },
    ]);
  });

  it("空港取得で得た機体は航跡にも記録され、観測半径の外でも /api/flights/:hex で引ける（spec §7.3）", async () => {
    // アプリと同じ trackStore を空港中心の取得にも渡す
    const t = setup(
      byQuery([], (q) => (q.lat === HANEDA.lat ? [arrivingFlight("abc123")] : [])),
      (now, positions) => {
        const tracks = createTrackStore({ now });
        return { tracks, airportOps: createAirportOpsSource({ positions, now, tracks }) };
      },
    );

    const nearby = await t.get(NEARBY);
    expect(hexes(nearby.body)).toEqual([]); // 観測取得には含まれない

    await flush(); // 空港取得を決着させる
    const { res, body } = await t.get("/api/flights/abc123");
    expect(res.status).toBe(200);
    expect((body.flight as Flight).hex).toBe("abc123");
    expect((body.flight as Flight).estimate).toEqual(ARRIVAL_ESTIMATE);
  });

  it("1 回の /api/nearby で位置の上流へ出る取得は 2 本以下で、空港取得は応答を待たせない（AC-P2-61）", async () => {
    const t = setupOps(async (q) =>
      q.radiusNm === AIRPORT_FETCH_RADIUS_NM ? never() : { flights: [arrivingFlight("abc123")], source: "adsblol" },
    );

    // 空港取得が決着しなくても応答する
    const { res, body } = await within(t.get(NEARBY), 1000);
    expect(res.status).toBe(200);
    expect(hexes(body)).toEqual(["abc123"]);
    // 観測点 1 本 ＋ 空港 1 本
    expect(t.positions.queries.map((q) => q.radiusNm)).toEqual([27, AIRPORT_FETCH_RADIUS_NM]);
  });

  it("空港取得が失敗しても 200 で、airportOps は直前の集計値を保つ（AC-P2-62）", async () => {
    const t = setupOps(async (q) => {
      if (q.radiusNm === AIRPORT_FETCH_RADIUS_NM) throw new UpstreamError("airport: HTTP 502", { status: 502 });
      return { flights: [arrivingFlight("abc123")], source: "adsblol" };
    });

    const first = await t.get(NEARBY);
    expect(first.res.status).toBe(200);
    expect(first.body.airportOps).toHaveLength(1);

    await flush(); // 空港取得の失敗を決着させる
    const second = await t.get(NEARBY); // 位置はキャッシュヒット（時計は進めない）
    expect(second.res.status).toBe(200);
    expect(second.body.airportOps).toEqual(first.body.airportOps);
    expect(consoleError).toHaveBeenCalled();
  });

  it("airportOps と cache を同時に指定すると作成時に TypeError を投げる", () => {
    const positions = fakePositions(returns([]));
    const now = () => T0;
    const cache = createPositionCache({ now });
    const airportOps = createAirportOpsSource({ positions, now });
    expect(() => createApp({ positions, now, cache, airportOps })).toThrow(TypeError);
    expect(() => createApp({ positions, now, airportOps })).not.toThrow();
  });

  it("airportOps.record が例外を投げても 200 で機体を返し、エラーを console.error に出す", async () => {
    const airportOps = {
      current: () => [],
      record: () => {
        throw new Error("aggregate broken");
      },
      refresh: () => undefined,
    };
    const t = setup(returns([arrivingFlight("abc123")]), { airportOps });

    const { res, body } = await t.get(NEARBY);
    expect(res.status).toBe(200);
    expect(hexes(body)).toEqual(["abc123"]);
    expect(consoleError).toHaveBeenCalled();
  });

  it("airportOps.refresh・current が例外を投げても 200 で、airportOps は空配列にする", async () => {
    const airportOps = {
      current: (): never => {
        throw new Error("current broken");
      },
      record: () => undefined,
      refresh: (): never => {
        throw new Error("refresh broken");
      },
    };
    const t = setup(returns([arrivingFlight("abc123")]), { airportOps });

    const { res, body } = await t.get(NEARBY);
    expect(res.status).toBe(200);
    expect(body.airportOps).toEqual([]);
    expect(consoleError).toHaveBeenCalled();
  });
});


/**
 * W9 MAJOR-2: 同じ応答の中で `flights[].estimate`（route 付きで組み立てる）と `airportOps`（集計）が食い違わないこと。
 * `composeApp` と同じ配線（行の推定と集計の推定が**同じ `getRoute`** を見る）で確かめる。
 * AC-P2-16「幾何が裏を取れない機体には滑走路を当てない」は、行だけでなく集計にも効かなければならない
 * （`basedOn` が 1〜2 の時間帯は、この 1 機がヘッダーの運用方向を決める）
 */
describe("GET /api/nearby: 行の推定と運用方向の集計が同じ入力で決まる（AC-P2-16）", () => {
  /** 観測取得で `arrivingFlight`（幾何では RJTT 22 への進入）だけを返し、行と集計に同じルートのキャッシュを配る */
  function setupOpsWithRoutes(routes: Record<string, RouteInfo>) {
    const enrichment = fakeEnrichment(routes);
    const t = setup(
      byQuery([arrivingFlight("abc123")], () => []),
      (now, positions) => ({
        enrichment,
        airportOps: createAirportOpsSource({ positions, now, getRoute: (callsign) => enrichment.getRoute(callsign) }),
      }),
    );
    return { ...t, enrichment };
  }

  const HANEDA_LANDING_22 = {
    icao: "RJTT",
    landingRunways: ["22"],
    departingRunways: [],
    configLabel: "南風運用",
    basedOn: 1,
    updatedAt: iso(T0),
  };

  it("route が幾何と食い違う機体（adsbdb は羽田発・幾何は 22 へ進入）を、集計が着陸として数えない", async () => {
    const t = setupOpsWithRoutes({ JAL001: ANA245_ROUTE }); // RJTT → RJFF（「羽田発」）

    const { body } = await t.get(NEARBY);
    const estimate = flightByHex(body, "abc123")?.estimate;
    // 行は AC-P2-16 どおり「出発・滑走路なし」
    expect(estimate?.phase).toBe("departure");
    expect(estimate?.runway).toBeUndefined();
    // 同じ機体を集計が「RWY22 着陸」として数えない（数えるとヘッダーが「南風運用」になり、行と食い違う）
    expect(body.airportOps).toEqual([]);
  });

  it("route が幾何と一致する機体（adsbdb は羽田着）は、行と同じ滑走路で集計に入る", async () => {
    const t = setupOpsWithRoutes({ JAL001: NCA001_ROUTE }); // RJFF → RJTT（「羽田着」）

    const { body } = await t.get(NEARBY);
    const estimate = flightByHex(body, "abc123")?.estimate;
    expect(estimate?.phase).toBe("arrival");
    expect(estimate?.runway).toBe("22");
    expect(body.airportOps).toEqual([HANEDA_LANDING_22]);
  });

  /**
   * W10 MINOR-1: 機体が観測半径に入った時点ではルートがまだキャッシュに無い（起動直後・adsbdb の 429 休止中・
   * ルートの TTL 切れ直後）ことがある。そのとき幾何だけで記録した「RWY22 着陸」は、後から届いたルートが
   * 幾何と食い違ったら取り消す（残すと、行が「出発・滑走路なし」に変わった後も 10 分間「南風運用」が出続ける）
   */
  it("ルートが 2 回目の要求で届いて幾何と食い違ったら、1 回目に記録した集計を取り消す", async () => {
    const t = setupOpsWithRoutes({}); // 1 回目はルートがキャッシュに無い

    const first = await t.get(NEARBY);
    expect(flightByHex(first.body, "abc123")?.estimate).toEqual(ARRIVAL_ESTIMATE);
    expect(first.body.airportOps).toEqual([HANEDA_LANDING_22]);

    // adsbdb の応答（RJTT → RJFF＝「羽田発」）が届いた後、位置のキャッシュ（5 秒）を外して 2 回目
    t.enrichment.routes.set("JAL001", ANA245_ROUTE);
    t.advance(6000);
    const second = await t.get(NEARBY);
    const estimate = flightByHex(second.body, "abc123")?.estimate;
    expect(estimate?.phase).toBe("departure");
    expect(estimate?.runway).toBeUndefined();
    expect(second.body.airportOps).toEqual([]);

    // 3 回目（位置はキャッシュヒット）も空のまま（10 分窓が切れるのを待たない）
    t.advance(1000);
    const third = await t.get(NEARBY);
    expect(flightByHex(third.body, "abc123")?.estimate?.phase).toBe("departure");
    expect(third.body.airportOps).toEqual([]);
  });

  it("ルートがキャッシュに無ければ従来どおり幾何だけで数え、集計のために adsbdb への照会を増やさない", async () => {
    const t = setupOpsWithRoutes({});

    const { body } = await t.get(NEARBY);
    expect(flightByHex(body, "abc123")?.estimate?.runway).toBe("22");
    expect(body.airportOps).toEqual([HANEDA_LANDING_22]);
    // 積むのは `/api/nearby` の行の処理だけ（集計側はキャッシュを引くだけで積まない）
    expect(t.enrichment.enqueued).toEqual([["JAL001"]]);
  });
});

describe("GET /api/flights/:hex: 経路の推定（AC-P2-54）", () => {
  it("flight.estimate に evidence が入る（enrichment・photos が無くても付く）", async () => {
    const t = setup(returns([arrivingFlight("abc123")]), (now) => ({ tracks: createTrackStore({ now }) }));
    await t.get(NEARBY);

    const { res, body } = await t.get("/api/flights/abc123");
    expect(res.status).toBe(200);
    expect((body.flight as Flight).estimate).toEqual(ARRIVAL_ESTIMATE);
    expect((body.flight as Flight).estimate?.evidence).toEqual([
      "方位のズレ 0.0°",
      "滑走路まで 8.0km",
      "降下中 -704fpm",
    ]);
  });
});

/**
 * AC-P3-05 / 11 の配線: 推定に**保持している航跡**を渡す。
 * 並行滑走路（羽田 16L/16R）の出発は、現在位置だけでは L/R を決められない（`"16"` に落ちる）。
 * 航跡の最初の点（離陸直後＝滑走路端の近く・中心線上）が残っていれば `"16R"` まで決まる。
 *
 * 機体は RJTT 16R の離陸方向の延長線上に**合成**する（実測の生値ではない）。
 * 4.5km の点は対向端 34L の 1.4km 先（＝しきい値 3.0km の内側）、8.0km の点はその外側
 */
function departingFlight(hex: string, distanceKm: number): Flight {
  const end = RUNWAY_ENDS.find((other) => other.icao === "RJTT" && other.ident === "16R")!;
  const bearing = runwayBearingDeg(end, RUNWAY_ENDS)!;
  const position = destinationPoint(end, bearing, distanceKm);
  return {
    hex,
    callsign: "JAL001",
    position: { lat: position.lat, lon: position.lon, altitudeBaroFt: 2500, onGround: false },
    trackDeg: ((bearing % 360) + 360) % 360,
    verticalRateFpm: 1500,
    isMlat: false,
    seenPosSec: 1,
    kind: "passenger",
    source: "adsblol",
  };
}

/** 離陸直後（4.5km）→ 8km と 2 回取得する偽の位置取得。各取得の機体は 1 機だけ */
function departureSequence(): Loader {
  const positions = [4.5, 8];
  let index = 0;
  return async () => ({
    flights: [departingFlight("abc123", positions[Math.min(index++, positions.length - 1)]!)],
    source: "adsblol",
  });
}

describe("GET /api/nearby: 推定に航跡を渡す（AC-P3-05）", () => {
  it("航跡があれば並行滑走路の出発の L/R まで決まる（tracks を渡さなければ数字だけ）", async () => {
    const withTracks = setup(departureSequence(), (now) => ({ tracks: createTrackStore({ now }) }));
    const withoutTracks = setup(departureSequence());

    // 1 回目（離陸直後）の位置も 2 回目（8km）の位置も同じ機体。キャッシュ TTL を跨いで 2 回取得させる
    await withTracks.get(NEARBY);
    await withoutTracks.get(NEARBY);
    withTracks.advance(5000);
    withoutTracks.advance(5000);
    const held = await withTracks.get(NEARBY);
    const notHeld = await withoutTracks.get(NEARBY);

    expect(withTracks.positions.calls).toBe(2);
    const withTrack = flightByHex(held.body, "abc123")?.estimate;
    expect(withTrack?.runway).toBe("16R");
    expect(withTrack?.evidence).toContain("離陸直後 中心線から 0.0km");

    // 航跡を保持していないアプリでは、同じ観測でも L/R は決まらない
    const withoutTrack = flightByHex(notHeld.body, "abc123")?.estimate;
    expect(withoutTrack?.runway).toBe("16");
    expect(withoutTrack?.evidence).toContain("L/R は判別できず");
  });

  it("行ごとに tracks.points(hex) を引く", async () => {
    const tracks = fakeTracks();
    const t = setup(returns([departingFlight("abc123", 8), flight("ddd444")]), { tracks });

    await t.get(NEARBY);

    // 応答の行の並び（検索中心からの距離の昇順）で 1 機 1 回ずつ引く
    expect(tracks.pointsLookups).toEqual(["ddd444", "abc123"]);
  });
});

describe("GET /api/flights/:hex: 推定に航跡を渡す（AC-P3-05）", () => {
  it("保持している航跡が推定に効く（離陸直後の点があれば 16R、無ければ 16）", async () => {
    const t = setup(departureSequence(), (now) => ({ tracks: createTrackStore({ now }) }));

    await t.get(NEARBY); // 離陸直後（4.5km）
    t.advance(5000);
    await t.get(NEARBY); // 8km。航跡には 2 点が残っている

    const held = await t.get("/api/flights/abc123");
    expect((held.body.flight as Flight).estimate?.runway).toBe("16R");
    expect((held.body.flight as Flight).estimate?.evidence).toContain("離陸直後 中心線から 0.0km");

    // 対照: 8km の観測しか保持していなければ、同じ機体でも L/R は決まらない
    const late = setup(returns([departingFlight("abc123", 8)]), (now) => ({ tracks: createTrackStore({ now }) }));
    await late.get(NEARBY);
    const lateHeld = await late.get("/api/flights/abc123");
    expect((lateHeld.body.flight as Flight).estimate?.runway).toBe("16");
  });

  it("enrichment があるとき（本番で通る経路）も航跡が効く", async () => {
    // `composeApp` は常に `enrichment` と `photos` を渡すので、本番で通るのは
    // ルート・機体情報を待ってから推定を組み立てる方の経路（早期 return ではない方）。
    // 上のテストは enrichment を渡さないためそちらを通らないので、対照としてここで固定する
    const t = setup(departureSequence(), (now) => ({
      tracks: createTrackStore({ now }),
      enrichment: fakeEnrichment(),
    }));

    await t.get(NEARBY); // 離陸直後（4.5km）
    t.advance(5000);
    await t.get(NEARBY); // 8km

    const { body } = await t.get("/api/flights/abc123");
    expect((body.flight as Flight).estimate?.runway).toBe("16R");
    expect((body.flight as Flight).estimate?.evidence).toContain("離陸直後 中心線から 0.0km");
  });
});

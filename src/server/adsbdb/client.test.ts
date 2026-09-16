import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpstreamError, USER_AGENT } from "../providers/provider.ts";
import type { FetchLike } from "../providers/provider.ts";
import { createAdsbdbClient } from "./client.ts";
import type { AdsbdbClientOptions } from "./client.ts";

const T0 = Date.UTC(2026, 8, 15, 0, 0, 0);
const HOUR = 3_600_000;

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- 合成データ（adsbdb の応答の形に合わせたもの） ----

const HANEDA_RAW = {
  country_iso_name: "JP",
  country_name: "Japan",
  elevation: 35,
  iata_code: "HND",
  icao_code: "RJTT",
  latitude: 35.552299,
  longitude: 139.779999,
  municipality: "Tokyo",
  name: "Tokyo Haneda International Airport",
};

const ITAMI_RAW = {
  country_iso_name: "JP",
  country_name: "Japan",
  elevation: 39,
  iata_code: "ITM",
  icao_code: "RJOO",
  latitude: 34.785499,
  longitude: 135.438004,
  municipality: "Osaka",
  name: "Osaka International Airport",
};

function routeBody(flightroute: Record<string, unknown> = {}): unknown {
  return {
    response: {
      flightroute: {
        callsign: "ANA245",
        callsign_icao: "ANA245",
        callsign_iata: "NH245",
        airline: {
          name: "All Nippon Airways",
          icao: "ANA",
          iata: "NH",
          country: "Japan",
          country_iso: "JP",
          callsign: "ALL NIPPON",
        },
        origin: { ...HANEDA_RAW },
        destination: { ...ITAMI_RAW },
        ...flightroute,
      },
    },
  };
}

function aircraftBody(aircraft: Record<string, unknown> = {}): unknown {
  return {
    response: {
      aircraft: {
        type: "787 9",
        icao_type: "B789",
        manufacturer: "Boeing",
        mode_s: "869236",
        registration: "JA999Z",
        registered_owner_country_iso_name: "JP",
        registered_owner_country_name: "Japan",
        registered_owner_operator_flag_code: "ANA",
        registered_owner: "Synthetic Airways",
        url_photo: "https://image.airport-data.com/aircraft/000000001.jpg",
        url_photo_thumbnail: "https://image.airport-data.com/aircraft/thumbnails/000000001.jpg",
        ...aircraft,
      },
    },
  };
}

const EXPECTED_HANEDA = {
  icao: "RJTT",
  iata: "HND",
  name: "Tokyo Haneda International Airport",
  municipality: "Tokyo",
  lat: 35.552299,
  lon: 139.779999,
};

const EXPECTED_ITAMI = {
  icao: "RJOO",
  iata: "ITM",
  name: "Osaka International Airport",
  municipality: "Osaka",
  lat: 34.785499,
  lon: 135.438004,
};

// ---- 偽 fetch・偽時計・偽 sleep ----

type Call = { url: string; init: RequestInit; at: number };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * 呼び出しと開始時刻を記録する偽 fetch と、sleep で進む偽時計。
 * `sleepAdvance` で sleep が時計を進める量（既定は要求どおり）を変えられる（`index` は何回目の sleep か。0 始まり）
 */
function setup(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
  overrides: Partial<AdsbdbClientOptions> = {},
  fake: { sleepAdvance?: (ms: number, index: number) => number } = {},
) {
  let time = T0;
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init, at: time });
    return respond(url, init);
  };
  const client = createAdsbdbClient({
    fetch: fetchImpl,
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += fake.sleepAdvance?.(ms, sleeps.length - 1) ?? ms;
    },
    ...overrides,
  });
  return {
    client,
    calls,
    sleeps,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

/** 経路で応答を振り分ける（ルートは routeBody、機体は aircraftBody） */
function respondByPath(url: string): Response {
  return jsonResponse(new URL(url).pathname.startsWith("/v0/aircraft/") ? aircraftBody() : routeBody());
}

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function headerOf(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

function rateLimitedResponse(retryAfter?: string): Response {
  return new Response("slow down", { status: 429, headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter } });
}

/** 待っているマイクロタスクをすべて流す */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function expectRateLimitError(error: unknown, retryAfterSec: number): void {
  expect(error).toBeInstanceOf(UpstreamError);
  expect((error as UpstreamError).status).toBe(429);
  expect((error as UpstreamError).retryAfterSec).toBe(retryAfterSec);
}

describe("URL と User-Agent", () => {
  it("lookupRoute は /v0/callsign/{callsign} に User-Agent 付きで要求する", async () => {
    const s = setup(respondByPath);
    await s.client.lookupRoute("ANA245");
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.url).toBe("https://api.adsbdb.com/v0/callsign/ANA245");
    expect(headerOf(s.calls[0]!.init, "User-Agent")).toBe(USER_AGENT);
    // planespotters の規約に合わせ、連絡先の URL を含める（providers/provider.ts）
    expect(USER_AGENT).toBe("flightboard/0.1 (+https://github.com/kwanta08/flightboard)");
  });

  it("lookupAircraft は /v0/aircraft/{hex} に User-Agent 付きで要求する", async () => {
    const s = setup(respondByPath);
    await s.client.lookupAircraft("869236");
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.url).toBe("https://api.adsbdb.com/v0/aircraft/869236");
    expect(headerOf(s.calls[0]!.init, "User-Agent")).toBe(USER_AGENT);
  });

  it("パスの値は encodeURIComponent する", async () => {
    const s = setup(respondByPath);
    await s.client.lookupRoute("A/B C");
    await s.client.lookupAircraft("86?236");
    expect(s.calls.map((c) => c.url)).toEqual([
      "https://api.adsbdb.com/v0/callsign/A%2FB%20C",
      "https://api.adsbdb.com/v0/aircraft/86%3F236",
    ]);
  });

  it("baseUrl を注入できる（末尾の / は重ねない）", async () => {
    const s = setup(respondByPath, { baseUrl: "http://127.0.0.1:9999/" });
    await s.client.lookupRoute("ANA245");
    expect(s.calls[0]?.url).toBe("http://127.0.0.1:9999/v0/callsign/ANA245");
  });
});

describe("lookupRoute の 200 のパース", () => {
  it("ANA245 型: airline の 3 欄、origin・destination の各欄、source: adsbdb", async () => {
    const s = setup(() => jsonResponse(routeBody()));
    const result = await s.client.lookupRoute("ANA245");
    expect(result).toStrictEqual({
      status: "found",
      airline: { icao: "ANA", iata: "NH", name: "All Nippon Airways" },
      route: { origin: EXPECTED_HANEDA, destination: EXPECTED_ITAMI, source: "adsbdb" },
    });
  });

  it("airline: null → airline を付けず route だけで found", async () => {
    const s = setup(() => jsonResponse(routeBody({ airline: null })));
    const result = await s.client.lookupRoute("ANA245");
    expect(result).toStrictEqual({
      status: "found",
      route: { origin: EXPECTED_HANEDA, destination: EXPECTED_ITAMI, source: "adsbdb" },
    });
    expect("airline" in result).toBe(false);
  });

  it("airline 欄が無い → airline を付けず route だけで found", async () => {
    const body = routeBody() as { response: { flightroute: Record<string, unknown> } };
    delete body.response.flightroute.airline;
    const s = setup(() => jsonResponse(body));
    const result = await s.client.lookupRoute("ANA245");
    expect(result.status).toBe("found");
    expect("airline" in result).toBe(false);
  });

  it("airline の iata が空文字 → iata を付けない", async () => {
    const s = setup(() =>
      jsonResponse(routeBody({ airline: { name: "Synthetic Air", icao: "SYN", iata: "", country: "Japan" } })),
    );
    const result = await s.client.lookupRoute("SYN1");
    expect(result.status === "found" ? result.airline : undefined).toStrictEqual({ icao: "SYN", name: "Synthetic Air" });
  });

  it("midpoint（経由地）があっても結果に出ない", async () => {
    const midpoint = { ...HANEDA_RAW, icao_code: "RJFF", iata_code: "FUK", name: "Fukuoka Airport", municipality: "Fukuoka" };
    const s = setup(() => jsonResponse(routeBody({ midpoint })));
    const result = await s.client.lookupRoute("ANA245");
    expect(result).toStrictEqual({
      status: "found",
      airline: { icao: "ANA", iata: "NH", name: "All Nippon Airways" },
      route: { origin: EXPECTED_HANEDA, destination: EXPECTED_ITAMI, source: "adsbdb" },
    });
    expect(JSON.stringify(result)).not.toContain("RJFF");
  });

  it("iata_code・municipality が空文字、緯度・経度が数値でない空港 → その欄を付けない", async () => {
    const s = setup(() =>
      jsonResponse(
        routeBody({
          origin: { ...HANEDA_RAW, iata_code: "", municipality: "" },
          destination: { ...ITAMI_RAW, iata_code: null, latitude: null, longitude: "135.4" },
        }),
      ),
    );
    const result = await s.client.lookupRoute("ANA245");
    if (result.status !== "found") throw new Error("expected found");
    expect(result.route.origin).toStrictEqual({
      icao: "RJTT",
      name: "Tokyo Haneda International Airport",
      lat: 35.552299,
      lon: 139.779999,
    });
    expect(result.route.destination).toStrictEqual({
      icao: "RJOO",
      name: "Osaka International Airport",
      municipality: "Osaka",
    });
  });
});

describe("lookupAircraft の 200 のパース", () => {
  it("model は manufacturer と type を空白で連結する", async () => {
    const s = setup(() => jsonResponse(aircraftBody()));
    const result = await s.client.lookupAircraft("869236");
    expect(result).toStrictEqual({ status: "found", aircraft: { model: "Boeing 787 9" } });
  });

  it("写真は adsbdb から取らない（撮影者名を返さないため。写真は photos/planespotters.ts。仕様 §13）", async () => {
    const s = setup(() => jsonResponse(aircraftBody()));
    const result = await s.client.lookupAircraft("869236");
    if (result.status !== "found") throw new Error("expected found");
    expect("photo" in result.aircraft).toBe(false);
  });

  it.each<[string, Record<string, unknown>, { model?: string }]>([
    ["manufacturer だけ", { type: null }, { model: "Boeing" }],
    ["type だけ", { manufacturer: "" }, { model: "787 9" }],
    ["どちらも無い", { manufacturer: null, type: null, url_photo: null }, {}],
  ])("model: %s", async (_label, overrides, expected) => {
    const s = setup(() => jsonResponse(aircraftBody(overrides)));
    const result = await s.client.lookupAircraft("869236");
    if (result.status !== "found") throw new Error("expected found");
    expect({ model: result.aircraft.model }).toStrictEqual({ model: expected.model });
    expect("model" in result.aircraft).toBe("model" in expected);
  });
});

describe("unknown", () => {
  it("ルートの 404（response が文字列）→ unknown", async () => {
    const s = setup(() => jsonResponse({ response: "unknown callsign" }, 404));
    expect(await s.client.lookupRoute("XYZ999")).toStrictEqual({ status: "unknown" });
    expect(s.calls).toHaveLength(1);
  });

  it("機体の 404（response が文字列）→ unknown", async () => {
    const s = setup(() => jsonResponse({ response: "unknown aircraft" }, 404));
    expect(await s.client.lookupAircraft("abcdef")).toStrictEqual({ status: "unknown" });
    expect(s.calls).toHaveLength(1);
  });

  it("~ で始まる hex は要求 0 回で unknown（ゲートでも待たない）", async () => {
    const s = setup(respondByPath);
    expect(await s.client.lookupAircraft("~abc123")).toStrictEqual({ status: "unknown" });
    expect(s.calls).toHaveLength(0);
    expect(s.sleeps).toHaveLength(0);
  });
});

describe("失敗は UpstreamError", () => {
  const lookups = [
    ["lookupRoute", (client: ReturnType<typeof createAdsbdbClient>) => client.lookupRoute("ANA245")],
    ["lookupAircraft", (client: ReturnType<typeof createAdsbdbClient>) => client.lookupAircraft("869236")],
  ] as const;

  describe.each(lookups)("%s", (_name, lookup) => {
    it("HTTP 500 → status 500", async () => {
      const s = setup(() => new Response("down", { status: 500 }));
      const error = await catchError(lookup(s.client));
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).status).toBe(500);
    });

    it("HTTP 429 → status 429", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined); // レート制限のログを出力に出さない
      const s = setup(() => new Response("slow down", { status: 429, headers: { "Retry-After": "30" } }));
      const error = await catchError(lookup(s.client));
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).status).toBe(429);
    });

    it("ネットワークの失敗 → status 無し", async () => {
      const s = setup(() => Promise.reject(new TypeError("fetch failed")));
      const error = await catchError(lookup(s.client));
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).status).toBeUndefined();
    });

    it("タイムアウト → status 無し、fetch の signal が中断される", async () => {
      let signal: AbortSignal | undefined;
      const s = setup(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            signal = init.signal ?? undefined;
            signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
          }),
        { timeoutMs: 20 },
      );
      const error = await catchError(lookup(s.client));
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).status).toBeUndefined();
      expect((error as UpstreamError).message).toMatch(/timed out/);
      expect(signal?.aborted).toBe(true);
    });

    it("JSON 不正 → status 無し", async () => {
      const s = setup(() => new Response('{"response": {', { status: 200 }));
      const error = await catchError(lookup(s.client));
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).status).toBeUndefined();
    });

    it("200 で response が文字列 → 形の不正", async () => {
      const s = setup(() => jsonResponse({ response: "unknown callsign" }));
      const error = await catchError(lookup(s.client));
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).message).toMatch(/unexpected response shape/);
    });
  });

  it.each([
    ["flightroute が無い 200", { response: {} }],
    ["flightroute が null", { response: { flightroute: null } }],
    ["応答が配列", [routeBody()]],
    ["origin が無い", routeBody({ origin: undefined })],
    ["origin.icao_code が無い", routeBody({ origin: { ...HANEDA_RAW, icao_code: undefined } })],
    ["origin.icao_code が空文字", routeBody({ origin: { ...HANEDA_RAW, icao_code: "" } })],
    ["destination.name が無い", routeBody({ destination: { ...ITAMI_RAW, name: null } })],
  ])("lookupRoute の形の不正（%s）→ UpstreamError", async (_label, body) => {
    const s = setup(() => jsonResponse(body));
    const error = await catchError(s.client.lookupRoute("ANA245"));
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).status).toBeUndefined();
  });

  it.each([
    ["aircraft が無い 200", { response: {} }],
    ["aircraft が null", { response: { aircraft: null } }],
  ])("lookupAircraft の形の不正（%s）→ UpstreamError", async (_label, body) => {
    const s = setup(() => jsonResponse(body));
    const error = await catchError(s.client.lookupAircraft("869236"));
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).status).toBeUndefined();
  });
});

describe("既定のタイムアウトは 5000ms", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("timeoutMs 省略時、4999ms では未解決・5000ms で UpstreamError", async () => {
    vi.useFakeTimers();
    const s = setup(() => new Promise<Response>(() => undefined));

    let settled = false;
    const outcome = s.client.lookupRoute("ANA245").then(
      () => ({ error: undefined as unknown }),
      (error: unknown) => ({ error }),
    );
    void outcome.finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const { error } = await outcome;
    expect(settled).toBe(true);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).message).toMatch(/timed out after 5000ms/);
  });
});

describe("FIFO のゲート（AC-A14）", () => {
  function expectSpacedStarts(calls: Call[], minMs: number): void {
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i]!.at - calls[i - 1]!.at).toBeGreaterThanOrEqual(minMs);
    }
  }

  it("ルート 2・機体 1 を同時に呼ぶと、呼び出し順に開始し、開始時刻の間隔はすべて 120ms 以上", async () => {
    const s = setup(respondByPath);
    const results = await Promise.all([
      s.client.lookupRoute("ANA245"),
      s.client.lookupAircraft("869236"),
      s.client.lookupRoute("JAL123"),
    ]);

    expect(results.map((r) => r.status)).toEqual(["found", "found", "found"]);
    expect(s.calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/v0/callsign/ANA245",
      "/v0/aircraft/869236",
      "/v0/callsign/JAL123",
    ]);
    expectSpacedStarts(s.calls, 120);
    expect(s.sleeps).toEqual([120, 120]);
  });

  it("前の要求の完了を待ってから次を呼んでも、開始時刻の間隔は 120ms 以上", async () => {
    const s = setup(respondByPath);
    await s.client.lookupAircraft("869236");
    await s.client.lookupRoute("ANA245");
    await s.client.lookupRoute("JAL123");
    expect(s.calls).toHaveLength(3);
    expectSpacedStarts(s.calls, 120);
  });

  it("前の要求の開始から 200ms 経っていれば sleep しない", async () => {
    const s = setup(respondByPath);
    await s.client.lookupRoute("ANA245");
    s.advance(200);
    await s.client.lookupAircraft("869236");
    expect(s.sleeps).toEqual([]);
    expect(s.calls[1]!.at - s.calls[0]!.at).toBe(200);
  });

  it("前の要求の開始から 50ms なら残りの 70ms だけ sleep する", async () => {
    const s = setup(respondByPath);
    await s.client.lookupRoute("ANA245");
    s.advance(50);
    await s.client.lookupRoute("JAL123");
    expect(s.sleeps).toEqual([70]);
    expect(s.calls[1]!.at - s.calls[0]!.at).toBe(120);
  });

  it("失敗した要求も開始時刻として数え、後続の要求は進む", async () => {
    let n = 0;
    const s = setup((url) => (++n === 1 ? new Response("down", { status: 500 }) : respondByPath(url)));
    const [first, second] = await Promise.allSettled([s.client.lookupRoute("ANA245"), s.client.lookupRoute("JAL123")]);
    expect(first.status).toBe("rejected");
    expect(second.status).toBe("fulfilled");
    expect(s.calls).toHaveLength(2);
    expectSpacedStarts(s.calls, 120);
  });

  it("開始時刻で数える: 前の要求が応答待ちでも、開始から 120ms で次を開始する", async () => {
    let releaseFirst: ((res: Response) => void) | undefined;
    const s = setup((url) =>
      releaseFirst === undefined
        ? new Promise<Response>((resolve) => {
            releaseFirst = resolve;
          })
        : respondByPath(url),
    );
    const first = s.client.lookupRoute("ANA245");
    const second = await s.client.lookupAircraft("869236");

    expect(second.status).toBe("found");
    expect(s.calls.map((c) => new URL(c.url).pathname)).toEqual(["/v0/callsign/ANA245", "/v0/aircraft/869236"]);
    expect(s.calls[1]!.at - s.calls[0]!.at).toBe(120);

    releaseFirst?.(jsonResponse(routeBody()));
    expect((await first).status).toBe("found");
  });

  it("minIntervalMs を注入できる", async () => {
    const s = setup(respondByPath, { minIntervalMs: 500 });
    await Promise.all([s.client.lookupRoute("ANA245"), s.client.lookupRoute("JAL123")]);
    expect(s.sleeps).toEqual([500]);
    expectSpacedStarts(s.calls, 500);
  });

  it("前の要求の開始の後に時計が 1 時間戻っても、次の要求までの sleep の合計は 120ms 以下", async () => {
    const s = setup(respondByPath);
    await s.client.lookupRoute("ANA245");
    s.advance(-HOUR);
    await s.client.lookupRoute("JAL123");
    expect(s.calls).toHaveLength(2);
    expect(s.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(120);

    // 戻った時計での開始時刻から、以降は通常どおり間隔を空ける
    await s.client.lookupRoute("SKY1");
    expect(s.calls[2]!.at - s.calls[1]!.at).toBe(120);
  });

  it("sleep が要求より 1ms 少なく時計を進めても（最低 1ms は進む）、待ちを再計算して開始間隔は 120ms を割らない", async () => {
    const s = setup(respondByPath, {}, { sleepAdvance: (ms) => Math.max(ms - 1, 1) });
    await s.client.lookupRoute("ANA245");
    await s.client.lookupRoute("JAL123");
    expect(s.sleeps).toEqual([120, 1]);
    expect(s.calls[1]!.at - s.calls[0]!.at).toBe(120);
  });

  it("sleep が時計を進めなくても無限ループにならず、待ちを打ち切って開始する", async () => {
    const s = setup(respondByPath, {}, { sleepAdvance: () => 0 });
    await s.client.lookupRoute("ANA245");
    await s.client.lookupRoute("JAL123");
    expect(s.calls).toHaveLength(2);
    expect(s.sleeps).toEqual([120]);
  });
});

describe("HTTP 429 のレート制限（MAJOR-1）", () => {
  const LIMITED_30 = "[adsbdb] レート制限を受けました（30 秒間照会を止めます）";
  const RESUMED = "[adsbdb] レート制限が明けたので照会を再開します";

  function spyConsoleError() {
    return vi.spyOn(console, "error").mockImplementation(() => undefined);
  }

  let consoleError: ReturnType<typeof spyConsoleError>;
  beforeEach(() => {
    consoleError = spyConsoleError();
  });

  it("429（Retry-After: 30）の後、29,999ms まではルート・機体とも要求を送らず待たずに UpstreamError(429)、30,000ms で要求を送る", async () => {
    let limited = true;
    const s = setup((url) => (limited ? rateLimitedResponse("30") : respondByPath(url)));
    expectRateLimitError(await catchError(s.client.lookupRoute("ANA245")), 30);
    limited = false;

    s.advance(10_500);
    expectRateLimitError(await catchError(s.client.lookupRoute("JAL123")), 20); // 残り 19.5 秒を切り上げ
    s.advance(19_499);
    expectRateLimitError(await catchError(s.client.lookupRoute("JAL123")), 1);
    expectRateLimitError(await catchError(s.client.lookupAircraft("869236")), 1);
    // ~ で始まる hex は要求しないので制限と無関係に unknown
    expect(await s.client.lookupAircraft("~abc123")).toStrictEqual({ status: "unknown" });
    expect(s.calls).toHaveLength(1);
    expect(s.sleeps).toEqual([]);

    s.advance(1);
    expect((await s.client.lookupRoute("JAL123")).status).toBe("found");
    expect((await s.client.lookupAircraft("869236")).status).toBe("found");
    expect(s.calls.map((c) => c.at - T0)).toEqual([0, 30_000, 30_120]);
  });

  it.each<[string, string | undefined, number]>([
    ["Retry-After 無し → 60 秒", undefined, 60_000],
    ["Retry-After: 200000 → 86400 秒で頭打ち", "200000", 86_400_000],
  ])("制限の長さ: %s", async (_label, retryAfter, limitMs) => {
    let limited = true;
    const s = setup((url) => (limited ? rateLimitedResponse(retryAfter) : respondByPath(url)));
    await catchError(s.client.lookupRoute("ANA245"));
    limited = false;
    expectRateLimitError(await catchError(s.client.lookupRoute("ANA245")), limitMs / 1000);

    s.advance(limitMs - 1);
    expectRateLimitError(await catchError(s.client.lookupAircraft("869236")), 1);
    expect(s.calls).toHaveLength(1);

    s.advance(1);
    expect((await s.client.lookupAircraft("869236")).status).toBe("found");
    expect(s.calls).toHaveLength(2);
    expect(consoleError.mock.calls[0]).toEqual([`[adsbdb] レート制限を受けました（${limitMs / 1000} 秒間照会を止めます）`]);
  });

  it("制限中に拒否した要求はゲートの開始時刻を消費しない（明けた直後の要求は sleep しない）", async () => {
    let limited = true;
    const s = setup((url) => (limited ? rateLimitedResponse("30") : respondByPath(url)));
    await catchError(s.client.lookupRoute("ANA245"));
    limited = false;

    s.advance(29_950);
    expectRateLimitError(await catchError(s.client.lookupAircraft("869236")), 1);
    s.advance(50);
    expect((await s.client.lookupRoute("JAL123")).status).toBe("found");
    expect(s.sleeps).toEqual([]);
    expect(s.calls[1]!.at).toBe(T0 + 30_000);
  });

  it("ゲートで待っている間に 429 を受けた要求は送らず、開始時刻も消費しない", async () => {
    let time = T0;
    const calls: Call[] = [];
    const sleeps: number[] = [];
    let releaseFirst: ((res: Response) => void) | undefined;
    let releaseSleep: (() => void) | undefined;
    const client = createAdsbdbClient({
      fetch: async (url, init) => {
        calls.push({ url, init, at: time });
        if (calls.length > 1) return respondByPath(url);
        return new Promise<Response>((resolve) => {
          releaseFirst = resolve;
        });
      },
      now: () => time,
      sleep: (ms) => {
        sleeps.push(ms);
        // 1 回目の sleep だけは手で解決する（2 回目以降はすぐ時計を進めて戻る）
        if (sleeps.length > 1) {
          time += ms;
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          releaseSleep = resolve;
        });
      },
    });

    const first = catchError(client.lookupRoute("ANA245"));
    const second = catchError(client.lookupAircraft("869236"));
    await flush();
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([120]); // 2 件目はゲートで待っている

    releaseFirst?.(rateLimitedResponse("30"));
    expectRateLimitError(await first, 30);

    time = T0 + 29_950;
    releaseSleep?.();
    expectRateLimitError(await second, 1);
    expect(calls).toHaveLength(1);

    time = T0 + 30_000;
    expect((await client.lookupRoute("JAL123")).status).toBe("found");
    expect(sleeps).toEqual([120]);
    expect(calls.map((c) => c.at - T0)).toEqual([0, 30_000]);
  });

  it("ログは状態が変わったときだけ 1 行ずつ出す（制限を受けた・明けて最初の要求を送った）", async () => {
    let limited = true;
    let retryAfter: string | undefined = "30";
    const s = setup((url) => (limited ? rateLimitedResponse(retryAfter) : respondByPath(url)));

    await catchError(s.client.lookupRoute("ANA245"));
    await catchError(s.client.lookupRoute("JAL123"));
    await catchError(s.client.lookupAircraft("869236"));
    expect(consoleError.mock.calls).toEqual([[LIMITED_30]]);

    limited = false;
    s.advance(30_000);
    await s.client.lookupRoute("JAL123");
    await s.client.lookupAircraft("869236");
    expect(consoleError.mock.calls).toEqual([[LIMITED_30], [RESUMED]]);

    limited = true;
    retryAfter = undefined;
    s.advance(1000);
    await catchError(s.client.lookupRoute("SKY1"));
    await catchError(s.client.lookupRoute("SKY1"));
    expect(consoleError.mock.calls).toEqual([
      [LIMITED_30],
      [RESUMED],
      ["[adsbdb] レート制限を受けました（60 秒間照会を止めます）"],
    ]);
  });

  it("制限の前に送った要求の 429 が制限中に届いても、ログを重ねず、制限を短くしない", async () => {
    const releases: ((res: Response) => void)[] = [];
    const s = setup((url) =>
      releases.length < 2
        ? new Promise<Response>((resolve) => {
            releases.push(resolve);
          })
        : respondByPath(url),
    );
    const first = catchError(s.client.lookupRoute("ANA245"));
    const second = catchError(s.client.lookupAircraft("869236"));
    await flush();
    expect(s.calls.map((c) => c.at - T0)).toEqual([0, 120]); // どちらも応答待ち

    releases[0]!(rateLimitedResponse("30")); // T0+120 に受ける → T0+30,120 まで
    expectRateLimitError(await first, 30);
    releases[1]!(rateLimitedResponse("10")); // T0+10,120 までの制限では短くしない
    expectRateLimitError(await second, 10);
    expect(consoleError.mock.calls).toEqual([[LIMITED_30]]);

    s.advance(29_999);
    expectRateLimitError(await catchError(s.client.lookupRoute("JAL123")), 1);
    expect(s.calls).toHaveLength(2);
  });

  it("429（Retry-After: 0）は制限せず、ログも出さない（次の要求を止めず、開始・再開のログとも 0 行）", async () => {
    let limitedCount = 2;
    const s = setup((url) => (limitedCount-- > 0 ? rateLimitedResponse("0") : respondByPath(url)));

    expectRateLimitError(await catchError(s.client.lookupRoute("ANA245")), 0);
    expectRateLimitError(await catchError(s.client.lookupAircraft("869236")), 0);
    expect((await s.client.lookupRoute("JAL123")).status).toBe("found");
    expect((await s.client.lookupAircraft("869236")).status).toBe("found");

    // 時計はゲートの間隔の分しか進めていない（制限で拒否した要求は無い）
    expect(s.calls.map((c) => c.at - T0)).toEqual([0, 120, 240, 360]);
    expect(consoleError.mock.calls).toEqual([]);
  });

  it("制限（Retry-After: 1）が明けた後に、制限の前に送った要求の 429 が届いたら、再び制限してログを出す", async () => {
    const LIMITED_1 = "[adsbdb] レート制限を受けました（1 秒間照会を止めます）";
    const releases: ((res: Response) => void)[] = [];
    const s = setup((url) =>
      releases.length < 2
        ? new Promise<Response>((resolve) => {
            releases.push(resolve);
          })
        : respondByPath(url),
    );
    const first = catchError(s.client.lookupRoute("ANA245"));
    const second = catchError(s.client.lookupAircraft("869236"));
    await flush();
    expect(s.calls.map((c) => c.at - T0)).toEqual([0, 120]); // どちらも応答待ち

    releases[0]!(rateLimitedResponse("1")); // T0+120 に受ける → T0+1,120 まで
    expectRateLimitError(await first, 1);
    expect(consoleError.mock.calls).toEqual([[LIMITED_1]]);

    s.advance(1_000); // T0+1,120: 制限は明けたが、まだ要求は送っていない
    releases[1]!(rateLimitedResponse("1")); // → T0+2,120 まで
    expectRateLimitError(await second, 1);
    expect(consoleError.mock.calls).toEqual([[LIMITED_1], [LIMITED_1]]);

    s.advance(999);
    expectRateLimitError(await catchError(s.client.lookupRoute("JAL123")), 1);
    expect(s.calls).toHaveLength(2);

    s.advance(1);
    expect((await s.client.lookupRoute("JAL123")).status).toBe("found");
    expect(s.calls.map((c) => c.at - T0)).toEqual([0, 120, 2_120]);
    expect(consoleError.mock.calls).toEqual([[LIMITED_1], [LIMITED_1], [RESUMED]]);
  });
});

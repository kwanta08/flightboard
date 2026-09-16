import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Flight } from "../../shared/types.ts";
import { kmToUpstreamNm, parseRetryAfterSec, rateLimitWaitMs, UpstreamError, USER_AGENT } from "./provider.ts";
import type { FetchLike, NearbyQuery, PositionProvider } from "./provider.ts";
import { createAdsbFiProvider, createAdsbLolProvider, normalizeReadsbAircraft } from "./readsb.ts";
import type { ReadsbProviderOptions } from "./readsb.ts";

type RawAircraft = Record<string, unknown>;

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/readsb-sample.json", import.meta.url), "utf8"),
) as { ac: RawAircraft[] };

function raw(hex: string): RawAircraft {
  const found = fixture.ac.find((a) => a.hex === hex);
  if (found === undefined) throw new Error(`fixture has no ${hex}`);
  return found;
}

function without(record: RawAircraft, key: string): RawAircraft {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

const query: NearbyQuery = { lat: 35.87, lon: 139.93, radiusNm: kmToUpstreamNm(50) };

type Call = { url: string; init: RequestInit };

/** 呼び出しを記録し、固定の応答を返す偽 fetch */
function fakeFetch(respond: () => Response | Promise<Response>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return respond();
    },
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
  });
}

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

const providerFactories: [string, (options: ReadsbProviderOptions) => PositionProvider][] = [
  ["adsblol", createAdsbLolProvider],
  ["adsbfi", createAdsbFiProvider],
];

describe("kmToUpstreamNm", () => {
  it.each([
    [10, 6],
    [25, 14],
    [50, 27],
    [100, 54],
    [500, 250],
  ])("%d km → %d nm", (km, nm) => {
    expect(kmToUpstreamNm(km)).toBe(nm);
  });
});

describe("parseRetryAfterSec", () => {
  it("Retry-After: 120 → 120", () => {
    expect(parseRetryAfterSec(new Headers({ "Retry-After": "120" }))).toBe(120);
  });

  it("X-Rate-Limit-Retry-After-Seconds: 3600 → 3600", () => {
    expect(parseRetryAfterSec(new Headers({ "X-Rate-Limit-Retry-After-Seconds": "3600" }))).toBe(3600);
  });

  it("ヘッダー無し → undefined", () => {
    expect(parseRetryAfterSec(new Headers())).toBeUndefined();
  });

  it("Retry-After が HTTP-date → undefined", () => {
    expect(parseRetryAfterSec(new Headers({ "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }))).toBeUndefined();
  });

  it("10 進の非負整数でない値は採用しない", () => {
    for (const value of ["1.5", "-1", "1e3", "abc", "", "0x10"]) {
      expect(parseRetryAfterSec(new Headers({ "Retry-After": value }))).toBeUndefined();
    }
    expect(parseRetryAfterSec(new Headers({ "Retry-After": "0" }))).toBe(0);
  });

  it("両方あれば Retry-After を優先し、Retry-After が非数値なら次を見る", () => {
    expect(
      parseRetryAfterSec(new Headers({ "Retry-After": "30", "X-Rate-Limit-Retry-After-Seconds": "3600" })),
    ).toBe(30);
    expect(
      parseRetryAfterSec(
        new Headers({ "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT", "X-Rate-Limit-Retry-After-Seconds": "3600" }),
      ),
    ).toBe(3600);
  });
});

describe("rateLimitWaitMs（429 の待ち時間の共通算出）", () => {
  const options = { defaultMs: 60_000, maxMs: 86_400_000 };

  it.each<[string, number | undefined, number]>([
    ["有限の値 120 → 120 秒", 120, 120_000],
    ["小数 1.5 → 1.5 秒", 1.5, 1500],
    ["0 → 0（既定値にしない）", 0, 0],
    ["負 → 既定値", -1, 60_000],
    ["NaN → 既定値", Number.NaN, 60_000],
    ["Infinity → 既定値", Number.POSITIVE_INFINITY, 60_000],
    ["undefined → 既定値", undefined, 60_000],
    ["上限ちょうど 86400 → 86400 秒", 86_400, 86_400_000],
    ["上限超え 200000 → 上限で頭打ち", 200_000, 86_400_000],
  ])("%s", (_label, retryAfterSec, expected) => {
    expect(rateLimitWaitMs(retryAfterSec, options)).toBe(expected);
  });

  it("既定値も上限で頭打ち", () => {
    expect(rateLimitWaitMs(undefined, { defaultMs: 60_000, maxMs: 30_000 })).toBe(30_000);
    expect(rateLimitWaitMs(Number.NaN, { defaultMs: 60_000, maxMs: 30_000 })).toBe(30_000);
  });

  it("注入した既定値・上限を使う", () => {
    expect(rateLimitWaitMs(undefined, { defaultMs: 10_000, maxMs: 86_400_000 })).toBe(10_000);
    expect(rateLimitWaitMs(100, { defaultMs: 60_000, maxMs: 30_000 })).toBe(30_000);
  });
});

describe("上流 URL と User-Agent（AC-A3）", () => {
  it("adsb.lol は /v2/point/{lat}/{lon}/{nm}", async () => {
    const fake = fakeFetch(() => jsonResponse({ ac: [] }));
    const provider = createAdsbLolProvider({ fetch: fake.fetch });
    expect(provider.id).toBe("adsblol");

    await provider.fetchNearby(query);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url).toBe("https://api.adsb.lol/v2/point/35.87/139.93/27");
    expect(new Headers(fake.calls[0]!.init.headers).get("User-Agent")).toBe(USER_AGENT);
    expect(USER_AGENT).toBe("flightboard/0.1 (personal use)");
  });

  it("adsb.fi は v3 の /api/v3/lat/{lat}/lon/{lon}/dist/{nm}", async () => {
    const fake = fakeFetch(() => jsonResponse({ ac: [] }));
    const provider = createAdsbFiProvider({ fetch: fake.fetch });
    expect(provider.id).toBe("adsbfi");

    await provider.fetchNearby({ lat: -33.9, lon: 151.18, radiusNm: kmToUpstreamNm(100) });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url).toBe("https://opendata.adsb.fi/api/v3/lat/-33.9/lon/151.18/dist/54");
    expect(new Headers(fake.calls[0]!.init.headers).get("User-Agent")).toBe(USER_AGENT);
  });

  async function urlFor(create: (options: ReadsbProviderOptions) => PositionProvider, q: NearbyQuery): Promise<string> {
    const fake = fakeFetch(() => jsonResponse({ ac: [] }));
    await create({ fetch: fake.fetch }).fetchNearby(q);
    expect(fake.calls).toHaveLength(1);
    return fake.calls[0]!.url;
  }

  it("座標は小数 4 桁に丸めて埋め込み、指数表記にしない", async () => {
    const tiny = { lat: 0.0000001, lon: -0.0000001, radiusNm: 27 };
    const lolTiny = await urlFor(createAdsbLolProvider, tiny);
    expect(lolTiny).toBe("https://api.adsb.lol/v2/point/0/0/27");
    expect(lolTiny).not.toContain("e");
    const fiTiny = await urlFor(createAdsbFiProvider, tiny);
    expect(fiTiny).toBe("https://opendata.adsb.fi/api/v3/lat/0/lon/0/dist/27");
    expect(fiTiny.replace("opendata.adsb.fi", "")).not.toContain("e");

    const precise = { lat: 35.87654, lon: 139.93, radiusNm: 27 };
    expect(await urlFor(createAdsbLolProvider, precise)).toBe("https://api.adsb.lol/v2/point/35.8765/139.93/27");
    expect(await urlFor(createAdsbFiProvider, precise)).toBe(
      "https://opendata.adsb.fi/api/v3/lat/35.8765/lon/139.93/dist/27",
    );
  });
});

describe("フィクスチャの正規化（AC-A6・AC-A7）", () => {
  async function fetchFixture(source: "adsblol" | "adsbfi"): Promise<Flight[]> {
    const fake = fakeFetch(() => jsonResponse(fixture));
    const factory = source === "adsblol" ? createAdsbLolProvider : createAdsbFiProvider;
    return factory({ fetch: fake.fetch }).fetchNearby(query);
  }

  function byHex(flights: Flight[], hex: string): Flight {
    const found = flights.find((f) => f.hex === hex);
    if (found === undefined) throw new Error(`result has no ${hex}`);
    return found;
  }

  it("残る機体と捨てる機体（地上・dbFlags 1・位置欠落・seen_pos 欠落）", async () => {
    const flights = await fetchFixture("adsblol");
    expect(flights.map((f) => f.hex)).toEqual(["f0a001", "f0a002", "f0a005", "f0a006", "f0a007", "f0a010", "f0a011"]);
    expect(flights.every((f) => f.source === "adsblol")).toBe(true);
    expect(flights.some((f) => f.position.onGround)).toBe(false);
  });

  it("adsb.fi でも同じ機体が source adsbfi で残る", async () => {
    const flights = await fetchFixture("adsbfi");
    expect(flights.map((f) => f.hex)).toEqual(["f0a001", "f0a002", "f0a005", "f0a006", "f0a007", "f0a010", "f0a011"]);
    expect(flights.every((f) => f.source === "adsbfi")).toBe(true);
  });

  it("旅客機: 末尾空白のコールサインを trim、alt_baro・alt_geom 数値、baro_rate を採用", async () => {
    const flight = byHex(await fetchFixture("adsblol"), "f0a001");
    expect(flight).toStrictEqual({
      hex: "f0a001",
      callsign: "ANA245",
      registration: "JA-SYN01",
      typeCode: "B789",
      position: { lat: 35.812345, lon: 139.954321, altitudeBaroFt: 12000, altitudeGeomFt: 12450, onGround: false },
      groundSpeedKt: 320.5,
      trackDeg: 225.3,
      verticalRateFpm: -704,
      targetAltitudeFt: 8000,
      squawk: "2071",
      isMlat: false,
      seenPosSec: 0.4,
      kind: "passenger",
      source: "adsblol",
    } satisfies Flight);
  });

  it("貨物機: alt_geom 無し → altitudeGeomFt を含めない、baro_rate 欠落 → geom_rate を採用", async () => {
    const flight = byHex(await fetchFixture("adsblol"), "f0a002");
    expect(flight).toStrictEqual({
      hex: "f0a002",
      callsign: "FDX5901",
      registration: "N-SYN02",
      typeCode: "B77L",
      position: { lat: 35.95, lon: 140.1, altitudeBaroFt: 34000, onGround: false },
      groundSpeedKt: 480.2,
      trackDeg: 45,
      verticalRateFpm: 1024,
      squawk: "1234",
      isMlat: false,
      seenPosSec: 1.8,
      kind: "cargo",
      source: "adsblol",
    } satisfies Flight);
    expect("altitudeGeomFt" in flight.position).toBe(false);
    expect("targetAltitudeFt" in flight).toBe(false);
  });

  it("旅客・貨物がそれぞれ 1 機以上あり、airline / route / aircraft / estimate は付けない", async () => {
    const flights = await fetchFixture("adsblol");
    expect(flights.filter((f) => f.kind === "passenger").length).toBeGreaterThanOrEqual(1);
    expect(flights.filter((f) => f.kind === "cargo").length).toBeGreaterThanOrEqual(1);
    for (const flight of flights) {
      for (const key of ["airline", "route", "aircraft", "estimate"]) {
        expect(key in flight).toBe(false);
      }
    }
  });

  it('地上（alt_baro "ground"）は捨てる。同じ機体が数値高度なら残る', () => {
    const ground = raw("f0a003");
    expect(normalizeReadsbAircraft(ground, "adsblol")).toBeNull();

    const airborne = normalizeReadsbAircraft({ ...ground, alt_baro: 800 }, "adsblol");
    expect(airborne?.position.onGround).toBe(false);
    expect(airborne?.position.altitudeBaroFt).toBe(800);
    expect(airborne?.kind).toBe("passenger");
  });

  it("dbFlags 1（軍用）は捨てる。フラグが無ければ残る", () => {
    const military = raw("f0a004");
    expect(normalizeReadsbAircraft(military, "adsbfi")).toBeNull();
    expect(normalizeReadsbAircraft(without(military, "dbFlags"), "adsbfi")?.kind).toBe("passenger");
  });

  it("dbFlags 8（LADD）は残る。baro_rate 0 は geom_rate より優先、mlat 配列に lat が無ければ MLAT でない", async () => {
    const flight = byHex(await fetchFixture("adsblol"), "f0a005");
    expect(flight.kind).toBe("passenger");
    expect(flight.callsign).toBe("SKY711");
    expect(flight.verticalRateFpm).toBe(0);
    expect(flight.isMlat).toBe(false);
  });

  it('MLAT は type "mlat" と mlat 配列の "lat" の 2 通り', async () => {
    const flights = await fetchFixture("adsblol");
    expect(byHex(flights, "f0a006").isMlat).toBe(true);
    expect(byHex(flights, "f0a007").isMlat).toBe(true);
    expect(byHex(flights, "f0a001").isMlat).toBe(false);
  });

  it("位置欠落・seen_pos 欠落は捨てる", () => {
    expect(normalizeReadsbAircraft(raw("f0a008"), "adsblol")).toBeNull();
    expect(normalizeReadsbAircraft(raw("f0a009"), "adsblol")).toBeNull();
    // 対照: 欠けている欄を補えば残る
    expect(normalizeReadsbAircraft({ ...raw("f0a008"), lat: 35.7, lon: 139.7 }, "adsblol")).not.toBeNull();
    expect(normalizeReadsbAircraft({ ...raw("f0a009"), seen_pos: 1 }, "adsblol")).not.toBeNull();
  });

  it("コールサイン無し・空白だけのコールサインは callsign を含めず other として残る", async () => {
    const flights = await fetchFixture("adsblol");
    const noCallsign = byHex(flights, "f0a010");
    expect(noCallsign.kind).toBe("other");
    expect("callsign" in noCallsign).toBe(false);
    expect(noCallsign.position.altitudeGeomFt).toBe(3700);

    const blank = byHex(flights, "f0a011");
    expect(blank.kind).toBe("other");
    expect("callsign" in blank).toBe(false);
    expect("typeCode" in blank).toBe(false);
  });

  it("数値欄は有限の number のときだけ採用する", () => {
    const base = raw("f0a001");
    expect(normalizeReadsbAircraft({ ...base, lat: "35.8" }, "adsblol")).toBeNull();
    expect(normalizeReadsbAircraft({ ...base, lon: Number.NaN }, "adsblol")).toBeNull();
    expect(normalizeReadsbAircraft({ ...base, seen_pos: Number.POSITIVE_INFINITY }, "adsblol")).toBeNull();

    const loose = normalizeReadsbAircraft(
      { ...base, alt_baro: "unknown", alt_geom: "12450", gs: null, track: Number.NaN, baro_rate: "x", geom_rate: -300 },
      "adsblol",
    );
    expect(loose?.position.altitudeBaroFt).toBeNull();
    expect(loose?.position.onGround).toBe(false);
    expect(loose !== null && "altitudeGeomFt" in loose.position).toBe(false);
    expect(loose !== null && "groundSpeedKt" in loose).toBe(false);
    expect(loose !== null && "trackDeg" in loose).toBe(false);
    expect(loose?.verticalRateFpm).toBe(-300);
  });

  it("hex が文字列でない・機体がオブジェクトでないものは捨てる", () => {
    expect(normalizeReadsbAircraft({ ...raw("f0a001"), hex: 0xf0a001 }, "adsblol")).toBeNull();
    expect(normalizeReadsbAircraft(without(raw("f0a001"), "hex"), "adsblol")).toBeNull();
    expect(normalizeReadsbAircraft(null, "adsblol")).toBeNull();
    expect(normalizeReadsbAircraft("f0a001", "adsblol")).toBeNull();
    expect(normalizeReadsbAircraft([raw("f0a001")], "adsblol")).toBeNull();
  });

  it("hex が空文字（空白だけを含む）なら捨てる", () => {
    expect(normalizeReadsbAircraft({ ...raw("f0a001"), hex: "" }, "adsblol")).toBeNull();
    expect(normalizeReadsbAircraft({ ...raw("f0a001"), hex: "   " }, "adsbfi")).toBeNull();
    // 対照: 空でなければ残る
    expect(normalizeReadsbAircraft(raw("f0a001"), "adsblol")?.hex).toBe("f0a001");
  });

  it("負の seen_pos は seenPosSec 0 に丸めて残す", () => {
    const flight = normalizeReadsbAircraft({ ...raw("f0a001"), seen_pos: -3 }, "adsblol");
    expect(flight).not.toBeNull();
    expect(flight?.seenPosSec).toBe(0);
    expect(flight?.hex).toBe("f0a001");
    // 対照: 0 と正の値はそのまま
    expect(normalizeReadsbAircraft({ ...raw("f0a001"), seen_pos: 0 }, "adsblol")?.seenPosSec).toBe(0);
    expect(normalizeReadsbAircraft({ ...raw("f0a001"), seen_pos: 2.5 }, "adsblol")?.seenPosSec).toBe(2.5);
  });
});

describe("応答の配列キー", () => {
  it("ac が無く aircraft があればそれを読む", async () => {
    const fake = fakeFetch(() => jsonResponse({ aircraft: fixture.ac, now: 1789430400000 }));
    const flights = await createAdsbFiProvider({ fetch: fake.fetch }).fetchNearby(query);
    expect(flights.map((f) => f.hex)).toEqual(["f0a001", "f0a002", "f0a005", "f0a006", "f0a007", "f0a010", "f0a011"]);
  });

  it("ac と aircraft の両方があれば ac を読む", async () => {
    const fake = fakeFetch(() => jsonResponse({ ac: [raw("f0a002")], aircraft: fixture.ac }));
    const flights = await createAdsbLolProvider({ fetch: fake.fetch }).fetchNearby(query);
    expect(flights.map((f) => f.hex)).toEqual(["f0a002"]);
  });

  it("配列キーが無ければ 0 機", async () => {
    const fake = fakeFetch(() => jsonResponse({ msg: "No error", now: 1789430400000, total: 0 }));
    await expect(createAdsbLolProvider({ fetch: fake.fetch }).fetchNearby(query)).resolves.toEqual([]);
  });
});

describe.each(providerFactories)("失敗はすべて UpstreamError（%s）", (_id, create) => {
  it("fetch の例外（ネットワーク）→ status 無し", async () => {
    const cause = new TypeError("fetch failed");
    const provider = create({
      fetch: async () => {
        throw cause;
      },
    });
    const error = await catchError(provider.fetchNearby(query));
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).status).toBeUndefined();
    expect((error as UpstreamError).retryAfterSec).toBeUndefined();
    expect((error as UpstreamError).cause).toBe(cause);
  });

  it("HTTP 500 → status 500", async () => {
    const fake = fakeFetch(() => new Response("upstream down", { status: 500 }));
    const error = await catchError(create({ fetch: fake.fetch }).fetchNearby(query));
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).status).toBe(500);
    expect((error as UpstreamError).retryAfterSec).toBeUndefined();
  });

  it("タイムアウト → status 無し、fetch の signal が中断される", async () => {
    let signal: AbortSignal | undefined;
    const provider = create({
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init.signal ?? undefined;
          signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
        }),
    });
    const error = await catchError(provider.fetchNearby(query));
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).status).toBeUndefined();
    expect((error as UpstreamError).message).toMatch(/timed out/);
    expect(signal?.aborted).toBe(true);
  });

  it("タイムアウト → fetch が signal を無視しても打ち切る", async () => {
    const provider = create({ timeoutMs: 20, fetch: () => new Promise<Response>(() => undefined) });
    const error = await catchError(provider.fetchNearby(query));
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).status).toBeUndefined();
  });

  it("タイムアウト → 本文の読み取りが終わらなくても打ち切る", async () => {
    let signal: AbortSignal | undefined;
    const provider = create({
      timeoutMs: 20,
      fetch: async (_url, init) => {
        signal = init.signal ?? undefined;
        // 本文の先頭だけ届き、その後は閉じも失敗もしないストリーム
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"ac": ['));
          },
        });
        return new Response(body, { status: 200 });
      },
    });
    const error = await catchError(provider.fetchNearby(query));
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).status).toBeUndefined();
    expect((error as UpstreamError).message).toMatch(/timed out/);
    expect(signal?.aborted).toBe(true);
  });

  it("JSON 不正 → status 無し", async () => {
    const fake = fakeFetch(() => new Response('{"ac": [', { status: 200 }));
    const error = await catchError(create({ fetch: fake.fetch }).fetchNearby(query));
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).status).toBeUndefined();
  });

  it.each([
    ["ac がオブジェクト", { ac: {} }],
    ["ac が null", { ac: null }],
    ["ac が文字列", { ac: "none" }],
    ["aircraft が数値", { aircraft: 3 }],
    ["応答が配列", [raw("f0a001")]],
  ])("配列キーが配列以外（%s）→ status 無し", async (_label, body) => {
    const fake = fakeFetch(() => jsonResponse(body));
    const error = await catchError(create({ fetch: fake.fetch }).fetchNearby(query));
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).status).toBeUndefined();
  });
});

describe.each(providerFactories)("既定のタイムアウトは 5000ms（%s）", (_id, create) => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("timeoutMs 省略時、4999ms では未解決・5000ms で UpstreamError", async () => {
    vi.useFakeTimers();
    const provider = create({ fetch: () => new Promise<Response>(() => undefined) });

    let settled = false;
    const outcome = provider.fetchNearby(query).then(
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
    expect((error as UpstreamError).status).toBeUndefined();
    expect((error as UpstreamError).message).toMatch(/timed out after 5000ms/);
  });
});

describe("HTTP 429 の retryAfterSec（AC-A5）", () => {
  async function rateLimited(headers: Record<string, string>): Promise<UpstreamError> {
    const fake = fakeFetch(() => new Response("Too Many Requests", { status: 429, headers }));
    const error = await catchError(createAdsbFiProvider({ fetch: fake.fetch }).fetchNearby(query));
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).status).toBe(429);
    return error as UpstreamError;
  }

  it("Retry-After: 120 → 120", async () => {
    expect((await rateLimited({ "Retry-After": "120" })).retryAfterSec).toBe(120);
  });

  it("X-Rate-Limit-Retry-After-Seconds: 3600 → 3600", async () => {
    expect((await rateLimited({ "X-Rate-Limit-Retry-After-Seconds": "3600" })).retryAfterSec).toBe(3600);
  });

  it("ヘッダー無し → undefined", async () => {
    expect((await rateLimited({})).retryAfterSec).toBeUndefined();
  });

  it("Retry-After が HTTP-date → undefined", async () => {
    expect((await rateLimited({ "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" })).retryAfterSec).toBeUndefined();
  });

  it("429 以外の非 2xx ではヘッダーがあっても retryAfterSec を付けない", async () => {
    const fake = fakeFetch(() => new Response("", { status: 503, headers: { "Retry-After": "120" } }));
    const error = await catchError(createAdsbLolProvider({ fetch: fake.fetch }).fetchNearby(query));
    expect((error as UpstreamError).status).toBe(503);
    expect((error as UpstreamError).retryAfterSec).toBeUndefined();
  });
});

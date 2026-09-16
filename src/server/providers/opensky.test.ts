import { describe, expect, it } from "vitest";
import type { Flight } from "../../shared/types.ts";
import { EARTH_RADIUS_KM, haversineKm } from "../../shared/geo.ts";
import type { LatLon } from "../../shared/geo.ts";
import { UpstreamError, USER_AGENT } from "./provider.ts";
import type { FetchLike, NearbyQuery } from "./provider.ts";
import { createOpenSkyProvider, normalizeOpenSkyState, openSkyBoundingBox } from "./opensky.ts";
import type { OpenSkyBoundingBox } from "./opensky.ts";

const RESPONSE_TIME = 1789430400;

/** 合成の状態ベクトル（添字 0〜16）。hex は架空 */
function stateRow(overrides: Record<number, unknown> = {}): unknown[] {
  const row: unknown[] = [
    "f0b001", // 0 icao24
    "ANA245  ", // 1 callsign（末尾空白）
    "Japan", // 2 origin_country
    RESPONSE_TIME - 5, // 3 time_position
    RESPONSE_TIME - 1, // 4 last_contact
    139.954321, // 5 longitude
    35.812345, // 6 latitude
    1000, // 7 baro_altitude (m)
    false, // 8 on_ground
    100, // 9 velocity (m/s)
    225.3, // 10 true_track
    10, // 11 vertical_rate (m/s)
    null, // 12 sensors
    1100, // 13 geo_altitude (m)
    "2071", // 14 squawk
    false, // 15 spi
    0, // 16 position_source
  ];
  for (const [index, value] of Object.entries(overrides)) row[Number(index)] = value;
  return row;
}

const query: NearbyQuery = { lat: 35.87, lon: 139.93, radiusNm: 27 };

type Call = { url: string; init: RequestInit };

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

async function fetchStates(body: unknown): Promise<Flight[]> {
  const fake = fakeFetch(() => jsonResponse(body));
  return createOpenSkyProvider({ fetch: fake.fetch }).fetchNearby(query);
}

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

/** 球（R=6371km）上で、方位 bearingDeg に distanceKm 進んだ点 */
function destination(from: LatLon, bearingDeg: number, distanceKm: number): LatLon {
  const rad = Math.PI / 180;
  const phi1 = from.lat * rad;
  const lambda1 = from.lon * rad;
  const theta = bearingDeg * rad;
  const delta = distanceKm / EARTH_RADIUS_KM;
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
  const lambda2 =
    lambda1 +
    Math.atan2(Math.sin(theta) * Math.sin(delta) * Math.cos(phi1), Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2));
  return { lat: phi2 / rad, lon: lambda2 / rad };
}

function inside(box: OpenSkyBoundingBox, point: LatLon): boolean {
  return box.lamin <= point.lat && point.lat <= box.lamax && box.lomin <= point.lon && point.lon <= box.lomax;
}

describe("上流 URL と User-Agent（AC-A3）", () => {
  it("/api/states/all に lamin・lomin・lamax・lomax を付け、User-Agent を送る", async () => {
    const fake = fakeFetch(() => jsonResponse({ time: RESPONSE_TIME, states: [] }));
    const provider = createOpenSkyProvider({ fetch: fake.fetch });
    expect(provider.id).toBe("opensky");

    await provider.fetchNearby(query);

    expect(fake.calls).toHaveLength(1);
    const url = new URL(fake.calls[0]!.url);
    expect(url.origin).toBe("https://opensky-network.org");
    expect(url.pathname).toBe("/api/states/all");
    expect([...url.searchParams.keys()].sort()).toEqual(["lamax", "lamin", "lomax", "lomin"]);

    // 中心 35.87/139.93・27nm: r = 50.004km、δ = r/6371 = 0.00784869rad、dLat = δ = 0.449697°、
    // dLon = asin(sin δ / cos 35.87°) = 0.554945°（cos 35.87° = 0.810349）を小数 4 桁で外側へ丸めた値（手計算。実装からは導出しない）
    expect(url.searchParams.get("lamin")).toBe("35.4203");
    expect(url.searchParams.get("lamax")).toBe("36.3197");
    expect(url.searchParams.get("lomin")).toBe("139.375");
    expect(url.searchParams.get("lomax")).toBe("140.485");
    expect(new Headers(fake.calls[0]!.init.headers).get("User-Agent")).toBe(USER_AGENT);
  });
});

describe("矩形（半径 nm × 1.852 km の円を内包）", () => {
  const center: LatLon = { lat: query.lat, lon: query.lon };
  const radiusKm = query.radiusNm * 1.852;

  it("中心 35.87/139.93・27nm で、真北・真南・真東・真西へ半径ぶん進んだ点が矩形の内側", () => {
    const box = openSkyBoundingBox(query);
    for (const bearing of [0, 180, 90, 270]) {
      const point = destination(center, bearing, radiusKm);
      expect(haversineKm(center, point)).toBeCloseTo(radiusKm, 6);
      expect(inside(box, point), `bearing ${bearing}: ${JSON.stringify(point)} in ${JSON.stringify(box)}`).toBe(true);
    }
  });

  it("矩形は円に対して過大でない（各辺まで半径 + 0.1km 以内）", () => {
    const box = openSkyBoundingBox(query);
    expect(haversineKm(center, { lat: box.lamax, lon: center.lon })).toBeLessThan(radiusKm + 0.1);
    expect(haversineKm(center, { lat: box.lamin, lon: center.lon })).toBeLessThan(radiusKm + 0.1);
    // 東西の辺は中心緯度で測る
    expect(haversineKm(center, { lat: center.lat, lon: box.lomax })).toBeLessThan(radiusKm + 0.1);
    expect(haversineKm(center, { lat: center.lat, lon: box.lomin })).toBeLessThan(radiusKm + 0.1);
  });

  it("北極付近（中心 89.5）で lamax が 90、lomin/lomax が ±180 に丸まる", () => {
    const box = openSkyBoundingBox({ lat: 89.5, lon: 139.93, radiusNm: 250 });
    expect(box.lamax).toBe(90);
    expect(box.lamin).toBeLessThan(89.5);
    expect(box.lomin).toBe(-180);
    expect(box.lomax).toBe(180);
  });

  it("南極付近（中心 -89.5）で lamin が -90 に丸まる", () => {
    const box = openSkyBoundingBox({ lat: -89.5, lon: -45, radiusNm: 250 });
    expect(box.lamin).toBe(-90);
    expect(box.lamax).toBeGreaterThan(-89.5);
    expect(box.lomin).toBe(-180);
    expect(box.lomax).toBe(180);
  });

  // 円周上の点は矩形の式とは独立に、球面の destination 公式で求める
  it.each([
    { label: "(a) 中心 35.87/139.93・27nm", lat: 35.87, lon: 139.93, radiusNm: 27 },
    { label: "(b) 中心 60/10・250nm", lat: 60, lon: 10, radiusNm: 250 },
    { label: "(c) 中心 -45/170・100nm", lat: -45, lon: 170, radiusNm: 100 },
  ])("$label: 方位 0°〜359°（1° 刻み）へ半径ぶん進んだ 360 点がすべて矩形の内側", ({ lat, lon, radiusNm }) => {
    const box = openSkyBoundingBox({ lat, lon, radiusNm });
    const from: LatLon = { lat, lon };
    const distanceKm = radiusNm * 1.852;

    let checked = 0;
    const outside: string[] = [];
    for (let bearing = 0; bearing < 360; bearing += 1) {
      const point = destination(from, bearing, distanceKm);
      checked += 1;
      if (!inside(box, point)) outside.push(`bearing ${bearing}: ${JSON.stringify(point)}`);
    }

    expect(checked).toBe(360);
    expect(outside, `box ${JSON.stringify(box)}`).toEqual([]);
  });
});

describe("状態ベクトルの正規化（AC-A6）", () => {
  it("単位換算・コールサインの trim・seenPosSec・含めない欄", async () => {
    const flights = await fetchStates({ time: RESPONSE_TIME, states: [stateRow()] });
    expect(flights).toHaveLength(1);
    const flight = flights[0]!;

    expect(flight.hex).toBe("f0b001");
    expect(flight.callsign).toBe("ANA245");
    expect(flight.position.lat).toBe(35.812345);
    expect(flight.position.lon).toBe(139.954321);
    expect(flight.position.onGround).toBe(false);
    expect(flight.position.altitudeBaroFt).toBeCloseTo(3280.84, 2); // 1000m
    expect(flight.position.altitudeGeomFt).toBeCloseTo(3608.92, 2); // 1100m
    expect(flight.groundSpeedKt).toBeCloseTo(194.38, 2); // 100m/s
    expect(flight.trackDeg).toBe(225.3);
    expect(flight.verticalRateFpm).toBeCloseTo(1968.5, 2); // 10m/s
    expect(flight.squawk).toBe("2071");
    expect(flight.isMlat).toBe(false);
    expect(flight.seenPosSec).toBe(5);
    expect(flight.kind).toBe("passenger");
    expect(flight.source).toBe("opensky");

    for (const key of ["registration", "typeCode", "targetAltitudeFt", "airline", "route", "aircraft", "estimate"]) {
      expect(key in flight, key).toBe(false);
    }
    expect(Object.keys(flight.position).sort()).toEqual(["altitudeBaroFt", "altitudeGeomFt", "lat", "lon", "onGround"]);
  });

  it("seenPosSec は 応答 time − time_position、負なら 0", () => {
    expect(normalizeOpenSkyState(stateRow({ 3: RESPONSE_TIME - 12 }), RESPONSE_TIME)?.seenPosSec).toBe(12);
    expect(normalizeOpenSkyState(stateRow({ 3: RESPONSE_TIME }), RESPONSE_TIME)?.seenPosSec).toBe(0);
    expect(normalizeOpenSkyState(stateRow({ 3: RESPONSE_TIME + 3 }), RESPONSE_TIME)?.seenPosSec).toBe(0);
  });

  it("position_source 2 → isMlat true、0・1 → false", () => {
    expect(normalizeOpenSkyState(stateRow({ 16: 2 }), RESPONSE_TIME)?.isMlat).toBe(true);
    expect(normalizeOpenSkyState(stateRow({ 16: 0 }), RESPONSE_TIME)?.isMlat).toBe(false);
    expect(normalizeOpenSkyState(stateRow({ 16: 1 }), RESPONSE_TIME)?.isMlat).toBe(false);
  });

  it("time_position null・位置 null・地上（on_ground true）の機体を捨てる", async () => {
    const flights = await fetchStates({
      time: RESPONSE_TIME,
      states: [
        stateRow({ 0: "f0b010", 3: null }),
        stateRow({ 0: "f0b011", 5: null, 6: null }),
        stateRow({ 0: "f0b012", 6: null }),
        stateRow({ 0: "f0b013", 5: null }),
        stateRow({ 0: "f0b014", 8: true }),
        stateRow({ 0: "f0b015" }),
      ],
    });
    expect(flights.map((f) => f.hex)).toEqual(["f0b015"]);
  });

  it("位置・time_position が有限の数値でなければ捨てる", () => {
    expect(normalizeOpenSkyState(stateRow({ 6: "35.8" }), RESPONSE_TIME)).toBeNull();
    expect(normalizeOpenSkyState(stateRow({ 5: Number.NaN }), RESPONSE_TIME)).toBeNull();
    expect(normalizeOpenSkyState(stateRow({ 3: "1789430395" }), RESPONSE_TIME)).toBeNull();
  });

  it("高度・速度などが null なら altitudeBaroFt は null、他の欄は含めない", () => {
    const flight = normalizeOpenSkyState(
      stateRow({ 7: null, 9: null, 10: null, 11: null, 13: null, 14: null }),
      RESPONSE_TIME,
    );
    expect(flight).not.toBeNull();
    expect(flight!.position.altitudeBaroFt).toBeNull();
    for (const key of ["groundSpeedKt", "trackDeg", "verticalRateFpm", "squawk"]) {
      expect(key in flight!, key).toBe(false);
    }
    expect("altitudeGeomFt" in flight!.position).toBe(false);
  });

  it("コールサイン無し・空白だけのコールサインは callsign を含めず other として残る", () => {
    const blank = normalizeOpenSkyState(stateRow({ 1: "        " }), RESPONSE_TIME);
    expect(blank?.kind).toBe("other");
    expect(blank !== null && "callsign" in blank).toBe(false);

    const missing = normalizeOpenSkyState(stateRow({ 1: null }), RESPONSE_TIME);
    expect(missing?.kind).toBe("other");
    expect(missing !== null && "callsign" in missing).toBe(false);
  });

  it("貨物社のコールサインは cargo", () => {
    expect(normalizeOpenSkyState(stateRow({ 1: "FDX5901 " }), RESPONSE_TIME)?.kind).toBe("cargo");
  });

  it("配列でない・長さが足りない・hex が文字列でない／空文字の要素は捨てる", async () => {
    const flights = await fetchStates({
      time: RESPONSE_TIME,
      states: [
        { icao24: "f0b020" },
        null,
        stateRow({ 0: "f0b021" }).slice(0, 16),
        stateRow({ 0: 0xf0b022 }),
        stateRow({ 0: null }),
        stateRow({ 0: "" }),
        stateRow({ 0: "f0b023" }),
        [...stateRow({ 0: "f0b024" }), 3], // extended の category 付き（18 要素）は読める
      ],
    });
    expect(flights.map((f) => f.hex)).toEqual(["f0b023", "f0b024"]);
  });
});

describe("応答の形", () => {
  it("states が null → 0 機", async () => {
    await expect(fetchStates({ time: RESPONSE_TIME, states: null })).resolves.toEqual([]);
  });

  it("states が欠落 → 0 機", async () => {
    await expect(fetchStates({ time: RESPONSE_TIME })).resolves.toEqual([]);
  });

  it.each([
    ["オブジェクト", {}],
    ["文字列", "none"],
    ["数値", 3],
  ])("states が配列以外（%s）→ UpstreamError", async (_label, states) => {
    const error = await catchError(fetchStates({ time: RESPONSE_TIME, states }));
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).status).toBeUndefined();
  });

  it("応答がオブジェクトでない → UpstreamError", async () => {
    const error = await catchError(fetchStates([stateRow()]));
    expect(error).toBeInstanceOf(UpstreamError);
  });

  it("機体があるのに time が数値でない → UpstreamError", async () => {
    const error = await catchError(fetchStates({ time: null, states: [stateRow()] }));
    expect(error).toBeInstanceOf(UpstreamError);
  });
});

describe("失敗は UpstreamError", () => {
  it("HTTP 500 → status 500", async () => {
    const fake = fakeFetch(() => new Response("upstream down", { status: 500 }));
    const error = await catchError(createOpenSkyProvider({ fetch: fake.fetch }).fetchNearby(query));
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).status).toBe(500);
  });

  it("HTTP 429 → status 429 と X-Rate-Limit-Retry-After-Seconds の秒数", async () => {
    const fake = fakeFetch(
      () => new Response("", { status: 429, headers: { "X-Rate-Limit-Retry-After-Seconds": "3600" } }),
    );
    const error = await catchError(createOpenSkyProvider({ fetch: fake.fetch }).fetchNearby(query));
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).status).toBe(429);
    expect((error as UpstreamError).retryAfterSec).toBe(3600);
  });

  it("タイムアウト → status 無し", async () => {
    const provider = createOpenSkyProvider({ timeoutMs: 20, fetch: () => new Promise<Response>(() => undefined) });
    const error = await catchError(provider.fetchNearby(query));
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).status).toBeUndefined();
    expect((error as UpstreamError).message).toMatch(/timed out/);
  });
});

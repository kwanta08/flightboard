import { describe, expect, it } from "vitest";
import type { FlightDetailResponse, NearbyResponse } from "../../shared/types.ts";
import {
  ApiRequestError,
  fetchFlightDetail,
  fetchNearby,
  flightDetailUrl,
  isAbortError,
  nearbyParamsKey,
  nearbyUrl,
  type FetchLike,
  type NearbyParams,
} from "./api.ts";

const PARAMS: NearbyParams = { lat: 35.8709, lon: 139.9256, radiusKm: 50, kinds: ["passenger", "cargo"] };

const NEARBY: NearbyResponse = {
  updatedAt: "2026-09-15T00:00:00.000Z",
  source: "adsblol",
  flights: [
    {
      hex: "86d7a4",
      callsign: "JAL123",
      position: { lat: 35.6, lon: 139.8, altitudeBaroFt: 10000, onGround: false },
      isMlat: false,
      seenPosSec: 2,
      kind: "passenger",
      source: "adsblol",
    },
  ],
  airportOps: [],
};

const DETAIL: FlightDetailResponse = {
  updatedAt: "2026-09-15T00:00:00.000Z",
  flight: NEARBY.flights[0]!,
  track: [{ lat: 35.5, lon: 139.7, altitudeFt: 9000, at: "2026-09-14T23:59:50.000Z" }],
};

/** サーバーの 10 進表記の検証（src/server/nearbyParams.ts の DECIMAL）と同じ形 */
const DECIMAL = /^-?\d+(\.\d+)?$/;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function textResponse(text: string, status: number): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain" } });
}

/** 呼ばれた URL と signal を記録し、`respond` の応答を返す偽の fetch */
function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; signal: AbortSignal | undefined }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, signal: init.signal });
    return respond();
  };
  return { fetch, calls };
}

/** 中断されるまで応答しない偽の fetch（ブラウザと同じく、中断されたら AbortError で失敗する） */
function hangingFetch(): FetchLike {
  return (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
      if (init.signal?.aborted) {
        onAbort();
      } else {
        init.signal?.addEventListener("abort", onAbort, { once: true });
      }
    });
}

/** 中断を無視し、`settle` を呼ぶまで決着しない偽の fetch */
function manualFetch() {
  let resolve: (response: Response) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const fetch: FetchLike = () =>
    new Promise<Response>((res, rej) => {
      resolve = res;
      reject = rej;
    });
  return {
    fetch,
    resolve: (response: Response) => resolve(response),
    reject: (error: unknown) => reject(error),
  };
}

/** 例外を投げることを確かめて、その例外を返す */
async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("例外が投げられませんでした");
}

function queryOf(url: string): URLSearchParams {
  return new URL(url, "http://127.0.0.1").searchParams;
}

describe("nearbyUrl", () => {
  it("パス・緯度・経度・半径・種類をこの順で組み立てる", () => {
    expect(nearbyUrl(PARAMS)).toBe("/api/nearby?lat=35.8709&lon=139.9256&radiusKm=50&kinds=passenger,cargo");
  });

  it("kinds は渡された順でカンマ区切り（%2C にしない）", () => {
    expect(nearbyUrl({ ...PARAMS, kinds: ["cargo", "passenger"] })).toMatch(/&kinds=cargo,passenger$/);
    expect(nearbyUrl({ ...PARAMS, kinds: ["passenger"] })).toMatch(/&kinds=passenger$/);
    expect(nearbyUrl({ ...PARAMS, kinds: ["cargo"] })).toMatch(/&kinds=cargo$/);
  });

  it("radiusKm をそのまま 10 進で送る", () => {
    expect(queryOf(nearbyUrl({ ...PARAMS, radiusKm: 10 })).get("radiusKm")).toBe("10");
    expect(queryOf(nearbyUrl({ ...PARAMS, radiusKm: 25 })).get("radiusKm")).toBe("25");
    expect(queryOf(nearbyUrl({ ...PARAMS, radiusKm: 100 })).get("radiusKm")).toBe("100");
  });

  it("0.0000001 のような小さな値も指数表記にしない", () => {
    expect(String(0.0000001)).toBe("1e-7"); // 素朴に String にすると指数表記になる前提の確認
    const query = queryOf(nearbyUrl({ ...PARAMS, lat: 0.0000001, lon: 0.000001 }));
    expect(query.get("lat")).toBe("0");
    expect(query.get("lon")).toBe("0.000001");
    expect(query.get("lat")).toMatch(DECIMAL);
    expect(query.get("lon")).toMatch(DECIMAL);
  });

  it("-0（丸めて -0 になる値も）は 0 にする", () => {
    const query = queryOf(nearbyUrl({ ...PARAMS, lat: -0, lon: -0.0000001 }));
    expect(query.get("lat")).toBe("0");
    expect(query.get("lon")).toBe("0");
  });

  it("小数 6 桁に丸め、負の値もサーバーが受け付ける 10 進表記にする", () => {
    const query = queryOf(nearbyUrl({ lat: -33.94612345, lon: 139.92561234, radiusKm: 50, kinds: ["passenger"] }));
    expect(query.get("lat")).toBe("-33.946123");
    expect(query.get("lon")).toBe("139.925612");
    expect(query.get("lat")).toMatch(DECIMAL);
    expect(query.get("lon")).toMatch(DECIMAL);
  });
});

describe("nearbyParamsKey", () => {
  it("条件が無ければ undefined", () => {
    expect(nearbyParamsKey(undefined)).toBeUndefined();
  });

  it("別のオブジェクトでも値が同じなら同じキー", () => {
    const copy: NearbyParams = { lat: 35.8709, lon: 139.9256, radiusKm: 50, kinds: ["passenger", "cargo"] };
    expect(copy).not.toBe(PARAMS);
    expect(nearbyParamsKey(copy)).toBe(nearbyParamsKey(PARAMS));
  });

  it.each<[string, NearbyParams]>([
    ["緯度", { ...PARAMS, lat: 35.8710 }],
    ["経度", { ...PARAMS, lon: 139.9257 }],
    ["半径", { ...PARAMS, radiusKm: 25 }],
    ["種類", { ...PARAMS, kinds: ["passenger"] }],
  ])("%s が変わるとキーが変わる", (_label, changed) => {
    expect(nearbyParamsKey(changed)).not.toBe(nearbyParamsKey(PARAMS));
  });
});

describe("fetchNearby", () => {
  it("200 なら応答ボディを返し、nearbyUrl と signal で fetch を呼ぶ", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(NEARBY));
    const controller = new AbortController();
    await expect(fetchNearby(PARAMS, { fetch, signal: controller.signal })).resolves.toEqual(NEARBY);
    expect(calls).toEqual([{ url: nearbyUrl(PARAMS), signal: controller.signal }]);
  });

  it("400 はボディの error を message にした ApiRequestError（status 400）", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "lat は必須です（-90 以上 90 以下の 10 進数）" }, 400));
    const error = await caught(fetchNearby(PARAMS, { fetch }));
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).status).toBe(400);
    expect((error as ApiRequestError).message).toBe("lat は必須です（-90 以上 90 以下の 10 進数）");
    expect(isAbortError(error)).toBe(false);
  });

  it("502 はボディの error を message にした ApiRequestError（status 502）", async () => {
    const message = "位置情報の提供元から取得できませんでした。しばらくしてから再度お試しください";
    const { fetch } = fakeFetch(() => jsonResponse({ error: message }, 502));
    const error = await caught(fetchNearby(PARAMS, { fetch }));
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).status).toBe(502);
    expect((error as ApiRequestError).message).toBe(message);
  });

  it("ボディが JSON でない 500 は既定の日本語文言の ApiRequestError（status 500）", async () => {
    const { fetch } = fakeFetch(() => textResponse("Internal Server Error", 500));
    const error = await caught(fetchNearby(PARAMS, { fetch }));
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).status).toBe(500);
    expect((error as ApiRequestError).message).toBe("サーバーから取得できませんでした（HTTP 500）");
  });

  it("非 2xx でボディの error が文字列でなければ既定の文言", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: 123 }, 502));
    const error = await caught(fetchNearby(PARAMS, { fetch }));
    expect((error as ApiRequestError).status).toBe(502);
    expect((error as ApiRequestError).message).toBe("サーバーから取得できませんでした（HTTP 502）");
  });

  it("ネットワーク失敗は status の無い ApiRequestError", async () => {
    const cause = new TypeError("Failed to fetch");
    const fetch: FetchLike = () => Promise.reject(cause);
    const error = await caught(fetchNearby(PARAMS, { fetch }));
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).status).toBeUndefined();
    expect((error as ApiRequestError).message).toBe("サーバーに接続できませんでした");
    expect((error as ApiRequestError).cause).toBe(cause);
    expect(isAbortError(error)).toBe(false);
  });

  it("200 でもボディが JSON として不正なら ApiRequestError", async () => {
    const { fetch } = fakeFetch(() => textResponse("{ not json", 200));
    const error = await caught(fetchNearby(PARAMS, { fetch }));
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).status).toBe(200);
    expect((error as ApiRequestError).message).toBe("サーバーの応答を読み取れませんでした");
  });

  it("200 でもボディの形が NearbyResponse でなければ ApiRequestError", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ updatedAt: "2026-09-15T00:00:00.000Z" }));
    const error = await caught(fetchNearby(PARAMS, { fetch }));
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).status).toBe(200);
  });

  // ヘッダーの運用方向（AC-P2-52）が読む配列なので、欠けた応答を NearbyResponse として通さない
  it("airportOps の無い応答も形が違うものとして ApiRequestError", async () => {
    const { airportOps: _airportOps, ...withoutAirportOps } = NEARBY;
    const { fetch } = fakeFetch(() => jsonResponse(withoutAirportOps));
    const error = await caught(fetchNearby(PARAMS, { fetch }));
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).status).toBe(200);
  });

  it("kinds が空なら要求を送らず、status の無い ApiRequestError で失敗する（サーバーが 400 を返すため）", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(NEARBY));
    const error = await caught(fetchNearby({ ...PARAMS, kinds: [] }, { fetch }));
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).message).toBe("表示する種類が選ばれていません");
    expect((error as ApiRequestError).status).toBeUndefined();
    expect(isAbortError(error)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("signal を中断すると ApiRequestError に包まず、isAbortError が true の例外で失敗する", async () => {
    const controller = new AbortController();
    const promise = fetchNearby(PARAMS, { fetch: hangingFetch(), signal: controller.signal });
    controller.abort();
    const error = await caught(promise);
    expect(isAbortError(error)).toBe(true);
    expect(error).not.toBeInstanceOf(ApiRequestError);
  });

  it("中断した後に fetch が 200 を返しても成功にせず、中断の例外で失敗する", async () => {
    const manual = manualFetch();
    const controller = new AbortController();
    const promise = fetchNearby(PARAMS, { fetch: manual.fetch, signal: controller.signal });
    controller.abort();
    manual.resolve(jsonResponse(NEARBY));
    const error = await caught(promise);
    expect(isAbortError(error)).toBe(true);
  });

  it("中断した後に fetch が AbortError 以外で失敗しても、中断として扱う（失敗にしない）", async () => {
    const manual = manualFetch();
    const controller = new AbortController();
    const promise = fetchNearby(PARAMS, { fetch: manual.fetch, signal: controller.signal });
    controller.abort();
    manual.reject(new TypeError("Failed to fetch"));
    const error = await caught(promise);
    expect(isAbortError(error)).toBe(true);
    expect(error).not.toBeInstanceOf(ApiRequestError);
  });
});

describe("fetchFlightDetail", () => {
  it("URL は /api/flights/ に hex を encodeURIComponent して付ける", async () => {
    expect(flightDetailUrl("86d7a4")).toBe("/api/flights/86d7a4");
    expect(flightDetailUrl("~a b/c?")).toBe(`/api/flights/${encodeURIComponent("~a b/c?")}`);
    expect(flightDetailUrl("~a b/c?")).toBe("/api/flights/~a%20b%2Fc%3F");

    const { fetch, calls } = fakeFetch(() => jsonResponse(DETAIL));
    await fetchFlightDetail("~a b/c?", { fetch });
    expect(calls.map((c) => c.url)).toEqual(["/api/flights/~a%20b%2Fc%3F"]);
  });

  it("200 なら応答ボディを返す", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(DETAIL));
    const controller = new AbortController();
    await expect(fetchFlightDetail("86d7a4", { fetch, signal: controller.signal })).resolves.toEqual(DETAIL);
    expect(calls[0]!.signal).toBe(controller.signal);
  });

  it('404 なら "not-found"', async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "指定された機体の情報はありません" }, 404));
    await expect(fetchFlightDetail("86d7a4", { fetch })).resolves.toBe("not-found");
  });

  it("500 はボディの error を message にした ApiRequestError（status 500）", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "サーバー内部でエラーが発生しました" }, 500));
    const error = await caught(fetchFlightDetail("86d7a4", { fetch }));
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).status).toBe(500);
    expect((error as ApiRequestError).message).toBe("サーバー内部でエラーが発生しました");
  });

  it("400 は ApiRequestError（status 400）", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "hex は 6 桁の 16 進で指定してください" }, 400));
    const error = await caught(fetchFlightDetail("zz", { fetch }));
    expect((error as ApiRequestError).status).toBe(400);
  });

  it("ネットワーク失敗は status の無い ApiRequestError、JSON 不正の 200 は ApiRequestError", async () => {
    const network = await caught(fetchFlightDetail("86d7a4", { fetch: () => Promise.reject(new TypeError("x")) }));
    expect(network).toBeInstanceOf(ApiRequestError);
    expect((network as ApiRequestError).status).toBeUndefined();

    const { fetch } = fakeFetch(() => textResponse("<html>", 200));
    const invalid = await caught(fetchFlightDetail("86d7a4", { fetch }));
    expect(invalid).toBeInstanceOf(ApiRequestError);
  });

  it("signal を中断すると isAbortError が true の例外で失敗する", async () => {
    const controller = new AbortController();
    const promise = fetchFlightDetail("86d7a4", { fetch: hangingFetch(), signal: controller.signal });
    controller.abort();
    const error = await caught(promise);
    expect(isAbortError(error)).toBe(true);
    expect(error).not.toBeInstanceOf(ApiRequestError);
  });

  it('中断した後に 404 が届いても "not-found" にせず、中断の例外で失敗する', async () => {
    const manual = manualFetch();
    const controller = new AbortController();
    const promise = fetchFlightDetail("86d7a4", { fetch: manual.fetch, signal: controller.signal });
    controller.abort();
    manual.resolve(jsonResponse({ error: "指定された機体の情報はありません" }, 404));
    const error = await caught(promise);
    expect(isAbortError(error)).toBe(true);
  });
});

describe("isAbortError / ApiRequestError", () => {
  it("name が AbortError のものだけ true", () => {
    expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isAbortError({ name: "AbortError" })).toBe(true);
    expect(isAbortError(new DOMException("timeout", "TimeoutError"))).toBe(false);
    expect(isAbortError(new Error("AbortError"))).toBe(false);
    expect(isAbortError(new ApiRequestError("x", 500))).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
  });

  it("ApiRequestError は Error で、name・message・status を持つ", () => {
    const error = new ApiRequestError("失敗", 502);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ApiRequestError");
    expect(error.message).toBe("失敗");
    expect(error.status).toBe(502);
    expect(new ApiRequestError("失敗").status).toBeUndefined();
  });
});

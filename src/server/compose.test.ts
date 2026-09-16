// composeApp の配線（位置の提供元の順序・時計の共有・ビルド済みの画面の案内）。上流には接続せず、偽の fetch・時計・待機で確かめる。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Flight } from "../shared/types.ts";
import { composeApp } from "./compose.ts";
import type { ComposeAppOptions } from "./compose.ts";
import type { FetchLike } from "./providers/provider.ts";

const T0 = Date.UTC(2026, 8, 15, 0, 0, 0);
const NEARBY = "/api/nearby?lat=35.87&lon=139.93";
const BUILD_NOT_FOUND = "ビルド済みの画面が見つかりません（npm run build または npm start を実行してください）";

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** 受けた要求の URL を記録し、`respond` の応答を返す偽の fetch と、進められる偽の時計・即座に解決する待機で合成する */
function setup(respond: (url: URL) => Response, options: Omit<ComposeAppOptions, "fetch" | "now" | "sleep"> = {}) {
  let time = T0;
  const urls: URL[] = [];
  const fetch: FetchLike = async (url) => {
    const parsed = new URL(url);
    urls.push(parsed);
    return respond(parsed);
  };
  const app = composeApp({ fetch, now: () => time, sleep: async () => undefined, ...options });
  return {
    app,
    urls,
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

/** このテストでは要求しない上流 */
function unexpectedUpstream(): Response {
  return new Response("unexpected", { status: 500 });
}

describe("composeApp: 位置の提供元の順序（AC-A4）", () => {
  it("すべての要求に 500 を返すと /api/nearby は 502 で、要求は api.adsb.lol → opendata.adsb.fi → opensky-network.org の順に届く", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = setup(() => new Response("down", { status: 500 }));

    const { res, body } = await t.get(NEARBY);
    expect(res.status).toBe(502);
    expect(Object.keys(body)).toEqual(["error"]);
    expect(t.urls.map((url) => url.hostname)).toEqual(["api.adsb.lol", "opendata.adsb.fi", "opensky-network.org"]);
  });
});

describe("composeApp: 時計の共有（AC-A8・AC-A16・M2-3）", () => {
  it("adsb.lol の旅客機（seen_pos: 1）を取得した後に時計を 3 秒進めると、/api/nearby（キャッシュヒット）と /api/flights/:hex の seenPosSec がどちらも 4", async () => {
    const t = setup((url) => {
      if (url.hostname === "api.adsb.lol") {
        return jsonResponse({
          ac: [{ hex: "86d7a4", flight: "ANA245  ", t: "B789", alt_baro: 12000, lat: 35.88, lon: 139.94, seen_pos: 1 }],
        });
      }
      if (url.hostname === "api.adsbdb.com") return jsonResponse({ response: "not found" }, 404);
      // 詳細では写真も照会する（写真の無い機体）
      if (url.hostname === "api.planespotters.net") return jsonResponse({ photos: [] });
      return unexpectedUpstream();
    });

    const first = await t.get(NEARBY);
    expect(first.res.status).toBe(200);
    expect(first.body.source).toBe("adsblol");
    expect((first.body.flights as Flight[]).map((f) => [f.hex, f.kind, f.seenPosSec])).toEqual([["86d7a4", "passenger", 1]]);

    t.advance(3000);
    const cached = await t.get(NEARBY);
    expect(cached.res.status).toBe(200);
    expect(cached.body.updatedAt).toBe(new Date(T0).toISOString());
    expect((cached.body.flights as Flight[]).map((f) => f.seenPosSec)).toEqual([4]);

    const detail = await t.get("/api/flights/86d7a4");
    expect(detail.res.status).toBe(200);
    expect(detail.body.updatedAt).toBe(new Date(T0).toISOString());
    expect((detail.body.flight as Flight).seenPosSec).toBe(4);
    expect(detail.body.flight).not.toHaveProperty("aircraft");

    // 位置の上流への要求は 1 回目の取得の 1 本だけ（2 回目はキャッシュから返した）
    const upstreams = t.urls.filter((url) => url.hostname !== "api.adsbdb.com" && url.hostname !== "api.planespotters.net");
    expect(upstreams.map((url) => url.hostname)).toEqual(["api.adsb.lol"]);
    // 写真の提供元は詳細のときだけ、その機体の hex で 1 回照会する
    expect(t.urls.filter((url) => url.hostname === "api.planespotters.net").map((url) => url.pathname)).toEqual([
      "/pub/photos/hex/86d7a4",
    ]);
  });
});

describe("composeApp: ビルド済みの画面が無いときの案内（W1 MINOR-1）", () => {
  let staticRoot = "";

  beforeAll(async () => {
    // serveStatic は存在しないディレクトリを渡すと自身の console.error を出すので、実在する空のディレクトリを使う
    staticRoot = await mkdtemp(join(tmpdir(), "flightboard-compose-"));
  });

  afterAll(async () => {
    if (staticRoot !== "") await rm(staticRoot, { recursive: true, force: true });
  });

  it("staticRoot の index.html が無い（fileExists が false）なら console.error に案内を 1 回出し、アプリは作る", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const checked: string[] = [];
    const t = setup(unexpectedUpstream, {
      staticRoot,
      fileExists: (path) => {
        checked.push(path);
        return false;
      },
    });

    expect(checked).toEqual([join(staticRoot, "index.html")]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(BUILD_NOT_FOUND);
    // 起動は続ける（API は応答し、画面の要求は 404）
    expect((await t.app.request("/api/nearby?lon=139.93")).status).toBe(400);
    expect((await t.app.request("/")).status).toBe(404);
    expect(t.urls).toEqual([]);
  });

  it("index.html がある（fileExists が true）なら console.error を呼ばない", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const checked: string[] = [];
    setup(unexpectedUpstream, {
      staticRoot,
      fileExists: (path) => {
        checked.push(path);
        return true;
      },
    });

    expect(checked).toEqual([join(staticRoot, "index.html")]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("staticRoot を指定しなければ index.html を確かめず、console.error を呼ばない", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fileExists = vi.fn((_path: string) => false);
    setup(unexpectedUpstream, { fileExists });

    expect(fileExists).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

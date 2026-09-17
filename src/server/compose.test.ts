// composeApp の配線（位置の提供元の順序・時計の共有・ビルド済みの画面の案内）。上流には接続せず、偽の fetch・時計・待機で確かめる。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { destinationPoint } from "../shared/geo.ts";
import type { Flight } from "../shared/types.ts";
import { composeApp } from "./compose.ts";
import type { ComposeAppOptions } from "./compose.ts";
import { RUNWAY_ENDS } from "./data/runways.ts";
import { runwayBearingDeg } from "./estimate/runway.ts";
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

/**
 * 受けた要求の URL を記録し、`respond` の応答を返す偽の fetch と、進められる偽の時計・即座に解決する待機で合成する。
 * 空港中心の取得は既定で無効（`airportOps: false`）にし、上流への要求を観測点の 1 系統だけに保つ。
 * 有効にしたときの配線は「空港中心の取得」の describe で別に確かめる
 */
function setup(respond: (url: URL) => Response, options: Omit<ComposeAppOptions, "fetch" | "now" | "sleep"> = {}) {
  let time = T0;
  const urls: URL[] = [];
  const fetch: FetchLike = async (url) => {
    const parsed = new URL(url);
    urls.push(parsed);
    return respond(parsed);
  };
  const app = composeApp({ fetch, now: () => time, sleep: async () => undefined, airportOps: false, ...options });
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

describe("composeApp: 空港中心の取得（AC-P2-61・提供元の共有）", () => {
  /** 待っているマイクロタスクを流す（空港中心の取得は応答を待たせないので、決着させてから確かめる） */
  function flush(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  /** 位置の上流への要求だけを取り出す（adsbdb・planespotters を除く） */
  function positionUrls(urls: URL[]): URL[] {
    return urls.filter((url) => url.hostname !== "api.adsbdb.com" && url.hostname !== "api.planespotters.net");
  }

  it("既定（指定しない）では有効で、/api/nearby の処理中に羽田中心・半径 60NM の取得が 1 本だけ出る", async () => {
    const urls: URL[] = [];
    const fetch: FetchLike = async (url) => {
      urls.push(new URL(url));
      return jsonResponse({ ac: [] });
    };
    const app = composeApp({ fetch, now: () => T0, sleep: async () => undefined });

    const res = await app.request(NEARBY);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ airportOps: [] });
    await flush();

    // 観測点（半径 27NM）1 本 ＋ 空港（半径 60NM）1 本 = 2 本
    expect(positionUrls(urls).map((url) => url.pathname)).toEqual([
      "/v2/point/35.87/139.93/27",
      "/v2/point/35.5523/139.78/60",
    ]);
  });

  it("airportOps: false なら空港中心の取得をせず、上流へ出るのは観測点の 1 本だけ", async () => {
    const t = setup(() => jsonResponse({ ac: [] }), { airportOps: false });

    const { res } = await t.get(NEARBY);
    expect(res.status).toBe(200);
    await flush();
    expect(positionUrls(t.urls).map((url) => url.pathname)).toEqual(["/v2/point/35.87/139.93/27"]);
  });

  it("観測点の取得で 429 になった提供元は空港中心の取得でも試さない（同じ提供元インスタンスを共有する）", async () => {
    const t = setup(
      (url) => (url.hostname === "api.adsb.lol" ? new Response("slow down", { status: 429 }) : jsonResponse({ ac: [] })),
      { airportOps: true },
    );

    const { res } = await t.get(NEARBY);
    expect(res.status).toBe(200);
    await flush();

    // 観測点: adsb.lol が 429 → adsb.fi で取得。空港: 休止中の adsb.lol を飛ばして adsb.fi から取得
    expect(positionUrls(t.urls).map((url) => [url.hostname, url.pathname])).toEqual([
      ["api.adsb.lol", "/v2/point/35.87/139.93/27"],
      ["opendata.adsb.fi", "/api/v3/lat/35.87/lon/139.93/dist/27"],
      ["opendata.adsb.fi", "/api/v3/lat/35.5523/lon/139.78/dist/60"],
    ]);
  });

  it("空港中心の取得は次の要求まで TTL（30 秒）あけ、その間は成田を 1 本だけ取る", async () => {
    const t = setup(() => jsonResponse({ ac: [] }), { airportOps: true });

    await t.get(NEARBY);
    await flush();
    t.advance(5000); // 位置のキャッシュ（5 秒）を外す
    await t.get(NEARBY);
    await flush();
    t.advance(5000);
    await t.get(NEARBY); // 羽田・成田とも TTL 内なので空港取得は出ない
    await flush();

    expect(positionUrls(t.urls).map((url) => url.pathname)).toEqual([
      "/v2/point/35.87/139.93/27",
      "/v2/point/35.5523/139.78/60",
      "/v2/point/35.87/139.93/27",
      "/v2/point/35.7647/140.386/60",
      "/v2/point/35.87/139.93/27",
    ]);
  });
});

/**
 * W10 MINOR-3: `composeApp` が `createAirportOpsSource` に**行と同じ `getRoute`** を渡している配線（`compose.ts`）を縛る。
 * この 1 行が落ちると、集計だけが adsbdb のルートを見ない推定になり、同じ応答の行と食い違う（W9 MAJOR-2 の再発）。
 * 上流には接続せず、偽の fetch で adsbdb の応答（RJTT → RJFF＝「羽田発」）を返す
 */
describe("composeApp: 運用方向の集計が行と同じルートを見る（W9 MAJOR-2 の配線）", () => {
  /** RJTT 22 の進入側の延長線上 8km に**合成**した機体（幾何では「RWY22 へ進入」になる） */
  function approachingRjtt22(): Record<string, unknown> {
    const end = RUNWAY_ENDS.find((other) => other.icao === "RJTT" && other.ident === "22")!;
    const bearing = runwayBearingDeg(end, RUNWAY_ENDS)!;
    const position = destinationPoint(end, bearing + 180, 8);
    return {
      hex: "abc123",
      flight: "JAL001  ",
      t: "B789",
      alt_baro: 2000,
      lat: position.lat,
      lon: position.lon,
      track: ((bearing % 360) + 360) % 360,
      baro_rate: -704,
      seen_pos: 1,
    };
  }

  /** 進行方向・昇降率が無いので幾何では何も決まらない機体（1 回目。ルートを積ませるためだけに返す） */
  const LEVEL_FLIGHT = { hex: "abc123", flight: "JAL001  ", t: "B789", alt_baro: 10000, lat: 35.88, lon: 139.94, seen_pos: 1 };

  /** adsbdb の「羽田発・福岡行き」の応答（航空会社は null。M2-1） */
  const HANEDA_DEPARTURE = {
    response: {
      flightroute: {
        callsign: "JAL001",
        airline: null,
        origin: { icao_code: "RJTT", name: "Tokyo Haneda International Airport" },
        destination: { icao_code: "RJFF", name: "Fukuoka Airport" },
      },
    },
  };

  /** ルート照会の worker が決着するまで待つ（要求の送信と応答の解釈に数ティックかかる） */
  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  it("1 回目でルートを積み、2 回目は行が「出発・滑走路なし」になり、集計も RWY22 着陸として数えない", async () => {
    let observations = 0;
    const t = setup(
      (url) => {
        if (url.hostname === "api.adsbdb.com") return jsonResponse(HANEDA_DEPARTURE);
        if (url.hostname !== "api.adsb.lol") return unexpectedUpstream();
        // 空港中心の取得（半径 60NM）は空で返し、観測点の取得だけで時系列を作る
        if (url.pathname.endsWith("/60")) return jsonResponse({ ac: [] });
        observations += 1;
        return jsonResponse({ ac: [observations === 1 ? LEVEL_FLIGHT : approachingRjtt22()] });
      },
      { airportOps: true },
    );

    // 1 回目: ルートはまだキャッシュに無く、幾何でも何も決まらない
    const first = await t.get(NEARBY);
    expect((first.body.flights as Flight[]).map((f) => f.estimate)).toEqual([undefined]);
    expect(first.body.airportOps).toEqual([]);

    await settle(); // 積んだルート照会を決着させる
    t.advance(6000); // 位置のキャッシュ（5 秒）を外す

    // 2 回目: 同じ機体が RWY22 へ進入中に見えるが、adsbdb は「羽田発」と言っている
    const second = await t.get(NEARBY);
    const estimate = (second.body.flights as Flight[]).find((f) => f.hex === "abc123")?.estimate;
    // 行は AC-P2-16 どおり「出発・滑走路なし」（route 由来の phase）
    expect(estimate?.phase).toBe("departure");
    expect(estimate?.runway).toBeUndefined();
    // 集計も同じ入力で決まる（`getRoute` を渡していなければ「RWY22 着陸 1 機・南風運用」になる）
    expect(second.body.airportOps).toEqual([]);
    // 集計のために adsbdb への照会は増やさない（キャッシュを引くだけ）
    expect(t.urls.filter((url) => url.hostname === "api.adsbdb.com").map((url) => url.pathname)).toEqual([
      "/v0/callsign/JAL001",
    ]);
  });
});

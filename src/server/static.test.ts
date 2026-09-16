// createApp の静的配信（staticRoot）と 404 の分岐（AC-B1・M-A6）。配信するファイルは一時ディレクトリに置き、上流には接続しない。
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Flight } from "../shared/types.ts";
import { createApp } from "./app.ts";
import { startServer } from "./server.ts";

const INDEX_HTML = '<!doctype html>\n<html lang="ja"><head><title>FlightBoard</title></head><body><div id="root"></div></body></html>\n';
const ASSET_JS = 'console.log("a");\n';
/** staticRoot の外（親ディレクトリ）に置く secret.txt の中身 */
const SECRET = "TOP-SECRET";
/**
 * staticRoot の外の secret.txt を指すパス（W1 MINOR-2）。
 * 先頭の 3 つは URL の解析（app.request の Request・@hono/node-server）でドットセグメントが解決されてからアプリに届く。
 * 区切りを符号化した後ろの 2 つ（`%2f` は `/`、`%5c` は `\`）は解決されずに届くので、静的配信側での拒否を確かめる
 */
const TRAVERSAL_PATHS = ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/../../secret.txt", "/..%2fsecret.txt", "/..%5csecret.txt"];

/** 呼び出し回数を数える偽の位置取得（このテストのどの要求でも呼ばれない） */
function fakePositions() {
  const fake = {
    calls: 0,
    async fetchNearby() {
      fake.calls += 1;
      return { flights: [] as Flight[], source: "adsblol" as const };
    },
  };
  return fake;
}

/** JSON の `{ error }`（ApiError）で指定のステータスか */
async function expectApiError(res: Response, status: number): Promise<void> {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  const body = (await res.json()) as Record<string, unknown>;
  expect(Object.keys(body)).toEqual(["error"]);
  expect(typeof body.error).toBe("string");
}

/**
 * パスを正規化せずにそのまま送る GET。`app.request`・`fetch` は URL を解析してドットセグメント（`..`・`%2e%2e`）を
 * 解決してから送るので、サーバー側での拒否を確かめるために node:http で生のパスを送る
 */
function rawGet(baseUrl: string, path: string): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, method: "GET", agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

let workDir = "";
let staticRoot = "";

beforeAll(async () => {
  // staticRoot の外のファイルを配信しないことを確かめるため、一時ディレクトリの下に staticRoot を作り、一時ディレクトリの直下に secret.txt を置く
  workDir = await mkdtemp(join(tmpdir(), "flightboard-static-"));
  staticRoot = join(workDir, "client");
  await mkdir(staticRoot);
  await writeFile(join(workDir, "secret.txt"), SECRET);
  await writeFile(join(staticRoot, "index.html"), INDEX_HTML);
  await mkdir(join(staticRoot, "assets"));
  await writeFile(join(staticRoot, "assets", "a.js"), ASSET_JS);
  // /api/ 以下は同名のファイルがあっても静的配信しないことを確かめるため、あえて置く
  await mkdir(join(staticRoot, "api"));
  await writeFile(join(staticRoot, "api", "unknown"), "static file");
});

afterAll(async () => {
  if (workDir !== "") await rm(workDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createApp（staticRoot を指定）", () => {
  function setup() {
    const positions = fakePositions();
    const app = createApp({ positions, staticRoot });
    return { app, positions };
  }

  it("/ は index.html を text/html の 200 で返す", async () => {
    const { app, positions } = setup();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await res.text()).toContain('<div id="root">');
    expect(positions.calls).toBe(0);
  });

  it("/assets/a.js を 200 で返す", async () => {
    const { app } = setup();
    const res = await app.request("/assets/a.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(await res.text()).toBe(ASSET_JS);
  });

  it("見つからないファイルは JSON でない（text/plain の）404", async () => {
    const { app } = setup();
    const res = await app.request("/nope.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    const text = await res.text();
    expect(() => JSON.parse(text)).toThrow();
  });

  it("/api/unknown は同名のファイルがあっても静的配信せず JSON の 404 ApiError", async () => {
    const { app, positions } = setup();
    await expectApiError(await app.request("/api/unknown"), 404);
    expect(positions.calls).toBe(0);
  });

  it("/api ちょうども JSON の 404 ApiError", async () => {
    const { app } = setup();
    await expectApiError(await app.request("/api"), 404);
  });

  it("/api/nearby の検証エラー（lat 無し）は従来どおり 400 JSON で、位置を取得しない", async () => {
    const { app, positions } = setup();
    await expectApiError(await app.request("/api/nearby?lon=139.93"), 400);
    expect(positions.calls).toBe(0);
  });

  it("存在するディレクトリを渡したときは console.error を呼ばない", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = setup();
    expect((await app.request("/")).status).toBe(200);
    expect((await app.request("/nope.js")).status).toBe(404);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("前提: secret.txt は staticRoot の親ディレクトリにある", async () => {
    expect(await readFile(join(staticRoot, "..", "secret.txt"), "utf8")).toBe(SECRET);
  });

  it.each(TRAVERSAL_PATHS)("staticRoot の外のファイルは配信しない（app.request）: %s は 404 で本文に中身を含まない", async (path) => {
    const { app, positions } = setup();
    const res = await app.request(path);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(SECRET);
    expect(positions.calls).toBe(0);
  });

  it.each(TRAVERSAL_PATHS)("staticRoot の外のファイルは配信しない（実 HTTP で生のパスを送る）: %s は 404 で本文に中身を含まない", async (path) => {
    const { app } = setup();
    const server = await startServer({ app, port: 0 });
    try {
      const res = await rawGet(server.url, path);
      expect(res.status).toBe(404);
      expect(res.body).not.toContain(SECRET);
    } finally {
      await server.close();
    }
  });
});

describe("createApp（staticRoot を指定しない）", () => {
  it("/ は従来どおり JSON の 404 ApiError で、console.error を呼ばない", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const positions = fakePositions();
    const app = createApp({ positions });
    await expectApiError(await app.request("/"), 404);
    await expectApiError(await app.request("/assets/a.js"), 404);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(positions.calls).toBe(0);
  });
});

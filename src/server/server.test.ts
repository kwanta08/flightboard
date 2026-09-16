import type { ServerType } from "@hono/node-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Flight } from "../shared/types.ts";
import { createApp } from "./app.ts";
import { parsePortEnv, startServer } from "./server.ts";
import type { RunningServer } from "./server.ts";

// 実際に待ち受けているアドレスを確かめるため、本物の serve をそのまま呼びつつ戻り値のサーバーを記録する
const { served } = vi.hoisted(() => ({ served: [] as ServerType[] }));

vi.mock("@hono/node-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hono/node-server")>();
  return {
    ...actual,
    serve: (...args: Parameters<typeof actual.serve>) => {
      const server = actual.serve(...args);
      served.push(server);
      return server;
    },
  };
});

const T0 = Date.UTC(2026, 8, 15, 0, 0, 0);

function flight(hex: string): Flight {
  return {
    hex,
    callsign: "ANA245",
    position: { lat: 35.88, lon: 139.93, altitudeBaroFt: 10000, onGround: false },
    isMlat: false,
    seenPosSec: 1,
    kind: "passenger",
    source: "adsblol",
  };
}

function fakeApp() {
  const positions = {
    calls: 0,
    async fetchNearby() {
      positions.calls += 1;
      return { flights: [flight("aaa111")], source: "adsblol" as const };
    },
  };
  return { app: createApp({ positions, now: () => T0 }), positions };
}

const started: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((s) => s.close()));
  served.length = 0;
});

describe("startServer", () => {
  it("port 0 で 127.0.0.1 に待ち受け、実 HTTP で /api/nearby に応答し、close() 後は接続できない", async () => {
    const { app, positions } = fakeApp();
    const server = await startServer({ app, port: 0 });
    started.push(server);

    // url は実際に割り当てられたポートを持つ
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const port = Number(new URL(server.url).port);
    expect(port).toBeGreaterThan(0);

    // 待ち受けアドレスは 127.0.0.1（hostname の既定値）
    expect(served).toHaveLength(1);
    expect(served[0]?.address()).toEqual({ address: "127.0.0.1", family: "IPv4", port });

    const ok = await fetch(`${server.url}/api/nearby?lat=35.87&lon=139.93`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toMatch(/^application\/json/);
    const okBody = (await ok.json()) as Record<string, unknown>;
    expect(okBody).toMatchObject({ updatedAt: new Date(T0).toISOString(), source: "adsblol", airportOps: [] });
    expect((okBody.flights as Flight[]).map((f) => f.hex)).toEqual(["aaa111"]);
    expect(positions.calls).toBe(1);

    const bad = await fetch(`${server.url}/api/nearby`);
    expect(bad.status).toBe(400);
    expect(bad.headers.get("content-type")).toMatch(/^application\/json/);
    const badBody = (await bad.json()) as Record<string, unknown>;
    expect(Object.keys(badBody)).toEqual(["error"]);
    expect(typeof badBody.error).toBe("string");
    expect(positions.calls).toBe(1);

    await server.close();
    await expect(fetch(`${server.url}/api/nearby?lat=35.87&lon=139.93`)).rejects.toThrow(TypeError);
    // 2 回目の close も同じく解決する
    await expect(server.close()).resolves.toBeUndefined();
  });

  it("使用中のポートを指定すると reject する", async () => {
    const { app } = fakeApp();
    const first = await startServer({ app, port: 0 });
    started.push(first);
    const port = Number(new URL(first.url).port);

    await expect(startServer({ app, port })).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});

describe("parsePortEnv", () => {
  it("未設定なら 3000", () => {
    expect(parsePortEnv(undefined)).toEqual({ ok: true, value: 3000 });
  });

  it.each([
    ["0", 0],
    ["3001", 3001],
    ["65535", 65535],
  ])("%s は %i", (raw, value) => {
    expect(parsePortEnv(raw)).toEqual({ ok: true, value });
  });

  it.each(["", "65536", "-1", "3000.5", "abc", " 3000", "3000 ", "1e3", "+3000", "0x10"])(
    "%j はエラー",
    (raw) => {
      const result = parsePortEnv(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("PORT");
    },
  );
});

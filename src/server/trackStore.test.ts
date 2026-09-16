import { describe, expect, it } from "vitest";
import type { Flight } from "../shared/types.ts";
import { createTrackStore } from "./trackStore.ts";
import type { TrackStoreOptions } from "./trackStore.ts";

const T0 = Date.UTC(2026, 8, 15, 0, 0, 0);
const MINUTE = 60_000;

type FlightOverrides = {
  lat?: number;
  lon?: number;
  altitudeBaroFt?: number | null;
  altitudeGeomFt?: number;
  seenPosSec?: number;
  kind?: Flight["kind"];
  callsign?: string;
};

function flight(hex: string, overrides: FlightOverrides = {}): Flight {
  const position: Flight["position"] = {
    lat: overrides.lat ?? 35.8,
    lon: overrides.lon ?? 139.9,
    altitudeBaroFt: overrides.altitudeBaroFt === undefined ? 10000 : overrides.altitudeBaroFt,
    onGround: false,
  };
  if (overrides.altitudeGeomFt !== undefined) position.altitudeGeomFt = overrides.altitudeGeomFt;
  return {
    hex,
    callsign: overrides.callsign ?? "ANA245",
    position,
    isMlat: false,
    seenPosSec: overrides.seenPosSec ?? 0,
    kind: overrides.kind ?? "passenger",
    source: "adsblol",
  };
}

function setup(options: Partial<Omit<TrackStoreOptions, "now">> = {}) {
  let time = T0;
  const store = createTrackStore({ now: () => time, ...options });
  return {
    store,
    now: () => time,
    advance(ms: number) {
      time += ms;
    },
    /** 現在時刻を取得時刻として記録する */
    recordNow(flights: Flight[]) {
      store.record(flights, time);
    },
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

describe("createTrackStore: 点の記録", () => {
  it("点の at は「取得時刻 − seenPosSec」、lat・lon は機体の位置", () => {
    const t = setup();
    t.store.record([flight("aaa111", { lat: 35.1, lon: 139.2, seenPosSec: 2.5 })], T0);
    expect(t.store.get("aaa111")?.points).toEqual([{ lat: 35.1, lon: 139.2, altitudeFt: 10000, at: iso(T0 - 2500) }]);
  });

  it("altitudeFt は altitudeGeomFt を優先し（0 も採用）、無ければ altitudeBaroFt、両方無ければ null", () => {
    const t = setup();
    t.recordNow([
      flight("aaa111", { altitudeGeomFt: 12000, altitudeBaroFt: 11000 }),
      flight("bbb222", { altitudeGeomFt: 0, altitudeBaroFt: 500 }),
      flight("ccc333", { altitudeBaroFt: 11000 }),
      flight("ddd444", { altitudeBaroFt: null }),
    ]);
    expect(t.store.get("aaa111")?.points[0]?.altitudeFt).toBe(12000);
    expect(t.store.get("bbb222")?.points[0]?.altitudeFt).toBe(0);
    expect(t.store.get("ccc333")?.points[0]?.altitudeFt).toBe(11000);
    expect(t.store.get("ddd444")?.points[0]?.altitudeFt).toBeNull();
  });

  it("直前の点と緯度・経度が同じなら積まない（高度・時刻が違っても）", () => {
    const t = setup();
    t.recordNow([flight("aaa111", { lat: 35, lon: 139, altitudeBaroFt: 10000 })]);
    t.advance(10_000);
    t.recordNow([flight("aaa111", { lat: 35, lon: 139, altitudeBaroFt: 9000 })]);
    t.advance(10_000);
    t.recordNow([flight("aaa111", { lat: 35, lon: 139.001 })]);

    expect(t.store.get("aaa111")?.points).toEqual([
      { lat: 35, lon: 139, altitudeFt: 10000, at: iso(T0) },
      { lat: 35, lon: 139.001, altitudeFt: 10000, at: iso(T0 + 20_000) },
    ]);
  });

  it("緯度だけ・経度だけが同じなら積む", () => {
    const t = setup();
    t.recordNow([flight("aaa111", { lat: 35, lon: 139 })]);
    t.advance(1000);
    t.recordNow([flight("aaa111", { lat: 35, lon: 139.1 })]);
    t.advance(1000);
    t.recordNow([flight("aaa111", { lat: 35.1, lon: 139.1 })]);
    expect(t.store.get("aaa111")?.points.map((p) => [p.lat, p.lon])).toEqual([
      [35, 139],
      [35, 139.1],
      [35.1, 139.1],
    ]);
  });

  it("点の時刻が直前の点の時刻と同じ・より前なら積まない", () => {
    const t = setup();
    t.store.record([flight("aaa111", { lat: 35, seenPosSec: 0 })], T0); // at = T0
    t.store.record([flight("aaa111", { lat: 35.1, seenPosSec: 5 })], T0 + 5000); // at = T0（同じ）
    t.store.record([flight("aaa111", { lat: 35.2, seenPosSec: 8 })], T0 + 6000); // at = T0 − 2000（前）
    t.store.record([flight("aaa111", { lat: 35.3, seenPosSec: 0 })], T0 + 7000); // at = T0 + 7000
    expect(t.store.get("aaa111")?.points.map((p) => [p.lat, p.at])).toEqual([
      [35, iso(T0)],
      [35.3, iso(T0 + 7000)],
    ]);
  });

  it("61 点目を積むと先頭の点が落ちて 60 点になる", () => {
    const t = setup();
    for (let i = 0; i < 60; i += 1) {
      t.recordNow([flight("aaa111", { lat: 35 + i / 1000 })]);
      t.advance(1000);
    }
    expect(t.store.get("aaa111")?.points).toHaveLength(60);
    expect(t.store.get("aaa111")?.points[0]?.lat).toBe(35);

    t.recordNow([flight("aaa111", { lat: 35.06 })]);
    const points = t.store.get("aaa111")?.points ?? [];
    expect(points).toHaveLength(60);
    expect(points[0]?.lat).toBe(35.001);
    expect(points[0]?.at).toBe(iso(T0 + 1000));
    expect(points.at(-1)?.lat).toBe(35.06);
  });

  it("maxPoints を指定するとその点数で頭打ちになる", () => {
    const t = setup({ maxPoints: 3 });
    for (let i = 0; i < 5; i += 1) {
      t.recordNow([flight("aaa111", { lat: 35 + i })]);
      t.advance(1000);
    }
    expect(t.store.get("aaa111")?.points.map((p) => p.lat)).toEqual([37, 38, 39]);
  });

  it("other は記録しない（passenger と cargo だけを記録する）", () => {
    const t = setup();
    t.recordNow([
      flight("aaa111", { kind: "passenger" }),
      flight("bbb222", { kind: "cargo" }),
      flight("ccc333", { kind: "other" }),
    ]);
    expect(t.store.get("aaa111")).toBeDefined();
    expect(t.store.get("bbb222")).toBeDefined();
    expect(t.store.get("ccc333")).toBeUndefined();
    expect(t.store.size()).toBe(2);
  });

  it("位置が変わらず点を積まなくても、最新の機体情報と fetchedAt は更新する", () => {
    const t = setup();
    t.recordNow([flight("aaa111", { lat: 35, lon: 139, seenPosSec: 1, callsign: "ANA245" })]);
    t.advance(5000);
    t.recordNow([flight("aaa111", { lat: 35, lon: 139, seenPosSec: 3, callsign: "ANA999", altitudeBaroFt: 8000 })]);

    const tracked = t.store.get("aaa111");
    expect(tracked?.fetchedAt).toBe(T0 + 5000);
    expect(tracked?.flight).toEqual(flight("aaa111", { lat: 35, lon: 139, seenPosSec: 3, callsign: "ANA999", altitudeBaroFt: 8000 }));
    expect(tracked?.points).toHaveLength(1);
  });

  it("点の時刻が直前以前で点を積まなくても、最新の機体情報は更新する", () => {
    const t = setup();
    t.store.record([flight("aaa111", { lat: 35, seenPosSec: 0 })], T0);
    t.store.record([flight("aaa111", { lat: 35.1, seenPosSec: 10 })], T0 + 5000);
    const tracked = t.store.get("aaa111");
    expect(tracked?.flight.position.lat).toBe(35.1);
    expect(tracked?.fetchedAt).toBe(T0 + 5000);
    expect(tracked?.points.map((p) => p.lat)).toEqual([35]);
  });

  it("保持している fetchedAt より前の記録では機体情報を更新しない", () => {
    const t = setup();
    t.store.record([flight("aaa111", { callsign: "NEW001" })], T0 + 5000);
    t.store.record([flight("aaa111", { callsign: "OLD001" })], T0);
    const tracked = t.store.get("aaa111");
    expect(tracked?.flight.callsign).toBe("NEW001");
    expect(tracked?.fetchedAt).toBe(T0 + 5000);
  });

  it("hex の大文字・小文字を区別しない", () => {
    const t = setup();
    t.recordNow([flight("ABC123")]);
    expect(t.store.get("abc123")?.flight.hex).toBe("ABC123");
    expect(t.store.get("ABC123")).toBeDefined();
    t.advance(1000);
    t.recordNow([flight("abc123", { lat: 36 })]);
    expect(t.store.size()).toBe(1);
    expect(t.store.get("abc123")?.points).toHaveLength(2);
  });

  it("seenPosSec が NaN の機体は点を積まず、例外も投げない（他の機体は記録する）", () => {
    const t = setup();
    expect(() => t.recordNow([flight("aaa111", { seenPosSec: Number.NaN }), flight("bbb222")])).not.toThrow();
    expect(t.store.get("aaa111")?.points).toEqual([]);
    expect(t.store.get("bbb222")?.points).toHaveLength(1);
  });
});

describe("createTrackStore: 期限（10 分）", () => {
  it("点の時刻から 10 分ちょうどの点は残し、10 分を超えた点を削除する", () => {
    const t = setup();
    t.recordNow([flight("aaa111", { lat: 35 })]); // at = T0
    t.advance(1000);
    t.recordNow([flight("aaa111", { lat: 35.1 })]); // at = T0 + 1000

    t.advance(10 * MINUTE - 1000); // now = T0 + 10 分
    expect(t.store.get("aaa111")?.points.map((p) => p.lat)).toEqual([35, 35.1]);

    t.advance(1); // now = T0 + 10 分 + 1ms
    expect(t.store.get("aaa111")?.points.map((p) => p.lat)).toEqual([35.1]);
  });

  it("点の期限は取得時刻ではなく点の時刻（取得時刻 − seenPosSec）で判定する", () => {
    const t = setup();
    t.store.record([flight("aaa111", { lat: 35, seenPosSec: 30 })], T0); // at = T0 − 30 秒
    t.advance(10 * MINUTE - 30_000);
    expect(t.store.get("aaa111")?.points).toHaveLength(1);
    t.advance(1);
    expect(t.store.get("aaa111")?.points).toEqual([]);
    // 機体は fetchedAt から 10 分以内なので残る
    expect(t.store.size()).toBe(1);
  });

  it("記録のたびに、直前より 10 分を超えて古い点を削除する", () => {
    const t = setup();
    t.recordNow([flight("aaa111", { lat: 35 })]);
    for (let i = 1; i <= 11; i += 1) {
      t.advance(MINUTE);
      t.recordNow([flight("aaa111", { lat: 35 + i / 10 })]);
    }
    // now = T0 + 11 分。T0 の点は 11 分前なので消え、T0 + 1 分の点（ちょうど 10 分）は残る
    const points = t.store.get("aaa111")?.points ?? [];
    expect(points[0]?.at).toBe(iso(T0 + MINUTE));
    expect(points).toHaveLength(11);
  });

  it("最新の fetchedAt から 10 分更新の無い機体を破棄する（ちょうど 10 分は残す）", () => {
    const t = setup();
    t.recordNow([flight("aaa111"), flight("bbb222")]);
    t.advance(MINUTE);
    t.recordNow([flight("bbb222", { lat: 36 })]);

    t.advance(9 * MINUTE); // aaa111 は 10 分ちょうど、bbb222 は 9 分
    expect(t.store.size()).toBe(2);
    expect(t.store.get("aaa111")).toBeDefined();

    t.advance(1);
    expect(t.store.size()).toBe(1);
    expect(t.store.get("aaa111")).toBeUndefined();
    expect(t.store.get("bbb222")).toBeDefined();

    t.advance(MINUTE);
    expect(t.store.get("bbb222")).toBeUndefined();
    expect(t.store.size()).toBe(0);
  });

  it("破棄された機体を再び記録すると、古い点を持たずに始まる", () => {
    const t = setup();
    t.recordNow([flight("aaa111", { lat: 35 })]);
    t.advance(10 * MINUTE + 1);
    t.recordNow([flight("aaa111", { lat: 36 })]);
    expect(t.store.get("aaa111")?.points.map((p) => p.lat)).toEqual([36]);
  });

  it("record でも他の機体の期限切れを掃除する", () => {
    const t = setup();
    t.recordNow([flight("aaa111")]);
    t.advance(10 * MINUTE + 1);
    t.recordNow([flight("bbb222")]);
    expect(t.store.size()).toBe(1);
  });

  it("maxAgeMs を指定するとその時間で期限を判定する", () => {
    const t = setup({ maxAgeMs: 1000 });
    t.recordNow([flight("aaa111")]);
    t.advance(1000);
    expect(t.store.size()).toBe(1);
    t.advance(1);
    expect(t.store.size()).toBe(0);
  });
});

describe("createTrackStore: get の戻り値", () => {
  it("戻り値の点・配列・機体を書き換えても内部状態は変わらない", () => {
    const t = setup();
    t.recordNow([flight("aaa111", { lat: 35 })]);
    t.advance(1000);
    t.recordNow([flight("aaa111", { lat: 35.1 })]);
    // 内部と共有していても検出できるよう、比較の基準は深いコピーで取る
    const before = structuredClone(t.store.get("aaa111"));

    const got = t.store.get("aaa111")!;
    got.points[0]!.lat = 0;
    got.points.push({ lat: 1, lon: 1, altitudeFt: null, at: iso(T0) });
    got.points.shift();
    got.flight.seenPosSec = 999;
    got.flight.position.lat = 0;
    got.fetchedAt = 0;

    expect(t.store.get("aaa111")).toEqual(before);
  });

  it("record に渡した機体を後から書き換えても内部状態は変わらない", () => {
    const t = setup();
    const input = flight("aaa111", { lat: 35 });
    t.recordNow([input]);
    input.position.lat = 0;
    input.seenPosSec = 999;
    expect(t.store.get("aaa111")?.flight).toEqual(flight("aaa111", { lat: 35 }));
  });

  it("保持していない hex は undefined", () => {
    const t = setup();
    expect(t.store.get("aaa111")).toBeUndefined();
    expect(t.store.size()).toBe(0);
  });
});

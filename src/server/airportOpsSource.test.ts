// 空港中心の取得と運用方向の保持（AC-P2-33 / 60〜62）。上流には接続せず、偽の位置取得・偽の時計で確かめる。
// 機体は滑走路端の座標を基準に**合成**する（estimate.test.ts と同じ作り方。実測の生値ではない）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LatLon, destinationPoint } from "../shared/geo.ts";
import type { Flight } from "../shared/types.ts";
import { AIRPORT_FETCH_RADIUS_NM, DEFAULT_AIRPORT_FETCH_TTL_MS, createAirportOpsSource } from "./airportOpsSource.ts";
import { TARGET_AIRPORTS } from "./data/airports.ts";
import type { RunwayEnd } from "./data/importRunways.ts";
import { RUNWAY_ENDS } from "./data/runways.ts";
import { AIRPORT_OPS_WINDOW_MS } from "./estimate/airportOps.ts";
import { runwayBearingDeg } from "./estimate/runway.ts";
import { UpstreamError } from "./providers/provider.ts";
import type { NearbyQuery, PositionFetchResult } from "./providers/provider.ts";

const T0 = Date.UTC(2026, 8, 16, 0, 0, 0);
const HANEDA = TARGET_AIRPORTS[0]!;
const NARITA = TARGET_AIRPORTS[1]!;

function endOf(icao: string, ident: string): RunwayEnd {
  const end = RUNWAY_ENDS.find((other) => other.icao === icao && other.ident === ident);
  if (!end) {
    throw new Error(`${icao} ${ident} が RUNWAY_ENDS に無い`);
  }
  return end;
}

/** 滑走路端の延長線上（進入側）に距離 km だけ離した点と、滑走路の真方位へ向かう進行方向 */
function approaching(end: RunwayEnd, distanceKm: number): { position: LatLon; trackDeg: number } {
  const bearing = runwayBearingDeg(end, RUNWAY_ENDS);
  if (bearing === undefined) {
    throw new Error(`${end.icao} ${end.ident} の対向端が無い`);
  }
  return { position: destinationPoint(end, bearing + 180, distanceKm), trackDeg: ((bearing % 360) + 360) % 360 };
}

type FlightOverrides = { seenPosSec?: number; kind?: Flight["kind"]; distanceKm?: number };

/** RJTT 22 へ進入中の機体（推定は「進入・RWY22」になる） */
function arrivingFlight(hex: string, end: RunwayEnd, overrides: FlightOverrides = {}): Flight {
  const { position, trackDeg } = approaching(end, overrides.distanceKm ?? 8);
  return {
    hex,
    callsign: "ANA245",
    position: { lat: position.lat, lon: position.lon, altitudeBaroFt: 2000, onGround: false },
    trackDeg,
    verticalRateFpm: -704,
    isMlat: false,
    seenPosSec: overrides.seenPosSec ?? 1,
    kind: overrides.kind ?? "passenger",
    source: "adsblol",
  };
}

/** 推定が付かない機体（進行方向・昇降率が無いので phase は不明） */
function unknownFlight(hex: string): Flight {
  return {
    hex,
    position: { lat: 35.86, lon: 139.9, altitudeBaroFt: 10000, onGround: false },
    isMlat: false,
    seenPosSec: 1,
    kind: "passenger",
    source: "adsblol",
  };
}

type Loader = (q: NearbyQuery) => Promise<PositionFetchResult>;

/** 呼び出しを記録する偽の位置取得。`impl` は途中で差し替えられる */
function fakePositions(impl: Loader = async () => ({ flights: [], source: "adsblol" })) {
  const fake = {
    queries: [] as NearbyQuery[],
    impl,
    fetchNearby(q: NearbyQuery): Promise<PositionFetchResult> {
      fake.queries.push(q);
      return fake.impl(q);
    },
  };
  return fake;
}

/** 呼び出しを記録する偽の航跡の保持 */
function fakeTracks() {
  const fake = {
    recorded: [] as { flights: Flight[]; fetchedAt: number }[],
    recordImpl: (): void => undefined,
    record(flights: readonly Flight[], fetchedAt: number): void {
      fake.recorded.push({ flights: [...flights], fetchedAt });
      fake.recordImpl();
    },
    get: () => undefined,
  };
  return fake;
}

/** 待っているマイクロタスクを流す */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

type SetupOptions = { positions?: ReturnType<typeof fakePositions>; tracks?: ReturnType<typeof fakeTracks> };

function setup(options: SetupOptions = {}) {
  let time = T0;
  const positions = options.positions ?? fakePositions();
  const tracks = options.tracks;
  const source = createAirportOpsSource({ positions, now: () => time, ...(tracks === undefined ? {} : { tracks }) });
  return {
    source,
    positions,
    advance(ms: number) {
      time += ms;
    },
    get now() {
      return time;
    },
  };
}

describe("createAirportOpsSource: 集計に流す範囲", () => {
  it("滑走路まで決まった進入機を記録し、current() で運用方向を返す（AC-P2-33）", () => {
    const t = setup();
    t.source.record([arrivingFlight("aaa111", endOf("RJTT", "22"))], T0);

    expect(t.source.current()).toEqual([
      {
        icao: "RJTT",
        landingRunways: ["22"],
        departingRunways: [],
        configLabel: "南風運用",
        basedOn: 1,
        updatedAt: new Date(T0).toISOString(),
      },
    ]);
  });

  it("記録が無ければ空配列", () => {
    expect(setup().source.current()).toEqual([]);
  });

  it("seenPosSec が 60 を超える機体は集計に入れない（60 ちょうどは入れる）", () => {
    const t = setup();
    t.source.record(
      [
        arrivingFlight("aaa111", endOf("RJAA", "34L"), { seenPosSec: 61 }),
        arrivingFlight("bbb222", endOf("RJTT", "22"), { seenPosSec: 60 }),
      ],
      T0,
    );

    // 60 秒超の機体（成田へ進入中）は入らず、60 秒ちょうどの機体（羽田へ進入中）だけが数えられる
    expect(t.source.current().map((ops) => [ops.icao, ops.landingRunways, ops.basedOn])).toEqual([
      ["RJTT", ["22"], 1],
    ]);
  });

  it("other（旅客機・貨物機以外）は集計に入れない", () => {
    const t = setup();
    t.source.record([arrivingFlight("aaa111", endOf("RJTT", "22"), { kind: "other" })], T0);
    expect(t.source.current()).toEqual([]);
  });

  it("貨物機は集計に入れる", () => {
    const t = setup();
    t.source.record([arrivingFlight("aaa111", endOf("RJTT", "22"), { kind: "cargo" })], T0);
    expect(t.source.current()).toHaveLength(1);
  });

  it("滑走路が決まらない機体（推定が付かない機体）は集計に入れない", () => {
    const t = setup();
    t.source.record([unknownFlight("aaa111")], T0);
    expect(t.source.current()).toEqual([]);
  });

  it("同じ機体が滑走路を変えたら最新の 1 件で上書きする（AC-P2-34）", () => {
    const t = setup();
    t.source.record([arrivingFlight("aaa111", endOf("RJTT", "34L"))], T0);
    t.advance(60_000);
    t.source.record([arrivingFlight("aaa111", endOf("RJTT", "22"))], t.now);

    const [ops] = t.source.current();
    expect(ops?.landingRunways).toEqual(["22"]);
    expect(ops?.basedOn).toBe(1);
  });

  it("hex の大文字・小文字は同じ機体として数える", () => {
    const t = setup();
    t.source.record([arrivingFlight("ABC123", endOf("RJTT", "22")), arrivingFlight("abc123", endOf("RJTT", "22"))], T0);
    expect(t.source.current()[0]?.basedOn).toBe(1);
  });

  it("10 分を超えた記録は集計から外れる（AC-P2-35）", () => {
    const t = setup();
    t.source.record([arrivingFlight("aaa111", endOf("RJTT", "22"))], T0);
    expect(t.source.current()).toHaveLength(1);

    t.advance(AIRPORT_OPS_WINDOW_MS);
    expect(t.source.current()).toHaveLength(1); // 10 分ちょうどは残す

    t.advance(1);
    expect(t.source.current()).toEqual([]);
  });
});

describe("createAirportOpsSource: 空港中心の取得（AC-P2-61）", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("1 回の refresh() で蹴るのは 1 空港だけで、半径 60NM の空港中心を渡す", async () => {
    const t = setup();
    t.source.refresh();
    await flush();

    expect(t.positions.queries).toEqual([
      { lat: HANEDA.lat, lon: HANEDA.lon, radiusNm: AIRPORT_FETCH_RADIUS_NM },
    ]);
  });

  it("refresh() は取得を待たない（取得が決着しなくても同期的に戻る）", () => {
    const t = setup({ positions: fakePositions(() => new Promise<PositionFetchResult>(() => undefined)) });
    t.source.refresh();
    expect(t.positions.queries).toHaveLength(1);
    expect(t.source.current()).toEqual([]);
  });

  it("取得中はもう 1 本蹴らない", async () => {
    let resolveFetch!: (value: PositionFetchResult) => void;
    const t = setup({
      positions: fakePositions(() => new Promise<PositionFetchResult>((resolve) => (resolveFetch = resolve))),
    });

    t.source.refresh();
    t.source.refresh();
    await flush();
    expect(t.positions.queries).toHaveLength(1);

    resolveFetch({ flights: [], source: "adsblol" });
    await flush();
    t.source.refresh();
    await flush();
    expect(t.positions.queries).toHaveLength(2);
  });

  it("続けて呼ぶと最も古い空港を順に取り、TTL 内の空港は取り直さない", async () => {
    const t = setup();

    t.source.refresh(); // 未取得の RJTT
    await flush();
    t.source.refresh(); // 未取得の RJAA
    await flush();
    expect(t.positions.queries.map((q) => q.lat)).toEqual([HANEDA.lat, NARITA.lat]);

    // どちらも TTL 内なので取らない
    t.advance(DEFAULT_AIRPORT_FETCH_TTL_MS);
    t.source.refresh();
    await flush();
    expect(t.positions.queries).toHaveLength(2);

    // TTL を超えたら、最終取得が最も古い RJTT から取り直す
    t.advance(1);
    t.source.refresh();
    await flush();
    t.source.refresh();
    await flush();
    expect(t.positions.queries.map((q) => q.lat)).toEqual([HANEDA.lat, NARITA.lat, HANEDA.lat, NARITA.lat]);
  });

  it("取得した機体を集計に流し、航跡にも記録する（spec §7.3）", async () => {
    const tracks = fakeTracks();
    const loaded = [arrivingFlight("aaa111", endOf("RJTT", "22")), unknownFlight("bbb222")];
    const t = setup({ positions: fakePositions(async () => ({ flights: loaded, source: "adsbfi" })), tracks });

    t.source.refresh();
    await flush();

    const [ops] = t.source.current();
    expect(ops?.icao).toBe("RJTT");
    expect(ops?.landingRunways).toEqual(["22"]);
    // 航跡には取得した全機体を渡す（記録する種類の絞り込みは trackStore 側が行う）
    expect(tracks.recorded).toEqual([{ flights: loaded, fetchedAt: T0 }]);
  });

  it("航跡の記録が例外を投げても集計は続け、例外を投げない", async () => {
    const tracks = fakeTracks();
    tracks.recordImpl = () => {
      throw new Error("record failed");
    };
    const t = setup({
      positions: fakePositions(async () => ({ flights: [arrivingFlight("aaa111", endOf("RJTT", "22"))], source: "adsblol" })),
      tracks,
    });

    t.source.refresh();
    await flush();
    expect(t.source.current()).toHaveLength(1);
    expect(consoleError).toHaveBeenCalled();
  });
});

describe("createAirportOpsSource: 取得の失敗（AC-P2-62）", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("取得が失敗しても例外を投げず、直前の集計値を保つ", async () => {
    const positions = fakePositions(() => Promise.reject(new UpstreamError("adsblol: HTTP 502", { status: 502 })));
    const t = setup({ positions });
    t.source.record([arrivingFlight("aaa111", endOf("RJTT", "22"))], T0);
    const before = t.source.current();

    t.source.refresh();
    await flush();

    expect(t.source.current()).toEqual(before);
    expect(consoleError).toHaveBeenCalled();
  });

  it("取得が同期で例外を投げても未処理の reject を残さない", async () => {
    const positions = fakePositions(() => {
      throw new Error("provider broken");
    });
    const t = setup({ positions });

    expect(() => t.source.refresh()).not.toThrow();
    await flush();
    expect(t.source.current()).toEqual([]);
    expect(consoleError).toHaveBeenCalled();
  });

  it("失敗した空港も TTL 分は間を空ける（続けて refresh しても取り直さない）", async () => {
    const positions = fakePositions(() => Promise.reject(new Error("down")));
    const t = setup({ positions });

    t.source.refresh(); // RJTT
    await flush();
    t.source.refresh(); // RJAA
    await flush();
    t.source.refresh(); // どちらも TTL 内
    await flush();
    expect(t.positions.queries).toHaveLength(2);

    t.advance(DEFAULT_AIRPORT_FETCH_TTL_MS + 1);
    t.source.refresh();
    await flush();
    expect(t.positions.queries).toHaveLength(3);
  });
});

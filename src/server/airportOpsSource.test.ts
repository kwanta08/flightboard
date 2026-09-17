// 空港中心の取得と運用方向の保持（AC-P2-33 / 60〜62）。上流には接続せず、偽の位置取得・偽の時計で確かめる。
// 機体は滑走路端の座標を基準に**合成**する（estimate.test.ts と同じ作り方。実測の生値ではない）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LatLon, destinationPoint } from "../shared/geo.ts";
import type { Flight } from "../shared/types.ts";
import type { RouteInfo } from "./adsbdb/enrichment.ts";
import { AIRPORT_FETCH_RADIUS_NM, DEFAULT_AIRPORT_FETCH_TTL_MS, createAirportOpsSource } from "./airportOpsSource.ts";
import { TARGET_AIRPORTS } from "./data/airports.ts";
import type { RunwayEnd } from "./data/importRunways.ts";
import { RUNWAY_ENDS, runwayEndsFor } from "./data/runways.ts";
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

/** 滑走路端から離陸方向へ distanceKm だけ離した点と、滑走路の真方位へ向かう進行方向 */
function departing(end: RunwayEnd, distanceKm: number): { position: LatLon; trackDeg: number } {
  const bearing = runwayBearingDeg(end, RUNWAY_ENDS);
  if (bearing === undefined) {
    throw new Error(`${end.icao} ${end.ident} の対向端が無い`);
  }
  return { position: destinationPoint(end, bearing, distanceKm), trackDeg: ((bearing % 360) + 360) % 360 };
}

/**
 * 離陸直後の航跡の 1 点（対向端の 1.0km 先・中心線上）。**滑走路上には置かない**
 * （地上滑走中の位置は航跡に入らないので、航跡の最初の点は「最初の空中の位置通報」になる）
 */
function justAirborne(end: RunwayEnd): LatLon {
  const bearing = runwayBearingDeg(end, RUNWAY_ENDS);
  if (bearing === undefined) {
    throw new Error(`${end.icao} ${end.ident} の対向端が無い`);
  }
  return destinationPoint(endOf(end.icao, end.oppositeIdent), bearing, 1);
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

/** その滑走路端を離陸した機体（推定は「出発・その滑走路」。並行の組なら航跡が無いと L/R まで決まらない） */
function departingFlight(hex: string, end: RunwayEnd, overrides: FlightOverrides = {}): Flight {
  const { position, trackDeg } = departing(end, overrides.distanceKm ?? 8);
  return {
    hex,
    callsign: "ANA245",
    position: { lat: position.lat, lon: position.lon, altitudeBaroFt: 2500, onGround: false },
    trackDeg,
    verticalRateFpm: 1500,
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

/**
 * 呼び出しを記録する偽の航跡の保持。`points` は `tracks` に渡した hex（小文字）の航跡を返し、
 * 無ければ空（＝航跡を持っていない機体）。本物と同じく大文字・小文字は区別しない
 */
function fakeTracks(points: Record<string, readonly LatLon[]> = {}) {
  const fake = {
    recorded: [] as { flights: Flight[]; fetchedAt: number }[],
    pointsLookups: [] as string[],
    recordImpl: (): void => undefined,
    record(flights: readonly Flight[], fetchedAt: number): void {
      fake.recorded.push({ flights: [...flights], fetchedAt });
      fake.recordImpl();
    },
    get: () => undefined,
    points(hex: string): readonly LatLon[] {
      fake.pointsLookups.push(hex);
      return points[hex.toLowerCase()] ?? [];
    },
  };
  return fake;
}

/** 待っているマイクロタスクを流す */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

type SetupOptions = {
  positions?: ReturnType<typeof fakePositions>;
  tracks?: ReturnType<typeof fakeTracks>;
  /** キャッシュ済みのルートの引き方（`composeApp` は `createApp` と同じ `enrichment.getRoute` を渡す） */
  getRoute?: (callsign: string) => RouteInfo | undefined;
};

function setup(options: SetupOptions = {}) {
  let time = T0;
  const positions = options.positions ?? fakePositions();
  const tracks = options.tracks;
  const { getRoute } = options;
  const source = createAirportOpsSource({
    positions,
    now: () => time,
    ...(tracks === undefined ? {} : { tracks }),
    ...(getRoute === undefined ? {} : { getRoute }),
  });
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

/**
 * W9 MAJOR-2: 集計の推定を `/api/nearby` の各行の `estimate` と同じ入力（キャッシュ済みの adsbdb ルート込み）で
 * 組み立てる。`getRoute` を渡さなければ従来どおり幾何だけで決まる。
 * 機体は `arrivingFlight`（コールサイン ANA245・幾何では RJTT 22 へ進入）を使う
 */
describe("createAirportOpsSource: 集計の推定に route を効かせる", () => {
  const HND = { icao: "RJTT", name: "Tokyo Haneda International Airport" };
  const FUK = { icao: "RJFF", name: "Fukuoka Airport" };
  /** 「羽田発」（幾何の「22 へ進入」と食い違う） */
  const DEPARTS_HANEDA: RouteInfo = { route: { origin: HND, destination: FUK, source: "adsbdb" } };
  /** 「羽田着」（幾何と一致する） */
  const ARRIVES_HANEDA: RouteInfo = { route: { origin: FUK, destination: HND, source: "adsbdb" } };

  function lookup(routes: Record<string, RouteInfo>) {
    const calls: string[] = [];
    return { calls, getRoute: (callsign: string): RouteInfo | undefined => (calls.push(callsign), routes[callsign]) };
  }

  it("route が幾何と食い違う機体は集計に入れない（行の estimate と同じ AC-P2-16 の規則）", () => {
    const { calls, getRoute } = lookup({ ANA245: DEPARTS_HANEDA });
    const t = setup({ getRoute });

    t.source.record([arrivingFlight("aaa111", endOf("RJTT", "22"))], T0);

    expect(calls).toEqual(["ANA245"]);
    expect(t.source.current()).toEqual([]);
  });

  it("route が幾何と一致すれば従来どおり数える", () => {
    const { getRoute } = lookup({ ANA245: ARRIVES_HANEDA });
    const t = setup({ getRoute });

    t.source.record([arrivingFlight("aaa111", endOf("RJTT", "22"))], T0);

    expect(t.source.current().map((ops) => [ops.icao, ops.landingRunways, ops.basedOn])).toEqual([["RJTT", ["22"], 1]]);
  });

  it("キャッシュに無いコールサインは従来どおり幾何だけで決まる（照会は増やさない）", () => {
    const { calls, getRoute } = lookup({});
    const t = setup({ getRoute });

    t.source.record([arrivingFlight("aaa111", endOf("RJTT", "22"))], T0);

    expect(calls).toEqual(["ANA245"]);
    expect(t.source.current()).toHaveLength(1);
  });

  it("getRoute を渡さなければ route を見ない（既定の挙動は変えない）", () => {
    const t = setup();
    t.source.record([arrivingFlight("aaa111", endOf("RJTT", "22"))], T0);
    expect(t.source.current()).toHaveLength(1);
  });

  /**
   * W10 MINOR-1: 機体が観測半径に入った時点でルートがまだキャッシュに無い（サーバー起動直後・adsbdb の 429 休止中・
   * ルート TTL 切れ直後）と、幾何だけで「RWY22 進入」と記録される。後からルートが届いて幾何と食い違ったら、
   * その記録は取り消す（残すと行は「出発・滑走路なし」なのに `airportOps` が 10 分間「南風運用」を出し続ける）
   */
  describe("ルートが後から届いたときの記録の取り消し", () => {
    it("route が幾何と食い違って滑走路が外れたら、それまでの記録を消す", () => {
      const routes: Record<string, RouteInfo> = {};
      const t = setup({ getRoute: (callsign) => routes[callsign] });

      // 1 回目: ルートが未キャッシュなので幾何だけで「RJTT 22 へ進入」として記録する
      t.source.record([arrivingFlight("aaa111", endOf("RJTT", "22"))], T0);
      expect(t.source.current().map((ops) => [ops.icao, ops.landingRunways, ops.basedOn])).toEqual([
        ["RJTT", ["22"], 1],
      ]);

      // 2 回目: adsbdb の応答（「羽田発」）が届いた後。行は「出発・滑走路なし」になるので集計からも外す
      routes.ANA245 = DEPARTS_HANEDA;
      t.advance(6000);
      t.source.record([arrivingFlight("aaa111", endOf("RJTT", "22"))], t.now);

      expect(t.source.current()).toEqual([]);
    });

    it("滑走路が決まらなかっただけ（進行方向が欠けた観測）では記録を消さない", () => {
      const routes: Record<string, RouteInfo> = {};
      const t = setup({ getRoute: (callsign) => routes[callsign] });

      t.source.record([arrivingFlight("aaa111", endOf("RJTT", "22"))], T0);
      expect(t.source.current()).toHaveLength(1);

      // route は届いたが、この観測は幾何が決まらない（trackDeg の欠け）。
      // 「食い違った」ことは分からないので、記録はそのまま残す（着陸後に feed から消えた機体を 10 分数える設計）
      routes.ANA245 = DEPARTS_HANEDA;
      const { trackDeg: _trackDeg, ...noTrack } = arrivingFlight("aaa111", endOf("RJTT", "22"));
      t.advance(6000);
      t.source.record([noTrack], t.now);

      expect(t.source.current().map((ops) => [ops.icao, ops.landingRunways, ops.basedOn])).toEqual([
        ["RJTT", ["22"], 1],
      ]);
    });

    it("古い取得の結果では新しい記録を消さない", () => {
      const routes: Record<string, RouteInfo> = {};
      const t = setup({ getRoute: (callsign) => routes[callsign] });

      t.advance(6000);
      t.source.record([arrivingFlight("aaa111", endOf("RJTT", "22"))], t.now);
      expect(t.source.current()).toHaveLength(1);

      // 記録より前に取った応答（遅れて決着した空港取得など）が食い違っても消さない
      routes.ANA245 = DEPARTS_HANEDA;
      t.source.record([arrivingFlight("aaa111", endOf("RJTT", "22"))], T0);

      expect(t.source.current()).toHaveLength(1);
    });
  });

  it("空港中心の取得で得た機体にも同じ規則を掛ける", async () => {
    const { getRoute } = lookup({ ANA245: DEPARTS_HANEDA });
    const positions = fakePositions(async (q) => ({
      flights: q.lat === HANEDA.lat ? [arrivingFlight("aaa111", endOf("RJTT", "22"))] : [],
      source: "adsblol",
    }));
    const t = setup({ positions, getRoute });

    t.source.refresh();
    await flush();

    expect(t.positions.queries).toHaveLength(1);
    expect(t.source.current()).toEqual([]);
  });
});

/**
 * AC-P3-11: **数字だけの推定（L/R 未判別）は運用方向の集計に入れない**。
 * 「滑走路まで決まった」の定義は「`runway` がその空港の滑走路端に実在する ident と一致する」で、
 * `"22"` は実在するので入り、`"16"`・`"34"` は実在しないので入らない（文字列の形では区別できない）。
 *
 * `record()` は 3 分岐にしてある。ident の判定を `decideRunway` / `toEntry` に畳むと、
 * 「route が幾何を否定した」と「L/R が未判別」が同じ undefined に潰れ、未判別の機体で `retract` が走る。
 */
describe("createAirportOpsSource: 集計に入れるのは滑走路まで決まった機体だけ（AC-P3-11）", () => {
  const NRT = { icao: "RJAA", name: "Narita International Airport" };
  const FUK = { icao: "RJFF", name: "Fukuoka Airport" };
  /** 「成田発」（幾何の「34R を離陸」と一致する） */
  const DEPARTS_NARITA: RouteInfo = { route: { origin: NRT, destination: FUK, source: "adsbdb" } };
  /** 「成田着」（幾何の「34R を離陸」と食い違う） */
  const ARRIVES_NARITA: RouteInfo = { route: { origin: FUK, destination: NRT, source: "adsbdb" } };

  const departingRunwaysOf = (source: ReturnType<typeof setup>["source"]) =>
    source.current().map((ops) => [ops.icao, ops.departingRunways, ops.basedOn]);

  it("航跡があれば並行滑走路の出発（成田 34R）が departingRunways に載る", () => {
    const end = endOf("RJAA", "34R");
    const withTracks = setup({ tracks: fakeTracks({ aaa111: [justAirborne(end)] }) });
    withTracks.source.record([departingFlight("aaa111", end)], T0);
    expect(departingRunwaysOf(withTracks.source)).toEqual([["RJAA", ["34R"], 1]]);

    // 対照: 航跡が無ければ推定は "34"（数字だけ）になり、集計には入らない
    const withoutTracks = setup();
    withoutTracks.source.record([departingFlight("aaa111", end)], T0);
    expect(withoutTracks.source.current()).toEqual([]);
  });

  it("L/R 未判別の機体は集計に入らず、それまでの記録も取り消さない", () => {
    // **route は幾何と一致する「成田発」にする**。`routeContradictsGeometry` は route が無いと
    // 早期に false を返すので、route を付けないと分岐を間違えても緑になってしまう
    const end = endOf("RJAA", "34R");
    const points: Record<string, readonly LatLon[]> = { aaa111: [justAirborne(end)] };
    const t = setup({ tracks: fakeTracks(points), getRoute: () => DEPARTS_NARITA });

    t.source.record([departingFlight("aaa111", end)], T0);
    expect(departingRunwaysOf(t.source)).toEqual([["RJAA", ["34R"], 1]]);

    // 航跡が落ちた（10 分窓・60 点の上限）後の観測。推定は "34" に落ちるが、記録は消さない
    delete points.aaa111;
    t.advance(6000);
    t.source.record([departingFlight("aaa111", end)], t.now);

    expect(departingRunwaysOf(t.source)).toEqual([["RJAA", ["34R"], 1]]);
  });

  it("route が幾何を否定した機体は取り消す（航跡を渡していても）", () => {
    const end = endOf("RJAA", "34R");
    const routes: Record<string, RouteInfo> = {};
    const t = setup({
      tracks: fakeTracks({ aaa111: [justAirborne(end)] }),
      getRoute: (callsign) => routes[callsign],
    });

    t.source.record([departingFlight("aaa111", end)], T0);
    expect(departingRunwaysOf(t.source)).toEqual([["RJAA", ["34R"], 1]]);

    // 後から届いた route は「成田着」。行の推定は「進入・滑走路なし」になるので集計からも消す
    routes.ANA245 = ARRIVES_NARITA;
    t.advance(6000);
    t.source.record([departingFlight("aaa111", end)], t.now);

    expect(t.source.current()).toEqual([]);
  });

  it("route が幾何を否定した機体は、L/R が未判別でも取り消す", () => {
    // 上のテストとの違いは「route が幾何と食い違う」ことだけ。取り消しの判定（`routeContradictsGeometry`）は
    // **route を外した推定**で見るので、ident の実在の判定を `decideRunway` に畳み込むと
    // route を外した側まで undefined になり、取り消しが効かなくなる（10 分間、実態と違う運用方向が残る）
    const end = endOf("RJAA", "34R");
    const points: Record<string, readonly LatLon[]> = { aaa111: [justAirborne(end)] };
    const routes: Record<string, RouteInfo> = {};
    const tracks = fakeTracks(points);
    const t = setup({ tracks, getRoute: (callsign) => routes[callsign] });

    t.source.record([departingFlight("aaa111", end)], T0);
    expect(departingRunwaysOf(t.source)).toEqual([["RJAA", ["34R"], 1]]);

    // 航跡が落ちて L/R が未判別になり、同時に「成田着」の route が届いた観測。
    // 幾何は「34R を離陸」と言っているので route がそれを否定しており、記録は取り消す
    delete points.aaa111;
    routes.ANA245 = ARRIVES_NARITA;
    t.advance(6000);
    t.source.record([departingFlight("aaa111", end)], t.now);

    expect(t.source.current()).toEqual([]);
    // 取り消しを通る機体でも、航跡を引くのは 1 回の record につき 1 回だけ
    // （`toEntry` と `retract` には同じ値を渡す。AC-P3-11）
    expect(tracks.pointsLookups).toEqual(["aaa111", "aaa111"]);
  });

  it("集計に出る滑走路はすべて、その空港の滑走路端に実在する ident", () => {
    const narita34R = endOf("RJAA", "34R");
    const tracks = fakeTracks({ ccc333: [justAirborne(narita34R)] });
    const t = setup({ tracks });
    t.source.record(
      [
        arrivingFlight("aaa111", endOf("RJTT", "22")), // 単独の組（そのまま "22"）
        arrivingFlight("bbb222", endOf("RJTT", "34L")), // 並行の組（進入は現在位置の横ずれで "34L"）
        departingFlight("ccc333", narita34R), // 並行の組（航跡があるので "34R"）
        departingFlight("ddd444", endOf("RJTT", "16R")), // 航跡が無いので "16" ＝集計に入らない
      ],
      T0,
    );

    const ops = t.source.current();
    expect(ops.length).toBeGreaterThan(0);
    for (const airport of ops) {
      const idents = runwayEndsFor(airport.icao).map((end) => end.ident);
      for (const runway of [...airport.landingRunways, ...airport.departingRunways]) {
        expect(idents).toContain(runway);
      }
    }
    // 数字だけに落ちた機体（ddd444）は基礎の機数に数えられていない
    expect(ops.map((airport) => [airport.icao, airport.landingRunways, airport.departingRunways, airport.basedOn])).toEqual([
      ["RJTT", ["22", "34L"], [], 2],
      ["RJAA", [], ["34R"], 1],
    ]);
    // 航跡は 1 機につき 1 回だけ引き、記録の判定と取り消しに同じ値を使う（AC-P3-11）
    expect(tracks.pointsLookups).toEqual(["aaa111", "bbb222", "ccc333", "ddd444"]);
  });
});

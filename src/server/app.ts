// BFF の HTTP アプリ（Hono）。ハンドラは配線だけにし、判断は純粋関数（selectFlights・parseNearbyParams など）に置く。
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { haversineKm } from "../shared/geo.ts";
import type { LatLon } from "../shared/geo.ts";
import type { AirportOps, ApiError, Flight, FlightDetailResponse, NearbyResponse } from "../shared/types.ts";
import { attachRoutes, isTrackedKind } from "./adsbdb/attachRoutes.ts";
import type { AttachRoutesResult } from "./adsbdb/attachRoutes.ts";
import type { Enrichment, RouteInfo } from "./adsbdb/enrichment.ts";
import type { AirportOpsSource } from "./airportOpsSource.ts";
import { buildEstimate } from "./estimate/estimate.ts";
import type { AircraftPhoto, PhotoSource } from "./photos/planespotters.ts";
import { parseNearbyParams } from "./nearbyParams.ts";
import { cacheKey, createPositionCache } from "./positionCache.ts";
import type { CachedPositions, PositionCache } from "./positionCache.ts";
import { MAX_SEEN_POS_SEC, UpstreamError } from "./providers/provider.ts";
import type { PositionSource } from "./providers/provider.ts";
import type { TrackedFlight, TrackStore } from "./trackStore.ts";

/** `GET /api/flights/:hex` の hex（小文字化した後に検証する） */
export const FLIGHT_HEX_PATTERN = /^~?[0-9a-f]{6}$/;

/**
 * `providers/provider.ts` の再エクスポート（互換のため残す）。
 * `MAX_SEEN_POS_SEC`（位置の最終受信からこの秒数を超えた機体は返さない。ちょうどは返す）は
 * 運用方向の集計（`airportOpsSource.ts`）とも共有するので、定義はそちらにある
 */
export { MAX_SEEN_POS_SEC };
export type { PositionSource };

/**
 * `adsbdb/attachRoutes.ts` の再エクスポート（互換のため残す）。
 * ルートの付与は運用方向の集計（`airportOpsSource.ts`）とも共有するので、定義はアプリより下の層にある
 * （集計が HTTP フレームワークを読み込まないようにする。W10 MINOR-2）
 */
export { attachRoutes };
export type { AttachRoutesResult };

/** アプリが使う adsbdb の付与（`adsbdb/enrichment.ts` の `Enrichment` の一部） */
export type AppEnrichment = Pick<Enrichment, "getRoute" | "enqueueRoutes" | "getAircraft">;

/** アプリが使う航跡の保持（`trackStore.ts` の `TrackStore` の一部） */
export type AppTracks = Pick<TrackStore, "record" | "get" | "points">;

/** アプリが使う運用方向の集計（`airportOpsSource.ts` の `AirportOpsSource`。型だけを参照する） */
export type AppAirportOps = Pick<AirportOpsSource, "current" | "record" | "refresh">;

export type AppOptions = {
  positions: PositionSource;
  /** 現在時刻（ms）。既定 `Date.now` */
  now?: () => number;
  /**
   * 位置のキャッシュ。既定は `createApp` が同じ `now` で作り、その `onLoaded` で `tracks.record` と `onPositionsLoaded` を呼ぶ。
   * 渡す場合は `createApp` と同じ `now` で作ること（経過秒の計算がずれるため）。`onPositionsLoaded`・`tracks` とは同時に指定できない
   */
  cache?: PositionCache;
  /**
   * 位置をキャッシュミスで取得して保存した直後に 1 回呼ぶ（既定のキャッシュの `onLoaded`。キャッシュヒット・共有した要求・失敗では呼ばない）。
   * `tracks` もあれば航跡の記録の後に呼ぶ。例外は握りつぶさず、その取得を待っている要求に伝わる。
   * `cache` と同時に指定すると `createApp` が `TypeError` を投げる
   */
  onPositionsLoaded?: (value: CachedPositions) => void;
  /**
   * adsbdb のルート・機体情報。あれば `/api/nearby` の旅客機・貨物機にキャッシュ済みのルートを付け、未取得のコールサインを積む（待たない）。
   * `/api/flights/:hex` ではルートに加えて機体情報を照会して付ける
   */
  enrichment?: AppEnrichment;
  /**
   * 機体写真の提供元（planespotters）。あれば `/api/flights/:hex` で照会し、`aircraft.photo` に付ける。
   * 照会は機体情報と並行して行い、失敗しても写真無しで返す
   */
  photos?: PhotoSource;
  /**
   * 航跡の保持。あれば位置をキャッシュミスで取得するたびに取得した全機体を `record` する（例外はログに出して握りつぶす）。
   * 無ければ `/api/flights/:hex` は常に 404。`cache` と同時に指定すると `createApp` が `TypeError` を投げる
   */
  tracks?: AppTracks;
  /**
   * 運用方向の集計と空港中心の取得（`airportOpsSource.ts`）。あれば位置をキャッシュミスで取得するたびに
   * 取得した全機体を `record` し、`/api/nearby` の処理中に `refresh()`（応答は待たせない）と `current()` を呼ぶ。
   * 無ければ `/api/nearby` の `airportOps` は常に空配列。`cache` と同時に指定すると `createApp` が `TypeError` を投げる。
   *
   * **`enrichment` と併せて使うときは、`createAirportOpsSource` にも同じ `getRoute` を渡すこと**
   * （渡さないと集計だけが route を見ない推定になり、同じ応答の `flights[].estimate` と食い違う。W9 MAJOR-2）
   */
  airportOps?: AppAirportOps;
  /**
   * ビルド済みクライアント（`dist/client`）のディレクトリ。指定したときだけ、`/api` と `/api/` 以下を除く GET に静的ファイルを配信する
   * （`/` は `index.html`、見つからなければ `text/plain` の 404）。未指定なら静的配信を登録せず、未定義のパスはすべて JSON の 404
   */
  staticRoot?: string;
};

export type SelectFlightsOptions = {
  /** 検索中心 */
  center: LatLon;
  /** この水平距離（km）以下の機体だけを返す */
  radiusKm: number;
  /** 返す種類 */
  kinds: ReadonlySet<Flight["kind"]>;
  /** 位置を取得してから応答時点までの経過秒。各機体の `seenPosSec` に足す */
  ageSec: number;
};

// 利用者向けのエラーメッセージ（上流の応答本文・URL・例外の中身は含めない）
const MESSAGE_UPSTREAM_FAILED = "位置情報の提供元から取得できませんでした。しばらくしてから再度お試しください";
const MESSAGE_INTERNAL_ERROR = "サーバー内部でエラーが発生しました";
const MESSAGE_NOT_FOUND = "指定された API は存在しません";
const MESSAGE_INVALID_HEX = "hex は 6 桁の 16 進（先頭に ~ を付けてもよい）で指定してください";
const MESSAGE_FLIGHT_NOT_FOUND = "指定された機体の情報はありません";
const MESSAGE_STATIC_NOT_FOUND = "ページが見つかりません";

/** API のパス（`/api` ちょうどと `/api/` で始まるパス）。静的配信せず、未定義なら JSON の 404 を返す */
function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

/**
 * 応答に載せる機体を作る（AC-A8・AC-A9）。入力の配列と機体オブジェクトは書き換えない。
 * 各機体を浅くコピーして `seenPosSec += ageSec` → `seenPosSec > 60` を除外 → `kinds` に無い種類を除外
 * → 検索中心からの水平距離が `radiusKm` を超える機体を除外 → 水平距離の昇順（同距離は hex の昇順）。
 * 浅いコピーなので、入れ子のオブジェクト（`position` など）は入力と共有する
 */
export function selectFlights(flights: readonly Flight[], options: SelectFlightsOptions): Flight[] {
  const { center, radiusKm, kinds, ageSec } = options;
  const selected: { flight: Flight; distanceKm: number }[] = [];

  for (const original of flights) {
    const flight: Flight = { ...original, seenPosSec: original.seenPosSec + ageSec };
    // 比較を否定形で書き、NaN も除外する
    if (!(flight.seenPosSec <= MAX_SEEN_POS_SEC)) continue;
    if (!kinds.has(flight.kind)) continue;
    const distanceKm = haversineKm(center, flight.position);
    if (!(distanceKm <= radiusKm)) continue;
    selected.push({ flight, distanceKm });
  }

  selected.sort((a, b) => a.distanceKm - b.distanceKm || compareCodeUnits(a.flight.hex, b.flight.hex));
  return selected.map((s) => s.flight);
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 各機体に経路の推定を付ける（AC-P2-40）。入力の配列と機体オブジェクトは書き換えない。
 * 滑走路データは静的なので、`airportOps` を指定していなくても付く。
 * 生成規則で推定が付かない機体（不明かつ滑走路なし）は入力と同じオブジェクトのまま。
 *
 * `getTrack` を渡すと各機体の航跡を引いて推定に渡す（並行滑走路の出発の L/C/R 判別。AC-P3-05）。
 * 渡さなければ航跡を使わない推定になる（出発の L/C/R は数字だけに落ちる）
 */
export function attachEstimates(flights: readonly Flight[], getTrack?: (hex: string) => readonly LatLon[]): Flight[] {
  return flights.map((flight) => withEstimate(flight, getTrack?.(flight.hex)));
}

/** 1 機に推定を付ける。`track` は**古い順**の航跡（省略可）。滑走路端・対象空港は既定のまま使う */
function withEstimate(flight: Flight, track?: readonly LatLon[]): Flight {
  const estimate = buildEstimate(flight, undefined, undefined, track);
  return estimate === undefined ? flight : { ...flight, estimate };
}

/**
 * 保持している機体を詳細 API で返せるか判定し、返す機体のコピーを作る（AC-A16・M2-3）。保持している値は書き換えない。
 * `seenPosSec` に保持してからの経過秒を足し、60 秒を超える・旅客機でも貨物機でもないなら undefined
 */
export function selectTrackedFlight(tracked: Pick<TrackedFlight, "flight">, ageSec: number): Flight | undefined {
  const flight: Flight = { ...tracked.flight, seenPosSec: tracked.flight.seenPosSec + ageSec };
  if (!(flight.seenPosSec <= MAX_SEEN_POS_SEC)) return undefined;
  if (!isTrackedKind(flight.kind)) return undefined;
  return flight;
}

/** 機体情報と写真を 1 つにまとめる（AC-A14・仕様 F-05）。どちらも無ければ undefined（`aircraft` を付けない） */
export function mergeAircraft(aircraft: Flight["aircraft"], photo: AircraftPhoto | undefined): Flight["aircraft"] | undefined {
  if (photo === undefined) return aircraft;
  return { ...aircraft, photo };
}

/** 取得時刻から応答時点までの経過秒。時計が戻った場合に負にならないよう 0 で下支えする */
function elapsedSec(now: number, fetchedAt: number): number {
  return Math.max(0, (now - fetchedAt) / 1000);
}

/** 詳細 API の応答。`updatedAt`・`track` は `flight` を作ったのと同じ保持値から取る */
function flightDetail(tracked: Pick<TrackedFlight, "fetchedAt" | "points">, flight: Flight): FlightDetailResponse {
  return { updatedAt: new Date(tracked.fetchedAt).toISOString(), flight, track: tracked.points };
}

export function createApp(options: AppOptions): Hono {
  const { positions, onPositionsLoaded, enrichment, photos, tracks, airportOps, staticRoot } = options;
  const now = options.now ?? Date.now;
  // 片方を黙って無視しないよう、同時指定は作成時に拒否する
  if (options.cache !== undefined && onPositionsLoaded !== undefined) {
    throw new TypeError("createApp: cache and onPositionsLoaded cannot be specified together");
  }
  if (options.cache !== undefined && tracks !== undefined) {
    throw new TypeError("createApp: cache and tracks cannot be specified together");
  }
  if (options.cache !== undefined && airportOps !== undefined) {
    throw new TypeError("createApp: cache and airportOps cannot be specified together");
  }

  const onLoaded =
    tracks === undefined && onPositionsLoaded === undefined && airportOps === undefined
      ? undefined
      : (value: CachedPositions): void => {
          if (tracks !== undefined) {
            // 航跡の記録に失敗しても位置の応答は返す（M-W5）
            try {
              tracks.record(value.flights, value.fetchedAt);
            } catch (error) {
              console.error("[BFF] 航跡の記録に失敗しました:", error);
            }
          }
          if (airportOps !== undefined) {
            // 観測取得の機体も運用方向の集計に流す（絞り込み前の全機体。plan の「運用方向の集計の設計」）。
            // ルート（adsbdb）は `airportOps` 側が同じ `getRoute` で付ける（`composeApp` の配線。W9 MAJOR-2）ので、
            // ここでは付けない（同じ機体に二度引かない）
            try {
              airportOps.record(value.flights, value.fetchedAt);
            } catch (error) {
              console.error("[BFF] 運用方向の集計に失敗しました:", error);
            }
          }
          onPositionsLoaded?.(value);
        };
  const cache = options.cache ?? createPositionCache({ now, onLoaded });

  /** 未取得のコールサインを積む。同期の例外で応答を失敗させない */
  function enqueueMissingRoutes(target: AppEnrichment, callsigns: readonly string[]): void {
    if (callsigns.length === 0) return;
    try {
      target.enqueueRoutes(callsigns);
    } catch (error) {
      console.error("[BFF] ルート照会の登録に失敗しました:", error);
    }
  }

  /**
   * 機体情報の照会を始め、決着を待つ Promise を返す。同期の例外・reject はログに出して undefined にする
   * （返す Promise は reject しないので、待つ前に応答が失敗しても未処理の reject を残さない）
   */
  function startAircraftLookup(target: AppEnrichment, hex: string): Promise<Flight["aircraft"]> {
    const onError = (error: unknown): undefined => {
      console.error("[GET /api/flights/:hex] 機体情報の取得に失敗しました:", error);
      return undefined;
    };
    try {
      return target.getAircraft(hex).catch(onError);
    } catch (error) {
      return Promise.resolve(onError(error));
    }
  }

  /** 写真の照会を始め、決着を待つ Promise を返す。同期の例外・reject はログに出して undefined にする */
  function startPhotoLookup(source: PhotoSource, hex: string): Promise<AircraftPhoto | undefined> {
    const onError = (error: unknown): undefined => {
      console.error("[GET /api/flights/:hex] 機体写真の取得に失敗しました:", error);
      return undefined;
    };
    try {
      return source.getPhoto(hex).catch(onError);
    } catch (error) {
      return Promise.resolve(onError(error));
    }
  }

  /** 空港中心の取得を蹴る（応答は待たせない。AC-P2-61）。同期の例外で応答を失敗させない */
  function startAirportOpsRefresh(target: AppAirportOps): void {
    try {
      target.refresh();
    } catch (error) {
      console.error("[GET /api/nearby] 空港中心の取得を始められませんでした:", error);
    }
  }

  /** 直近の運用方向。集計に失敗したときは空配列で返す（応答は 200 のまま。AC-P2-62） */
  function currentAirportOps(): AirportOps[] {
    if (airportOps === undefined) return [];
    try {
      return airportOps.current();
    } catch (error) {
      console.error("[GET /api/nearby] 運用方向の集計に失敗しました:", error);
      return [];
    }
  }

  /** 保持している機体を取り、応答時点の経過秒で判定する（M2-3）。保持していない・返せないなら undefined */
  function findTrackedFlight(hex: string): { tracked: TrackedFlight; flight: Flight } | undefined {
    const tracked = tracks?.get(hex);
    if (tracked === undefined) return undefined;
    const flight = selectTrackedFlight(tracked, elapsedSec(now(), tracked.fetchedAt));
    return flight === undefined ? undefined : { tracked, flight };
  }

  const app = new Hono();

  app.get("/api/nearby", async (c) => {
    const parsed = parseNearbyParams(c.req.query());
    if (!parsed.ok) {
      return c.json({ error: parsed.error } satisfies ApiError, 400);
    }
    const { lat, lon, radiusKm, radiusNm, kinds } = parsed.value;

    let loaded: CachedPositions;
    try {
      loaded = await cache.get(cacheKey(lat, lon, radiusNm), () => positions.fetchNearby({ lat, lon, radiusNm }));
    } catch (error) {
      if (!(error instanceof UpstreamError)) throw error; // app.onError で 500
      console.error(`[GET /api/nearby] 位置の取得に失敗しました: ${error.message}`);
      return c.json({ error: MESSAGE_UPSTREAM_FAILED } satisfies ApiError, 502);
    }

    const ageSec = elapsedSec(now(), loaded.fetchedAt);
    let flights = selectFlights(loaded.flights, { center: { lat, lon }, radiusKm, kinds, ageSec });
    if (enrichment !== undefined) {
      // キャッシュにあるルートだけを付け、無いものはバックグラウンドの照会に積む（adsbdb を待たない）
      const routed = attachRoutes(flights, (callsign) => enrichment.getRoute(callsign));
      flights = routed.flights;
      enqueueMissingRoutes(enrichment, routed.missingCallsigns);
    }
    // 推定は静的な滑走路データ（と保持している航跡）だけで決まるので、airportOps の指定に関わらず付ける（AC-P2-40）。
    // ルートを付けた後に呼び、route の裏付け（AC-P2-14）を使えるようにする。
    // 航跡があれば並行滑走路の出発でも L/C/R まで決まる（AC-P3-05。無ければ数字だけ）
    flights = attachEstimates(flights, tracks === undefined ? undefined : (hex) => tracks.points(hex));

    if (airportOps !== undefined) startAirportOpsRefresh(airportOps);

    const body: NearbyResponse = {
      updatedAt: new Date(loaded.fetchedAt).toISOString(),
      source: loaded.source,
      flights,
      airportOps: currentAirportOps(),
    };
    return c.json(body, 200);
  });

  app.get("/api/flights/:hex", async (c) => {
    const hex = c.req.param("hex").toLowerCase();
    if (!FLIGHT_HEX_PATTERN.test(hex)) {
      return c.json({ error: MESSAGE_INVALID_HEX } satisfies ApiError, 400);
    }

    const held = findTrackedFlight(hex);
    if (held === undefined) {
      return c.json({ error: MESSAGE_FLIGHT_NOT_FOUND } satisfies ApiError, 404);
    }
    if (enrichment === undefined && photos === undefined) {
      // 保持している航跡を推定に渡す（応答の `track` と同じ保持値。AC-P3-05）
      return c.json(flightDetail(held.tracked, withEstimate(held.flight, held.tracked.points)), 200);
    }

    // 機体情報・写真の照会を先に始めてから未取得のルートを積む（機体情報の照会をルート照会の後ろに並べない。AC-A14）
    const aircraftLookup = enrichment === undefined ? undefined : startAircraftLookup(enrichment, hex);
    const photoLookup = photos === undefined ? undefined : startPhotoLookup(photos, hex);
    const getRoute = (callsign: string): RouteInfo | undefined => enrichment?.getRoute(callsign);
    if (enrichment !== undefined) {
      enqueueMissingRoutes(enrichment, attachRoutes([held.flight], getRoute).missingCallsigns);
    }

    // 機体情報と写真は照会を待つ（並行）。失敗してもその部分を欠いたまま返す
    const [aircraft, photo] = await Promise.all([aircraftLookup, photoLookup]);

    // 待っている間に /api/nearby が同じ機体の新しい位置を記録していることがあるので、保持している値を取り直し、
    // 待っている間の経過を含めた応答時点の経過秒で判定し直す（M2-3）。ルートは取り直した機体に応答時点のキャッシュから付ける
    const latest = findTrackedFlight(hex);
    if (latest === undefined) {
      return c.json({ error: MESSAGE_FLIGHT_NOT_FOUND } satisfies ApiError, 404);
    }
    // 推定はルートを付けた後に組み立てる（route の裏付けを使う。AC-P2-54）
    let flight = withEstimate(attachRoutes([latest.flight], getRoute).flights[0]!, latest.tracked.points);
    const aircraftWithPhoto = mergeAircraft(aircraft, photo);
    if (aircraftWithPhoto !== undefined) flight = { ...flight, aircraft: aircraftWithPhoto };
    return c.json(flightDetail(latest.tracked, flight), 200);
  });

  if (staticRoot !== undefined) {
    // API のルートより後に登録し、/api/ 以下は同名のファイルがあっても静的配信しない（未定義なら notFound の JSON 404）
    const serveClient = serveStatic({ root: staticRoot });
    const serveClientOutsideApi: MiddlewareHandler = async (c, next) => {
      if (isApiPath(c.req.path)) {
        await next();
        return;
      }
      return serveClient(c, next);
    };
    app.get("*", serveClientOutsideApi);
  }

  // /api/ 以下と、静的配信しないときの未定義パスは JSON の ApiError。静的配信で見つからないパスは text/plain（M-A6）
  app.notFound((c) =>
    staticRoot !== undefined && !isApiPath(c.req.path)
      ? c.text(MESSAGE_STATIC_NOT_FOUND, 404)
      : c.json({ error: MESSAGE_NOT_FOUND } satisfies ApiError, 404),
  );

  app.onError((error, c) => {
    console.error("[BFF] 予期しないエラー:", error);
    return c.json({ error: MESSAGE_INTERNAL_ERROR } satisfies ApiError, 500);
  });

  return app;
}

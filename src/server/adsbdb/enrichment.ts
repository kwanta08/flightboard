// adsbdb のルート・機体情報のキャッシュと、ルート照会の順次キュー（AC-A13・AC-A14・AC-A16）。
// ルートは `/api/nearby` を待たせないようバックグラウンドの worker が 1 件ずつ照会する。
// 機体情報は呼び出し時に照会する（クライアントのゲートに直接並ぶので、積まれたルート照会より先に処理される）。
// adsbdb が HTTP 429 を返したら、待ち時間が過ぎるまでルート・機体情報とも照会を休止する（失敗としてキャッシュしない）。
// 休止に入るときはルート照会のキューを空にし、休止中は積まない（見えている機体は `/api/nearby` が毎ポーリング積み直すので、明けた後に積まれたものから照会する）。
import { UpstreamError } from "../providers/provider.ts";
import { rateLimitWaitMs } from "./client.ts";
import type { AdsbdbAircraft, AdsbdbAirline, AdsbdbClient, AdsbdbRoute } from "./client.ts";

export type RouteInfo = { airline?: AdsbdbAirline; route: AdsbdbRoute };

export type EnrichmentOptions = {
  client: AdsbdbClient;
  /** 現在時刻（ms） */
  now: () => number;
  /** ルートが見つかった／未知（404）のときの保持時間（既定 6 時間） */
  routeTtlMs?: number;
  /** 機体情報が見つかった／未知（404）のときの保持時間（既定 7 日） */
  aircraftTtlMs?: number;
  /** 通信失敗（照会が HTTP 429 以外の例外を投げた）ときの保持時間（既定 5 分） */
  errorTtlMs?: number;
  /** ルート照会の待ち行列の上限（照会中の 1 件は含まない。既定 500） */
  maxQueue?: number;
};

export type EnrichmentSizes = { routes: number; aircraft: number; queue: number };

export interface Enrichment {
  /** キャッシュだけを見る。見つかったルートが期限内のときだけ値を返す（未知・通信失敗・期限切れ・未照会は undefined） */
  getRoute(callsign: string): RouteInfo | undefined;
  /**
   * キャッシュに無いコールサインを順次キューに積み、照会の完了を待たずに戻る。
   * 期限内のキャッシュがある（結果を問わない）・キュー内・照会中・空文字のものは積まない。キューが上限なら以降は積まない。
   * adsbdb のレート制限（HTTP 429）で休止中は何も積まずに戻る（休止に入るときキューも空にする）。
   * 休止が明けた後の呼び出しで、渡されたものから積んで照会を再開する
   */
  enqueueRoutes(callsigns: Iterable<string>): void;
  /**
   * 期限内のキャッシュがあればそれを、無ければ照会して返す。未知・通信失敗は undefined（例外は投げない）。同じ hex の同時呼び出しは照会を共有する。
   * レート制限で休止中は照会せず undefined を返す（キャッシュもしない）
   */
  getAircraft(hex: string): Promise<AdsbdbAircraft | undefined>;
  /** 期限切れを掃除してから、保存しているエントリ数と待ち行列の長さを返す（照会中のものは数えない） */
  sizes(): EnrichmentSizes;
}

export const DEFAULT_ROUTE_TTL_MS = 6 * 3600_000;
export const DEFAULT_AIRCRAFT_TTL_MS = 7 * 86400_000;
export const DEFAULT_ERROR_TTL_MS = 5 * 60_000;
export const DEFAULT_MAX_QUEUE = 500;

type Outcome<T> = { kind: "found"; value: T } | { kind: "unknown" } | { kind: "failed" };

function isRateLimited(error: unknown): error is UpstreamError {
  return error instanceof UpstreamError && error.status === 429;
}

export function createEnrichment(options: EnrichmentOptions): Enrichment {
  const { client, now } = options;
  const routeTtlMs = options.routeTtlMs ?? DEFAULT_ROUTE_TTL_MS;
  const aircraftTtlMs = options.aircraftTtlMs ?? DEFAULT_AIRCRAFT_TTL_MS;
  const errorTtlMs = options.errorTtlMs ?? DEFAULT_ERROR_TTL_MS;
  const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;

  const routes = createExpiringStore<Outcome<RouteInfo>>();
  const aircraft = createExpiringStore<Outcome<AdsbdbAircraft>>();

  const queue: string[] = [];
  const queued = new Set<string>();
  let routeInFlight: string | undefined;
  let workerRunning = false;
  /** この時刻（ms）より前は adsbdb に照会しない（HTTP 429 で設定） */
  let pausedUntil: number | undefined;

  const aircraftInFlight = new Map<string, Promise<AdsbdbAircraft | undefined>>();

  function pruneAll(at: number): void {
    routes.prune(at);
    aircraft.prune(at);
  }

  function expiresAt(outcome: Outcome<unknown>, foundOrUnknownTtlMs: number): number {
    return now() + (outcome.kind === "failed" ? errorTtlMs : foundOrUnknownTtlMs);
  }

  function isPaused(at: number): boolean {
    return pausedUntil !== undefined && at < pausedUntil;
  }

  /**
   * 429 の待ち時間だけ休止する（休止中に別の 429 を受けても短くしない）。
   * キューは空にする（残すと、明けた後にもう見えていない機体の照会が、新しく見えた機体の照会の前に並ぶため）
   */
  function pause(error: UpstreamError): void {
    const until = now() + rateLimitWaitMs(error.retryAfterSec);
    pausedUntil = pausedUntil === undefined ? until : Math.max(pausedUntil, until);
    queue.length = 0;
    queued.clear();
  }

  /** 先頭から 1 件ずつ、照会の完了を待ってから次へ進む（全件を一度にゲートへ投入しない）。休止中は次へ進まずに終える */
  async function drainQueue(): Promise<void> {
    workerRunning = true;
    try {
      for (;;) {
        if (isPaused(now())) return;
        const callsign = queue.shift();
        if (callsign === undefined) return;
        queued.delete(callsign);
        routeInFlight = callsign;
        let outcome: Outcome<RouteInfo>;
        try {
          const result = await client.lookupRoute(callsign);
          outcome =
            result.status === "found"
              ? {
                  kind: "found",
                  value: result.airline === undefined ? { route: result.route } : { airline: result.airline, route: result.route },
                }
              : { kind: "unknown" };
        } catch (error) {
          if (isRateLimited(error)) {
            // 失敗としてキャッシュせず、キューにも戻さずに休止する（キューは pause が空にする。明けた後の enqueueRoutes で渡されたものから再開）
            pause(error);
            return;
          }
          // 429 以外は UpstreamError もそれ以外も通信失敗として短く保持し、worker は止めない
          outcome = { kind: "failed" };
        } finally {
          routeInFlight = undefined;
        }
        routes.set(callsign, outcome, expiresAt(outcome, routeTtlMs));
      }
    } finally {
      workerRunning = false;
    }
  }

  return {
    getRoute(callsign) {
      const at = now();
      pruneAll(at);
      const cached = routes.get(callsign, at);
      return cached?.kind === "found" ? cached.value : undefined;
    },

    enqueueRoutes(callsigns) {
      const at = now();
      pruneAll(at);
      // 休止中は積まない（タイマーは使わず、休止が明けた後の呼び出しで渡されたものから積んで起動する）
      if (isPaused(at)) return;
      for (const callsign of callsigns) {
        if (queue.length >= maxQueue) break;
        if (callsign === "" || queued.has(callsign) || callsign === routeInFlight) continue;
        if (routes.get(callsign, at) !== undefined) continue;
        queue.push(callsign);
        queued.add(callsign);
      }
      // 積み終えてから起動する（起動で先頭が抜けて上限に空きができても、同じ呼び出しでは積み足さない）
      if (!workerRunning && queue.length > 0) {
        void drainQueue().catch((error: unknown) => {
          console.error("[adsbdb] ルート照会の worker が例外で中断しました（次の enqueue で再開）:", error);
        });
      }
    },

    getAircraft(hex) {
      const at = now();
      pruneAll(at);
      const cached = aircraft.get(hex, at);
      if (cached !== undefined) return Promise.resolve(cached.kind === "found" ? cached.value : undefined);

      const pending = aircraftInFlight.get(hex);
      if (pending !== undefined) return pending;

      // 休止中は照会しない（失敗としてもキャッシュしない）
      if (isPaused(at)) return Promise.resolve(undefined);

      let lookup: ReturnType<AdsbdbClient["lookupAircraft"]>;
      try {
        // 同期で呼んでゲートに並ぶ（キューの worker が次のルート照会を並べるより前に）
        lookup = client.lookupAircraft(hex);
      } catch (error) {
        lookup = Promise.reject(error);
      }

      const settle = (outcome: Outcome<AdsbdbAircraft>): AdsbdbAircraft | undefined => {
        aircraftInFlight.delete(hex);
        aircraft.set(hex, outcome, expiresAt(outcome, aircraftTtlMs));
        return outcome.kind === "found" ? outcome.value : undefined;
      };
      const promise = lookup.then(
        (result) => settle(result.status === "found" ? { kind: "found", value: result.aircraft } : { kind: "unknown" }),
        (error: unknown) => {
          if (!isRateLimited(error)) return settle({ kind: "failed" });
          // 429 は失敗としてキャッシュせず休止する（明けた後の呼び出しで再照会する）
          aircraftInFlight.delete(hex);
          pause(error);
          return undefined;
        },
      );
      aircraftInFlight.set(hex, promise);
      return promise;
    },

    sizes() {
      pruneAll(now());
      return { routes: routes.size(), aircraft: aircraft.size(), queue: queue.length };
    },
  };
}

type ExpiringStore<V> = {
  /** 期限内（`at < expiresAt`）なら値、それ以外は undefined */
  get(key: string, at: number): V | undefined;
  set(key: string, value: V, expiresAt: number): void;
  /** 期限切れを削除する。最も早い期限より前なら何もしない（毎回の全件走査を避ける） */
  prune(at: number): void;
  size(): number;
};

function createExpiringStore<V>(): ExpiringStore<V> {
  const entries = new Map<string, { value: V; expiresAt: number }>();
  // 保存中のエントリの期限の下限（上書きで実際より早いままのことはあるが、遅くはならない）
  let earliestExpiresAt = Number.POSITIVE_INFINITY;

  return {
    get(key, at) {
      const entry = entries.get(key);
      return entry !== undefined && at < entry.expiresAt ? entry.value : undefined;
    },

    set(key, value, expiresAt) {
      entries.set(key, { value, expiresAt });
      earliestExpiresAt = Math.min(earliestExpiresAt, expiresAt);
    },

    prune(at) {
      if (at < earliestExpiresAt) return;
      let earliest = Number.POSITIVE_INFINITY;
      for (const [key, entry] of entries) {
        if (at >= entry.expiresAt) entries.delete(key);
        else earliest = Math.min(earliest, entry.expiresAt);
      }
      earliestExpiresAt = earliest;
    },

    size() {
      return entries.size;
    },
  };
}

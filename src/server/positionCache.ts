// 位置の取得結果の短期キャッシュ（AC-A11）。
// 同一キーは TTL 内ならキャッシュから返し、進行中の取得は共有する。失敗はキャッシュしない。
import { formatUpstreamCoord } from "./providers/provider.ts";
import type { PositionFetchResult } from "./providers/provider.ts";

/** `PositionFetchResult` の別名（互換のため残す） */
export type PositionLoadResult = PositionFetchResult;

export type CachedPositions = PositionFetchResult & {
  /** loader が解決した時点の `now()`（ms） */
  fetchedAt: number;
};

export type PositionLoader = () => Promise<PositionFetchResult>;

export type PositionCacheOptions = {
  /** キャッシュの有効時間（既定 5000ms）。`now() − fetchedAt < ttlMs` ならヒット */
  ttlMs?: number;
  /** 現在時刻（ms） */
  now: () => number;
  /**
   * loader で取得して保存した直後に 1 回呼ぶ（キャッシュヒット・共有した要求・失敗では呼ばない）。
   * 例外は握りつぶさず、その取得を待っている呼び出し側へ伝える（値は保存済み）
   */
  onLoaded?: (value: CachedPositions) => void;
};

export interface PositionCache {
  get(key: string, loader: PositionLoader): Promise<CachedPositions>;
  /**
   * 保存しているエントリ数を返す（進行中の取得は数えない）。
   * 期限切れの掃除は `get` が行う（`size()` は次の `get` までは期限切れも数える）
   */
  size(): number;
}

export const DEFAULT_POSITION_CACHE_TTL_MS = 5000;

/**
 * キャッシュキー。lat・lon を `formatUpstreamCoord` で小数 4 桁に丸め（readsb の URL の座標と同じ関数・表記。`-0` は `0`）、
 * `radiusNm` と連結する
 */
export function cacheKey(lat: number, lon: number, radiusNm: number): string {
  return `${formatUpstreamCoord(lat)},${formatUpstreamCoord(lon)},${radiusNm}`;
}

export function createPositionCache(options: PositionCacheOptions): PositionCache {
  const { now, onLoaded } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_POSITION_CACHE_TTL_MS;

  const entries = new Map<string, CachedPositions>();
  const inflight = new Map<string, Promise<CachedPositions>>();

  function isFresh(entry: CachedPositions, at: number): boolean {
    return at - entry.fetchedAt < ttlMs;
  }

  function pruneExpired(at: number): void {
    for (const [key, entry] of entries) {
      if (!isFresh(entry, at)) entries.delete(key);
    }
  }

  return {
    get(key, loader) {
      const at = now();
      pruneExpired(at);

      const cached = entries.get(key);
      if (cached !== undefined) return Promise.resolve(cached);

      const pending = inflight.get(key);
      if (pending !== undefined) return pending;

      // loader は次のマイクロタスクで呼ぶ。同期的に例外を投げる loader でも、
      // 進行中表への登録より先に後始末が走って表に残ることが無いようにするため
      const promise = Promise.resolve()
        .then(loader)
        .then(
          (result) => {
            inflight.delete(key);
            const value: CachedPositions = { flights: result.flights, source: result.source, fetchedAt: now() };
            entries.set(key, value);
            onLoaded?.(value);
            return value;
          },
          (error: unknown) => {
            inflight.delete(key);
            throw error;
          },
        );
      inflight.set(key, promise);
      return promise;
    },

    size() {
      return entries.size;
    },
  };
}

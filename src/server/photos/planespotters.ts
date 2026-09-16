// 機体写真の提供元（planespotters.net の公開 API）。撮影者名と写真ページのリンクを返す（仕様 §13・F-05）。
// adsbdb の写真（airport-data.com）は撮影者名が取れず、仕様 §13 の「撮影者のクレジットを表示する」を満たせないので使わない。
// 規約で User-Agent に連絡先（URL かメール）が必要（providers/provider.ts の USER_AGENT に入れている）。
// 詳細を開いたときだけ 1 機ずつ照会し、結果は hex ごとに保持する。HTTP 429 を受けたら待ち時間が過ぎるまで照会しない。
import { isRecord, nonEmptyString } from "../providers/normalize.ts";
import { fetchUpstreamJson, rateLimitWaitMs as upstreamRateLimitWaitMs, UpstreamError } from "../providers/provider.ts";
import type { FetchLike } from "../providers/provider.ts";

export const PLANESPOTTERS_BASE_URL = "https://api.planespotters.net";
export const DEFAULT_PHOTO_TIMEOUT_MS = 5000;
/** 見つかった／見つからなかったときの保持時間（既定 7 日） */
export const DEFAULT_PHOTO_TTL_MS = 7 * 86400_000;
/** 通信失敗のときの保持時間（既定 5 分） */
export const DEFAULT_PHOTO_ERROR_TTL_MS = 5 * 60_000;
/** HTTP 429 で待ち秒数が無いときに照会を止める時間 */
export const DEFAULT_PHOTO_RATE_LIMIT_MS = 60_000;
/** HTTP 429 で照会を止める時間の上限 */
export const MAX_PHOTO_RATE_LIMIT_MS = 86_400_000;

const LABEL = "planespotters";

/** 撮影者名（`credit`）と写真ページ（`link`）は必須。どちらかが欠ける写真は使わない（仕様 §13） */
export type AircraftPhoto = { url: string; thumbnailUrl?: string; credit: string; link: string };

export interface PhotoSource {
  /**
   * 機体写真を返す。見つからない・通信失敗・レート制限中は undefined（例外は投げない）。
   * 同じ hex の同時呼び出しは 1 回の照会を共有し、結果は保持する
   */
  getPhoto(hex: string): Promise<AircraftPhoto | undefined>;
}

export type PhotoSourceOptions = {
  fetch?: FetchLike;
  /** 現在時刻（ms）。保持期限とレート制限の期限の計算に使う */
  now: () => number;
  ttlMs?: number;
  errorTtlMs?: number;
  timeoutMs?: number;
  baseUrl?: string;
};

/** HTTP 429 で照会を止める時間（ms）。待ち秒数が無い・不正なら 60 秒、上限 1 日 */
export function rateLimitWaitMs(retryAfterSec: number | undefined): number {
  return upstreamRateLimitWaitMs(retryAfterSec, {
    defaultMs: DEFAULT_PHOTO_RATE_LIMIT_MS,
    maxMs: MAX_PHOTO_RATE_LIMIT_MS,
  });
}

/** http(s) の絶対 URL の文字列だけを採用する（null・空・他のスキームは undefined） */
export function httpUrl(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  if (text === undefined || !URL.canParse(text)) return undefined;
  const { protocol } = new URL(text);
  return protocol === "http:" || protocol === "https:" ? text : undefined;
}

/**
 * 応答から写真を 1 枚選ぶ。`photos` の先頭から、表示に使える最初の 1 枚。
 * 表示は `thumbnail_large`（無ければ `thumbnail`）、控えの小さい画像は `thumbnail`。
 * 撮影者名・写真ページのリンク・画像 URL のどれかが欠けるものは使わない
 */
export function parsePhoto(body: unknown): AircraftPhoto | undefined {
  const photos = isRecord(body) ? body.photos : undefined;
  if (!Array.isArray(photos)) return undefined;

  for (const raw of photos) {
    if (!isRecord(raw)) continue;
    const large = httpUrl(isRecord(raw.thumbnail_large) ? raw.thumbnail_large.src : undefined);
    const small = httpUrl(isRecord(raw.thumbnail) ? raw.thumbnail.src : undefined);
    const url = large ?? small;
    const credit = nonEmptyString(raw.photographer);
    const link = httpUrl(raw.link);
    if (url === undefined || credit === undefined || link === undefined) continue;
    const thumbnailUrl = small === undefined || small === url ? undefined : small;
    return { url, ...(thumbnailUrl === undefined ? {} : { thumbnailUrl }), credit, link };
  }
  return undefined;
}

export function createPhotoSource(options: PhotoSourceOptions): PhotoSource {
  const { now } = options;
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const ttlMs = options.ttlMs ?? DEFAULT_PHOTO_TTL_MS;
  const errorTtlMs = options.errorTtlMs ?? DEFAULT_PHOTO_ERROR_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PHOTO_TIMEOUT_MS;
  const baseUrl = (options.baseUrl ?? PLANESPOTTERS_BASE_URL).replace(/\/+$/, "");

  const cache = new Map<string, { photo: AircraftPhoto | undefined; expiresAt: number }>();
  const inFlight = new Map<string, Promise<AircraftPhoto | undefined>>();
  /** この時刻（ms）より前は照会しない（HTTP 429 で設定） */
  let pausedUntil: number | undefined;

  function remember(hex: string, photo: AircraftPhoto | undefined, ttl: number): void {
    cache.set(hex, { photo, expiresAt: now() + ttl });
  }

  return {
    getPhoto(hex) {
      // ICAO アドレスでない機体（先頭が ~）は写真を探さない
      if (hex.startsWith("~")) return Promise.resolve(undefined);

      const at = now();
      const cached = cache.get(hex);
      if (cached !== undefined && at < cached.expiresAt) return Promise.resolve(cached.photo);

      const pending = inFlight.get(hex);
      if (pending !== undefined) return pending;

      // レート制限中は照会せず、結果も保持しない（明けた後の呼び出しで照会する）
      if (pausedUntil !== undefined && at < pausedUntil) return Promise.resolve(undefined);

      const url = `${baseUrl}/pub/photos/hex/${encodeURIComponent(hex)}`;
      const promise = fetchUpstreamJson(url, { fetch: fetchImpl, timeoutMs, label: LABEL }).then(
        (body) => {
          inFlight.delete(hex);
          const photo = parsePhoto(body);
          remember(hex, photo, ttlMs);
          return photo;
        },
        (error: unknown) => {
          inFlight.delete(hex);
          if (error instanceof UpstreamError && error.status === 429) {
            const until = now() + rateLimitWaitMs(error.retryAfterSec);
            pausedUntil = pausedUntil === undefined ? until : Math.max(pausedUntil, until);
            console.error(`[${LABEL}] レート制限を受けました（写真の照会を止めます）`);
            return undefined;
          }
          if (error instanceof UpstreamError && error.status === 404) {
            remember(hex, undefined, ttlMs);
            return undefined;
          }
          console.error(`[${LABEL}] 機体写真の取得に失敗しました:`, error);
          remember(hex, undefined, errorTtlMs);
          return undefined;
        },
      );
      inFlight.set(hex, promise);
      return promise;
    },
  };
}

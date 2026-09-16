// 位置の提供元（adsb.lol / adsb.fi / OpenSky）の共通抽象と、上流 HTTP の共通処理。
import type { Flight } from "../../shared/types.ts";

/**
 * 上流に付ける User-Agent。
 * planespotters は規約で連絡先（URL かメール）を含むことを求めるので、リポジトリの URL を入れる（他の提供元にも同じものを送る）
 */
export const USER_AGENT = "flightboard/0.1 (+https://github.com/kwanta08/flightboard)";

/** 上流へ渡す検索条件。半径は海里（`kmToUpstreamNm` で換算済み） */
export type NearbyQuery = { lat: number; lon: number; radiusNm: number };

export interface PositionProvider {
  readonly id: Flight["source"];
  fetchNearby(q: NearbyQuery): Promise<Flight[]>;
}

/** 位置の取得結果（機体と、取得できた提供元）。フォールバックと位置キャッシュで共用 */
export type PositionFetchResult = { flights: Flight[]; source: Flight["source"] };

/** 位置の取得元（本番では 3 提供元のフォールバック）。`createApp` とフォールバックで共用 */
export type PositionSource = {
  fetchNearby(q: NearbyQuery): Promise<PositionFetchResult>;
};

/**
 * 上流 URL と位置キャッシュのキーに埋め込む座標の表記（両者の粒度を揃えるためここだけで定義する）。
 * 小数 4 桁に丸めて末尾の 0 を落とす。丸めた後の非 0 の絶対値は 1e-4 以上なので指数表記にならない。`-0` は `"0"` になる
 */
export function formatUpstreamCoord(value: number): string {
  return String(Number(value.toFixed(4)));
}

/** 注入可能な fetch。グローバル `fetch` はこの型に代入できる */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type UpstreamErrorOptions = { status?: number; retryAfterSec?: number; cause?: unknown };

/** 上流の失敗（ネットワーク / 非 2xx / タイムアウト / JSON 不正 / 形式不正）をすべてこれに包む */
export class UpstreamError extends Error {
  /** 非 2xx のときの HTTP ステータス。それ以外の失敗では未設定 */
  status?: number;
  /** HTTP 429 のときの待ち秒数（ヘッダーが 10 進の非負整数のときだけ） */
  retryAfterSec?: number;

  constructor(message: string, options: UpstreamErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "UpstreamError";
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfterSec !== undefined) this.retryAfterSec = options.retryAfterSec;
  }
}

/** 上流の半径上限（海里） */
export const MAX_UPSTREAM_NM = 250;

/** km → 上流へ渡す海里（切り上げ、250 で頭打ち） */
export function kmToUpstreamNm(km: number): number {
  return Math.min(Math.ceil(km / 1.852), MAX_UPSTREAM_NM);
}

const RETRY_AFTER_HEADERS = ["Retry-After", "X-Rate-Limit-Retry-After-Seconds"] as const;
const DECIMAL_NON_NEGATIVE_INT = /^\d+$/;

/**
 * 429 の待ち秒数を読む。`Retry-After` → `X-Rate-Limit-Retry-After-Seconds` の順に見て、
 * 値が 10 進の非負整数のものを最初に採用する。HTTP-date などは採用しない（無ければ undefined）
 */
export function parseRetryAfterSec(headers: Headers): number | undefined {
  for (const name of RETRY_AFTER_HEADERS) {
    const value = headers.get(name)?.trim();
    if (value === undefined || !DECIMAL_NON_NEGATIVE_INT.test(value)) continue;
    const sec = Number(value);
    if (Number.isFinite(sec)) return sec;
  }
  return undefined;
}

export type RateLimitWaitOptions = {
  /** 待ち秒数が無い・不正（有限の非負数でない）ときの待ち時間（ms） */
  defaultMs: number;
  /** 待ち時間の上限（ms） */
  maxMs: number;
};

/**
 * HTTP 429 で要求を送らない時間（ms）。位置の提供元のフォールバックと adsbdb のクライアントで共用する。
 * `retryAfterSec` が有限の非負数ならその秒数、そうでなければ `defaultMs`。どちらも `maxMs` で頭打ち
 */
export function rateLimitWaitMs(retryAfterSec: number | undefined, options: RateLimitWaitOptions): number {
  const waitMs =
    retryAfterSec !== undefined && Number.isFinite(retryAfterSec) && retryAfterSec >= 0
      ? retryAfterSec * 1000
      : options.defaultMs;
  return Math.min(waitMs, options.maxMs);
}

export type FetchUpstreamJsonOptions = {
  fetch: FetchLike;
  timeoutMs: number;
  /** エラーメッセージの接頭辞（提供元 id など） */
  label: string;
};

/**
 * 上流から JSON を取得する。`User-Agent` を付け、`timeoutMs` で打ち切る（本文の読み取りを含む）。
 * 失敗はすべて `UpstreamError`。非 2xx は `status`、429 は `retryAfterSec` も持つ
 */
export async function fetchUpstreamJson(url: string, options: FetchUpstreamJsonOptions): Promise<unknown> {
  const { fetch: fetchImpl, timeoutMs, label } = options;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new UpstreamError(`${label}: timed out after ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  const request = async (): Promise<unknown> => {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (cause) {
      throw new UpstreamError(`${label}: request failed`, { cause });
    }

    if (!res.ok) {
      const retryAfterSec = res.status === 429 ? parseRetryAfterSec(res.headers) : undefined;
      res.body?.cancel().catch(() => undefined);
      throw new UpstreamError(`${label}: HTTP ${res.status}`, { status: res.status, retryAfterSec });
    }

    let text: string;
    try {
      text = await res.text();
    } catch (cause) {
      throw new UpstreamError(`${label}: failed to read response body`, { cause });
    }

    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      throw new UpstreamError(`${label}: invalid JSON`, { cause });
    }
  };

  try {
    // fetch が signal を無視しても timeoutMs で必ず打ち切る
    return await Promise.race([request(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

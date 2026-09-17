// BFF の API クライアント（F-06・AC-B9・AC-B12）。`fetch` と中断用の `signal` は注入する（テストでは偽物を渡す）。
// 契約は src/shared/types.ts と README の「API」節（`GET /api/nearby`・`GET /api/flights/:hex`）。
import type { FlightDetailResponse, NearbyResponse } from "../../shared/types.ts";

/** 一覧で取得する機体の種類 */
export type NearbyKind = "passenger" | "cargo";

export type NearbyParams = {
  lat: number;
  lon: number;
  radiusKm: number;
  /** この順でカンマ区切りにして送る。空不可（サーバーが 400 を返すため。空なら `fetchNearby` は要求を送らずに失敗する） */
  kinds: ReadonlyArray<NearbyKind>;
};

/** API クライアントが使う `fetch`（`window.fetch` を包んで渡す） */
export type FetchLike = (input: string, init: { signal?: AbortSignal }) => Promise<Response>;

export type ApiRequestOptions = {
  fetch: FetchLike;
  signal?: AbortSignal;
};

/** クエリの数値の小数桁（緯度・経度で約 0.1m） */
const QUERY_FRACTION_DIGITS = 6;

// 利用者向けの既定の文言（応答ボディに `error` が無いとき）
const MESSAGE_NETWORK_ERROR = "サーバーに接続できませんでした";
const MESSAGE_INVALID_RESPONSE = "サーバーの応答を読み取れませんでした";
const MESSAGE_ABORTED = "要求を中断しました";
const MESSAGE_NO_KINDS = "表示する種類が選ばれていません";

function httpErrorMessage(status: number): string {
  return `サーバーから取得できませんでした（HTTP ${status}）`;
}

/** 要求の失敗（HTTP の非 2xx・ネットワーク失敗・応答の形が不正・送る前に分かる条件の不備）。中断はこれに包まない */
export class ApiRequestError extends Error {
  /** HTTP ステータス。応答を受け取れなかった（ネットワーク失敗・要求を送らなかった）なら undefined */
  readonly status?: number;

  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

/** 中断による例外か（`name === "AbortError"`） */
export function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

/** 中断を表す例外（`isAbortError` が true） */
function abortError(): DOMException {
  return new DOMException(MESSAGE_ABORTED, "AbortError");
}

/** `signal` が中断済みなら中断の例外を投げる（中断後に届いた応答を成功にも失敗にもしない） */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

/** 例外が中断によるもの（中断の例外、または中断済みの `signal`）なら、中断の例外として投げ直す */
function rethrowIfAborted(error: unknown, signal: AbortSignal | undefined): void {
  if (isAbortError(error)) throw error;
  throwIfAborted(signal);
}

/** 指数表記にならない 10 進表記（小数 6 桁で丸め、末尾の 0 を省く。`-0` は `0`） */
function formatQueryNumber(value: number): string {
  return String(Number(value.toFixed(QUERY_FRACTION_DIGITS)));
}

/** `GET /api/nearby` の URL */
export function nearbyUrl(params: NearbyParams): string {
  const lat = formatQueryNumber(params.lat);
  const lon = formatQueryNumber(params.lon);
  const radiusKm = formatQueryNumber(params.radiusKm);
  const kinds = params.kinds.join(",");
  return `/api/nearby?lat=${lat}&lon=${lon}&radiusKm=${radiusKm}&kinds=${kinds}`;
}

/**
 * 条件を値で比べるためのキー。同じ要求になる条件は同じキー、条件が無ければ undefined。
 * 要求の URL と同じ丸めを使う（送る要求が変わらない差では取り直さない）
 */
export function nearbyParamsKey(params: NearbyParams): string;
export function nearbyParamsKey(params: NearbyParams | undefined): string | undefined;
export function nearbyParamsKey(params: NearbyParams | undefined): string | undefined {
  return params === undefined ? undefined : nearbyUrl(params);
}

/** `GET /api/flights/:hex` の URL */
export function flightDetailUrl(hex: string): string {
  return `/api/flights/${encodeURIComponent(hex)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// `airportOps` もヘッダーの運用方向（AC-P2-52）で読むので、契約どおり配列であることを確かめる
// （型だけ合っていて実体が無い状態にしない）
function isNearbyResponse(body: unknown): body is NearbyResponse {
  return (
    isObject(body) &&
    typeof body.updatedAt === "string" &&
    Array.isArray(body.flights) &&
    Array.isArray(body.airportOps)
  );
}

function isFlightDetailResponse(body: unknown): body is FlightDetailResponse {
  return isObject(body) && typeof body.updatedAt === "string" && isObject(body.flight) && Array.isArray(body.track);
}

/** 要求を送る。ネットワーク失敗は `ApiRequestError`（status 無し）、中断は中断の例外 */
async function send(url: string, { fetch, signal }: ApiRequestOptions): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (error) {
    rethrowIfAborted(error, signal);
    throw new ApiRequestError(MESSAGE_NETWORK_ERROR, undefined, { cause: error });
  }
  throwIfAborted(signal);
  return response;
}

/** 非 2xx の応答を `ApiRequestError` にする。ボディの `error` が文字列ならそれを、読めなければ既定の文言を使う */
async function errorFromResponse(response: Response, signal: AbortSignal | undefined): Promise<ApiRequestError> {
  let message = httpErrorMessage(response.status);
  try {
    const body: unknown = await response.json();
    if (isObject(body) && typeof body.error === "string" && body.error.trim() !== "") {
      message = body.error;
    }
  } catch (error) {
    rethrowIfAborted(error, signal);
  }
  throwIfAborted(signal);
  return new ApiRequestError(message, response.status);
}

/** 2xx の応答ボディを読み、形を確かめる。JSON でない・形が違うなら `ApiRequestError`（status 付き） */
async function readBody<T>(
  response: Response,
  signal: AbortSignal | undefined,
  isValid: (body: unknown) => body is T,
): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    rethrowIfAborted(error, signal);
    throw new ApiRequestError(MESSAGE_INVALID_RESPONSE, response.status, { cause: error });
  }
  throwIfAborted(signal);
  if (!isValid(body)) {
    throw new ApiRequestError(MESSAGE_INVALID_RESPONSE, response.status);
  }
  return body;
}

/**
 * 周辺の機体を取得する（`GET /api/nearby`）。
 * `params.kinds` は空不可（サーバーが 400 を返すため）。空なら要求を送らず `ApiRequestError`（status 無し）で失敗する
 */
export async function fetchNearby(params: NearbyParams, options: ApiRequestOptions): Promise<NearbyResponse> {
  if (params.kinds.length === 0) {
    throw new ApiRequestError(MESSAGE_NO_KINDS);
  }
  const response = await send(nearbyUrl(params), options);
  if (!response.ok) {
    throw await errorFromResponse(response, options.signal);
  }
  return readBody(response, options.signal, isNearbyResponse);
}

/** 機体 1 機の詳細を取得する（`GET /api/flights/:hex`）。404 なら "not-found" */
export async function fetchFlightDetail(
  hex: string,
  options: ApiRequestOptions,
): Promise<FlightDetailResponse | "not-found"> {
  const response = await send(flightDetailUrl(hex), options);
  if (response.status === 404) {
    return "not-found";
  }
  if (!response.ok) {
    throw await errorFromResponse(response, options.signal);
  }
  return readBody(response, options.signal, isFlightDetailResponse);
}

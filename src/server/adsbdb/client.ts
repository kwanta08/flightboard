// adsbdb（https://www.adsbdb.com）のクライアント（AC-A13・AC-A14・AC-A16）。
// コールサインからルート、Mode-S の 16 進から機体情報を照会する。
// ルート・機体情報を合わせたすべての要求は FIFO のゲートを 1 本ずつ獲得してから送り、開始時刻を `minIntervalMs` 以上離す。
// HTTP 429 を受けたら、待ち時間（`Retry-After`。無ければ 60 秒、上限 1 日）が過ぎるまで要求を送らない（待ち時間 0 なら止めない）。
import type { Airport } from "../../shared/types.ts";
import { definedOnly, finiteNumber, isRecord, nonEmptyString } from "../providers/normalize.ts";
import { fetchUpstreamJson, rateLimitWaitMs as upstreamRateLimitWaitMs, UpstreamError } from "../providers/provider.ts";
import type { FetchLike } from "../providers/provider.ts";

export const ADSBDB_BASE_URL = "https://api.adsbdb.com";
export const DEFAULT_ADSBDB_MIN_INTERVAL_MS = 120;
export const DEFAULT_ADSBDB_TIMEOUT_MS = 5000;
/** HTTP 429 で待ち秒数が無いときに要求を送らない時間 */
export const DEFAULT_ADSBDB_RATE_LIMIT_MS = 60_000;
/** HTTP 429 で要求を送らない時間の上限 */
export const MAX_ADSBDB_RATE_LIMIT_MS = 86_400_000;
const LABEL = "adsbdb";

export type AdsbdbAirline = { icao: string; iata?: string; name: string };
export type AdsbdbRoute = { origin: Airport; destination: Airport; source: "adsbdb" };
/** 写真は撮影者名が取れないので adsbdb からは使わない（photos/planespotters.ts で取る。仕様 §13） */
export type AdsbdbAircraft = { model?: string };

/** `airline` は adsbdb が null・欠落を返したとき付けない（M2-1） */
export type RouteLookup = { status: "found"; airline?: AdsbdbAirline; route: AdsbdbRoute } | { status: "unknown" };
export type AircraftLookup = { status: "found"; aircraft: AdsbdbAircraft } | { status: "unknown" };

export interface AdsbdbClient {
  /**
   * 404 は `unknown`。それ以外の失敗は `UpstreamError`。
   * HTTP 429 の後、待ち時間が過ぎるまでは要求を送らず `UpstreamError`（`status: 429`、`retryAfterSec` は残り秒の切り上げ）を即座に投げる
   */
  lookupRoute(callsign: string): Promise<RouteLookup>;
  /**
   * `hex` が `~` で始まる（ICAO アドレスでない）なら要求を送らず `unknown`。404 は `unknown`、それ以外の失敗は `UpstreamError`。
   * レート制限中の扱いは `lookupRoute` と同じ
   */
  lookupAircraft(hex: string): Promise<AircraftLookup>;
}

export type AdsbdbClientOptions = {
  fetch?: FetchLike;
  /** 現在時刻（ms）。ゲートの間隔とレート制限の期限の計算に使う */
  now: () => number;
  /** 待機。ゲートの残り時間を待つのに使う */
  sleep: (ms: number) => Promise<void>;
  /** 要求の開始時刻の最小間隔（既定 120ms） */
  minIntervalMs?: number;
  /** 1 要求のタイムアウト（既定 5000ms。ゲートの待ちは含まない） */
  timeoutMs?: number;
  baseUrl?: string;
};

/** HTTP 429 で要求を送らない時間（ms）。待ち秒数が無い・不正なら 60 秒、上限 1 日（算出は providers/provider.ts の共通関数） */
export function rateLimitWaitMs(retryAfterSec: number | undefined): number {
  return upstreamRateLimitWaitMs(retryAfterSec, {
    defaultMs: DEFAULT_ADSBDB_RATE_LIMIT_MS,
    maxMs: MAX_ADSBDB_RATE_LIMIT_MS,
  });
}

export function createAdsbdbClient(options: AdsbdbClientOptions): AdsbdbClient {
  const { now } = options;
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_ADSBDB_TIMEOUT_MS;
  const baseUrl = (options.baseUrl ?? ADSBDB_BASE_URL).replace(/\/+$/, "");

  /**
   * この時刻（ms）より前は要求を送らない。429 で設定し、明けて最初の要求を送るときに消す。
   * 期限が過ぎても消すまでは残る（「再開」のログの判定に使う）ので、現在制限中かは期限と比べて判定する
   */
  let rateLimitedUntil: number | undefined;

  /** レート制限中なら、要求の代わりに投げる例外を返す */
  function rateLimitRejection(at: number): UpstreamError | undefined {
    if (rateLimitedUntil === undefined || at >= rateLimitedUntil) return undefined;
    const retryAfterSec = Math.ceil((rateLimitedUntil - at) / 1000);
    return new UpstreamError(`${LABEL}: rate limited (retry after ${retryAfterSec}s)`, { status: 429, retryAfterSec });
  }

  function recordRateLimit(error: UpstreamError): void {
    const waitMs = rateLimitWaitMs(error.retryAfterSec);
    // 待ち時間 0 は止めない（制限を記録せず、ログも出さない）
    if (waitMs <= 0) return;
    const at = now();
    const until = at + waitMs;
    if (rateLimitedUntil !== undefined && at < rateLimitedUntil) {
      // 制限中に、制限の前に送った要求の 429 が届いた場合。ログは重ねず、制限も短くしない
      rateLimitedUntil = Math.max(rateLimitedUntil, until);
      return;
    }
    // 制限していない（期限が過ぎた値が残っているだけの場合を含む）ところから制限を始める
    console.error(`[adsbdb] レート制限を受けました（${Math.ceil(waitMs / 1000)} 秒間照会を止めます）`);
    rateLimitedUntil = until;
  }

  const runGated = createStartGate({
    now,
    sleep: options.sleep,
    minIntervalMs: options.minIntervalMs ?? DEFAULT_ADSBDB_MIN_INTERVAL_MS,
    admit(at) {
      const rejection = rateLimitRejection(at);
      if (rejection !== undefined) throw rejection;
    },
  });

  /** ゲートを獲得した直後に呼ぶ。要求を送り、429 ならレート制限を記録する */
  async function send(url: string): Promise<unknown> {
    if (rateLimitedUntil !== undefined) {
      // ゲートの admit を通った直後なので、残っている制限は明けている（値は待ち時間が 0 より長い 429 でしか設定しないので、実際に制限していた）
      console.error("[adsbdb] レート制限が明けたので照会を再開します");
      rateLimitedUntil = undefined;
    }
    try {
      return await fetchUpstreamJson(url, { fetch: fetchImpl, timeoutMs, label: LABEL });
    } catch (error) {
      if (error instanceof UpstreamError && error.status === 429) recordRateLimit(error);
      throw error;
    }
  }

  /** ゲートを通して JSON を取得する。404 は undefined（JSON.parse は undefined を返さないので区別できる） */
  async function getJson(url: string): Promise<unknown> {
    // 制限中はゲートに並ばず即座に拒否する（開始時刻も消費しない）
    const rejection = rateLimitRejection(now());
    if (rejection !== undefined) throw rejection;
    try {
      return await runGated(() => send(url));
    } catch (error) {
      if (error instanceof UpstreamError && error.status === 404) return undefined;
      throw error;
    }
  }

  return {
    async lookupRoute(callsign) {
      const body = await getJson(`${baseUrl}/v0/callsign/${encodeURIComponent(callsign)}`);
      if (body === undefined) return { status: "unknown" };
      return parseRouteResponse(body);
    },

    async lookupAircraft(hex) {
      if (hex.startsWith("~")) return { status: "unknown" };
      const body = await getJson(`${baseUrl}/v0/aircraft/${encodeURIComponent(hex)}`);
      if (body === undefined) return { status: "unknown" };
      return parseAircraftResponse(body);
    },
  };
}

type StartGateOptions = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  minIntervalMs: number;
  /** 開始してよいか。待つ前と開始の直前に呼び、投げたら開始せずその例外で失敗させる（開始時刻は記録しない） */
  admit: (at: number) => void;
};

/**
 * FIFO のゲート。呼び出した順に 1 本ずつ獲得し、前の要求の開始時刻から `minIntervalMs` 未満なら残りを待ってから `task` を開始する。
 * ゲートは開始の時点で次へ渡す（前の要求の完了は待たない）。`task` の失敗と `admit` による拒否は後続の獲得を止めない
 */
function createStartGate(options: StartGateOptions): <T>(task: () => Promise<T>) => Promise<T> {
  const { now, sleep, minIntervalMs, admit } = options;
  let tail: Promise<unknown> = Promise.resolve();
  let lastStartAt: number | undefined;

  /**
   * 前の要求の開始から `minIntervalMs` 経つまで待つ。`sleep` が早く戻ったら残りを待ち直す。
   * 時計が戻っても 1 回の獲得で待つのは獲得から `minIntervalMs` まで。`sleep` の後に時計が進んでいなければ打ち切る（無限ループにしない）
   */
  async function waitForInterval(): Promise<void> {
    if (lastStartAt === undefined) return;
    let at = now();
    const readyAt = Math.min(lastStartAt + minIntervalMs, at + minIntervalMs);
    while (at < readyAt) {
      await sleep(readyAt - at);
      const after = now();
      if (after <= at) break;
      at = after;
    }
  }

  return <T>(task: () => Promise<T>): Promise<T> => {
    const started = tail.then(async () => {
      admit(now());
      await waitForInterval();
      const at = now();
      // 待っている間に制限を受けていたら開始しない
      admit(at);
      lastStartAt = at;
      // 開始時刻を記録した直後に開始する。包んで返し、ゲートが task の完了を待たないようにする
      return { running: task() };
    });
    tail = started.catch(() => undefined);
    return started.then(({ running }) => running);
  };
}

function malformed(detail: string): UpstreamError {
  return new UpstreamError(`${LABEL}: unexpected response shape (${detail})`);
}

function parseRouteResponse(body: unknown): RouteLookup {
  const response = isRecord(body) ? body.response : undefined;
  const flightroute = isRecord(response) ? response.flightroute : undefined;
  if (!isRecord(flightroute)) throw malformed("response.flightroute is missing");

  // `midpoint`（経由地）は Phase 1 では無視する（M2-1）
  const route: AdsbdbRoute = {
    origin: parseAirport(flightroute.origin, "origin"),
    destination: parseAirport(flightroute.destination, "destination"),
    source: "adsbdb",
  };
  const airline = parseAirline(flightroute.airline);
  return airline === undefined ? { status: "found", route } : { status: "found", airline, route };
}

/** 空港は `icao_code` と `name` が必須。無ければ応答の形が不正 */
function parseAirport(raw: unknown, field: "origin" | "destination"): Airport {
  if (!isRecord(raw)) throw malformed(`flightroute.${field} is missing`);
  const icao = nonEmptyString(raw.icao_code);
  const name = nonEmptyString(raw.name);
  if (icao === undefined) throw malformed(`flightroute.${field}.icao_code is missing`);
  if (name === undefined) throw malformed(`flightroute.${field}.name is missing`);
  return {
    icao,
    ...definedOnly({ iata: nonEmptyString(raw.iata_code) }),
    name,
    ...definedOnly({
      municipality: nonEmptyString(raw.municipality),
      lat: finiteNumber(raw.latitude),
      lon: finiteNumber(raw.longitude),
    }),
  };
}

/** 航空会社は null になりうる（M2-1）。null・欠落・`icao` か `name` の無いものは付けない */
function parseAirline(raw: unknown): AdsbdbAirline | undefined {
  if (!isRecord(raw)) return undefined;
  const icao = nonEmptyString(raw.icao);
  const name = nonEmptyString(raw.name);
  if (icao === undefined || name === undefined) return undefined;
  return { icao, ...definedOnly({ iata: nonEmptyString(raw.iata) }), name };
}

function parseAircraftResponse(body: unknown): AircraftLookup {
  const response = isRecord(body) ? body.response : undefined;
  const raw = isRecord(response) ? response.aircraft : undefined;
  if (!isRecord(raw)) throw malformed("response.aircraft is missing");

  const modelParts = [nonEmptyString(raw.manufacturer), nonEmptyString(raw.type)].filter(
    (part): part is string => part !== undefined,
  );
  return {
    status: "found",
    aircraft: definedOnly({ model: modelParts.length > 0 ? modelParts.join(" ") : undefined }),
  };
}

// 空港中心の取得と、運用方向の集計の保持（docs/spec.md §7.3 / AC-P2-33・60〜62）。
//
// タイマーを持たない**要求駆動**にしてある。`/api/nearby` の処理中に `refresh()` を呼ぶと、
// 最終取得から TTL（既定 30 秒）を超えた空港が 1 つだけ非同期に取得される（応答は待たせない。AC-P2-61）。
// こうすると停止処理・`unref` が要らず、`server.ts` の `close()` も変えずに済む。
// 位置の取得元は composeApp が作ったフォールバック提供元と**同じインスタンス**を共有する（429 の休止も共有する）。
import type { AirportOps, Flight } from "../shared/types.ts";
import { MAX_SEEN_POS_SEC } from "./app.ts";
import type { AppTracks } from "./app.ts";
import { TARGET_AIRPORTS } from "./data/airports.ts";
import type { TargetAirport } from "./data/airports.ts";
import type { RunwayEnd } from "./data/importRunways.ts";
import { RUNWAY_ENDS } from "./data/runways.ts";
import { AIRPORT_OPS_WINDOW_MS, aggregateAirportOps } from "./estimate/airportOps.ts";
import type { AirportOpsEntry } from "./estimate/airportOps.ts";
import { buildEstimate } from "./estimate/estimate.ts";
import type { PositionSource } from "./providers/provider.ts";

/** 空港中心の取得の半径（海里。spec §7.3 の表） */
export const AIRPORT_FETCH_RADIUS_NM = 60;

/** 同じ空港を取得し直す間隔（ms）。最終取得からこれを**超えて**いれば取得する */
export const DEFAULT_AIRPORT_FETCH_TTL_MS = 30_000;

export type AirportOpsSourceOptions = {
  /** 位置の取得元。観測点の取得と同じインスタンスを渡す（429 の休止状態を共有するため） */
  positions: PositionSource;
  /** 現在時刻（ms）。アプリ・航跡と同じものを渡す */
  now: () => number;
  /** 取得と集計の対象空港（既定 `TARGET_AIRPORTS`） */
  airports?: readonly TargetAirport[];
  /** 滑走路端（既定 `RUNWAY_ENDS`） */
  ends?: readonly RunwayEnd[];
  /** 同じ空港を取得し直す間隔（既定 30 秒） */
  ttlMs?: number;
  /** 空港中心の取得の半径（既定 60 海里） */
  radiusNm?: number;
  /**
   * 航跡の保持。あれば空港取得で得た機体も `record` する（spec §7.3 が空港取得の用途に「航跡の蓄積」を含むため）。
   * これで観測半径の外にいる機体でも `/api/flights/:hex` が引ける。例外はログに出して握りつぶす
   */
  tracks?: AppTracks;
};

export interface AirportOpsSource {
  /** 直近 10 分の記録から集計した運用方向（`/api/nearby` がそのまま返す） */
  current(): AirportOps[];
  /**
   * 取得した機体を集計に流す（観測取得・空港取得のどちらも通る）。
   * 旅客機・貨物機で `seenPosSec ≤ 60` のものだけを見て、滑走路まで決まった進入・出発を 1 hex 1 件で記録する
   */
  record(flights: readonly Flight[], fetchedAt: number): void;
  /**
   * 最終取得から TTL を超えた空港があれば 1 つだけ（最も古いもの）取得を始める。**待たない**。
   * 取得の失敗はログに出して握りつぶすので、直前の集計値がそのまま残る（AC-P2-62）
   */
  refresh(): void;
}

export function createAirportOpsSource(options: AirportOpsSourceOptions): AirportOpsSource {
  const { positions, now, tracks } = options;
  const airports = options.airports ?? TARGET_AIRPORTS;
  const ends = options.ends ?? RUNWAY_ENDS;
  const ttlMs = options.ttlMs ?? DEFAULT_AIRPORT_FETCH_TTL_MS;
  const radiusNm = options.radiusNm ?? AIRPORT_FETCH_RADIUS_NM;
  const icaos = airports.map((airport) => airport.icao);

  /** hex → 最新の 1 件（同じ機体が滑走路を変えたら上書きする。AC-P2-34） */
  const entries = new Map<string, AirportOpsEntry>();
  /** icao → 最後に取得を**始めた**時刻（ms）。失敗しても更新するので、失敗した空港も TTL 分は間を空ける */
  const startedAt = new Map<string, number>();
  /** 取得中の空港がある間は次を蹴らない（1 応答で蹴るのは最大 1 空港。AC-P2-61） */
  let fetching = false;

  /** 10 分窓から外れた記録を捨てる（保持を際限なく増やさない） */
  function prune(at: number): void {
    for (const [hex, entry] of entries) {
      if (!(at - entry.at <= AIRPORT_OPS_WINDOW_MS)) entries.delete(hex);
    }
  }

  function record(flights: readonly Flight[], fetchedAt: number): void {
    for (const flight of flights) {
      if (flight.kind !== "passenger" && flight.kind !== "cargo") continue;
      // 比較を否定形で書き、NaN も除外する（60 秒超の古い位置を集計に入れない）
      if (!(flight.seenPosSec <= MAX_SEEN_POS_SEC)) continue;
      const entry = toEntry(flight, fetchedAt);
      if (entry === undefined) continue;
      // 古い取得の結果で新しい記録を上書きしない
      const previous = entries.get(entry.hex);
      if (previous !== undefined && previous.at > entry.at) continue;
      entries.set(entry.hex, entry);
    }
    prune(now());
  }

  /** 滑走路まで決まった進入・出発なら記録にする。それ以外（滑走路なし・通過・不明）は集計に使わない */
  function toEntry(flight: Flight, at: number): AirportOpsEntry | undefined {
    const estimate = buildEstimate(flight, ends, airports);
    if (estimate === undefined) return undefined;
    if (estimate.phase !== "arrival" && estimate.phase !== "departure") return undefined;
    const { runway, airport } = estimate;
    if (runway === undefined || airport === undefined) return undefined;
    return { hex: flight.hex.toLowerCase(), icao: airport.icao, phase: estimate.phase, runway, at };
  }

  /** 次に取得する空港（最終取得が最も古く、TTL を超えているもの）。無ければ undefined */
  function dueAirport(at: number): TargetAirport | undefined {
    let due: { airport: TargetAirport; startedAt: number } | undefined;
    for (const airport of airports) {
      const started = startedAt.get(airport.icao);
      if (started !== undefined && at - started <= ttlMs) continue;
      // 一度も取得していない空港が最優先
      const last = started ?? Number.NEGATIVE_INFINITY;
      if (due === undefined || last < due.startedAt) due = { airport, startedAt: last };
    }
    return due?.airport;
  }

  /** 1 空港を取得し、航跡と集計に流す。失敗はログに出して握りつぶす（呼び出し側へ reject を残さない） */
  async function fetchAirport(airport: TargetAirport): Promise<void> {
    try {
      const result = await positions.fetchNearby({ lat: airport.lat, lon: airport.lon, radiusNm });
      const fetchedAt = now();
      if (tracks !== undefined) {
        try {
          tracks.record(result.flights, fetchedAt);
        } catch (error) {
          console.error(`[BFF] 空港中心の取得: 航跡の記録に失敗しました（${airport.icao}）:`, error);
        }
      }
      record(result.flights, fetchedAt);
    } catch (error) {
      console.error(`[BFF] 空港中心の取得に失敗しました（${airport.icao}）:`, error);
    }
  }

  return {
    current() {
      const at = now();
      prune(at);
      return aggregateAirportOps([...entries.values()], at, icaos);
    },

    record,

    refresh() {
      if (fetching) return;
      const at = now();
      const airport = dueAirport(at);
      if (airport === undefined) return;
      // 失敗しても TTL 分は間を空けるため、取得を始めた時刻で更新する
      startedAt.set(airport.icao, at);
      fetching = true;
      // 応答を待たせない（AC-P2-61）。fetchAirport は reject しないので未処理の reject を残さない
      void fetchAirport(airport).finally(() => {
        fetching = false;
      });
    },
  };
}

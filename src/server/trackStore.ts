// 機体ごとの航跡と最新の機体情報のメモリ上の保持（AC-A15）。`/api/flights/:hex`（AC-A16）が読む。
// 位置をキャッシュミスで取得するたびに `record` を呼ぶ。旅客機・貨物機（`passenger`/`cargo`）だけを記録する。
import type { Flight, TrackPoint } from "../shared/types.ts";

export type TrackStoreOptions = {
  /** 現在時刻（ms）。古い点・更新の無い機体の判定に使う */
  now: () => number;
  /** 点と機体の保持時間（既定 10 分）。経過がこれを**超えた**ら削除する（ちょうどは残す） */
  maxAgeMs?: number;
  /** 1 機あたりの点の上限（既定 60）。超えたら古い方から落とす */
  maxPoints?: number;
};

export type TrackedFlight = {
  /** 最後に記録した機体（記録時点の `seenPosSec` のまま） */
  flight: Flight;
  /** その機体を含む位置を取得した時刻（ms） */
  fetchedAt: number;
  /** 古い順の航跡 */
  points: TrackPoint[];
};

export interface TrackStore {
  /**
   * 取得した機体を記録する（`other` は記録しない）。
   * 点は「直前の点と緯度・経度が同じ」「時刻が直前の点の時刻以前」なら積まないが、機体情報はそのときも更新する。
   * `fetchedAt` が保持している値より前の記録では機体情報を更新しない
   */
  record(flights: readonly Flight[], fetchedAt: number): void;
  /** 期限切れを掃除してから返す。hex の大文字・小文字は区別しない。戻り値は内部状態のコピー */
  get(hex: string): TrackedFlight | undefined;
  /** 期限切れを掃除してから、保持している機体数を返す */
  size(): number;
}

export const DEFAULT_TRACK_MAX_AGE_MS = 10 * 60_000;
export const DEFAULT_TRACK_MAX_POINTS = 60;

/** 内部の点。時刻の比較は整数 ms（`at` の ISO 文字列と同じ精度）で行う */
type StoredPoint = { lat: number; lon: number; altitudeFt: number | null; atMs: number };

type Entry = { flight: Flight; fetchedAt: number; points: StoredPoint[] };

export function createTrackStore(options: TrackStoreOptions): TrackStore {
  const { now } = options;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_TRACK_MAX_AGE_MS;
  const maxPoints = options.maxPoints ?? DEFAULT_TRACK_MAX_POINTS;

  const entries = new Map<string, Entry>();

  function isTooOld(timeMs: number, at: number): boolean {
    return at - timeMs > maxAgeMs;
  }

  /** 更新の無い機体を破棄し、残った機体の古い点を先頭から落とす（点は時刻の昇順に並んでいる） */
  function prune(at: number): void {
    for (const [key, entry] of entries) {
      if (isTooOld(entry.fetchedAt, at)) {
        entries.delete(key);
        continue;
      }
      let drop = 0;
      while (drop < entry.points.length && isTooOld(entry.points[drop]!.atMs, at)) drop += 1;
      if (drop > 0) entry.points.splice(0, drop);
    }
  }

  function recordOne(original: Flight, fetchedAt: number): void {
    const key = original.hex.toLowerCase();
    // 呼び出し側の値と共有しないよう複製して持つ
    const flight = structuredClone(original);
    let entry = entries.get(key);
    if (entry === undefined) {
      entry = { flight, fetchedAt, points: [] };
      entries.set(key, entry);
    } else if (fetchedAt >= entry.fetchedAt) {
      entry.flight = flight;
      entry.fetchedAt = fetchedAt;
    }

    // Date の時刻値は整数 ms に切り捨てられる。非有限（seenPosSec が NaN など）なら点を積まない
    const atMs = new Date(fetchedAt - original.seenPosSec * 1000).getTime();
    if (!Number.isFinite(atMs)) return;
    const { lat, lon, altitudeGeomFt, altitudeBaroFt } = original.position;
    const last = entry.points.at(-1);
    if (last !== undefined && ((last.lat === lat && last.lon === lon) || atMs <= last.atMs)) return;

    entry.points.push({ lat, lon, altitudeFt: altitudeGeomFt ?? altitudeBaroFt ?? null, atMs });
    if (entry.points.length > maxPoints) entry.points.splice(0, entry.points.length - maxPoints);
  }

  return {
    record(flights, fetchedAt) {
      for (const flight of flights) {
        if (flight.kind === "passenger" || flight.kind === "cargo") recordOne(flight, fetchedAt);
      }
      prune(now());
    },

    get(hex) {
      prune(now());
      const entry = entries.get(hex.toLowerCase());
      if (entry === undefined) return undefined;
      return {
        flight: structuredClone(entry.flight),
        fetchedAt: entry.fetchedAt,
        points: entry.points.map(({ lat, lon, altitudeFt, atMs }) => ({
          lat,
          lon,
          altitudeFt,
          at: new Date(atMs).toISOString(),
        })),
      };
    },

    size() {
      prune(now());
      return entries.size;
    },
  };
}

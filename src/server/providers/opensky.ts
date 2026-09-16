// OpenSky Network（/api/states/all）の提供元と、その機体の正規化（docs/spec.md §8）。
import type { Flight } from "../../shared/types.ts";
import { EARTH_RADIUS_KM } from "../../shared/geo.ts";
import { classifyAircraft } from "../classify.ts";
import { definedOnly, finiteNumber, isRecord, nonEmptyString } from "./normalize.ts";
import { fetchUpstreamJson, formatUpstreamCoord, UpstreamError } from "./provider.ts";
import type { FetchLike, NearbyQuery, PositionProvider } from "./provider.ts";

export type OpenSkyProviderOptions = {
  fetch?: FetchLike;
  /** 1 要求のタイムアウト（既定 5000ms） */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 5000;
const OPENSKY_ID = "opensky";

export const OPENSKY_STATES_URL = "https://opensky-network.org/api/states/all";

/** 海里 → km */
const NM_TO_KM = 1.852;
const RAD_PER_DEG = Math.PI / 180;
const DEG_PER_RAD = 180 / Math.PI;
/**
 * 矩形の各辺を外側へ丸める桁（1e-4° ≒ 11m）。辺は球面（R=6371km）上の円の南北・東西の広がりそのもの
 * （`dLat = δ`、`dLon = asin(sin δ / cos φ)`）で、円周上の最も外側の点がちょうど辺に接するため、
 * 浮動小数点の誤差でその点がはみ出さないよう外側へ丸める。広がりは最大 1e-4°
 */
const BBOX_GRID = 1e4;

const M_PER_FT = 0.3048;
const MPS_TO_KT = 1.943844;
const MPS_TO_FPM = 196.850394;

/** `states[i]` の添字 */
const STATE = {
  icao24: 0,
  callsign: 1,
  timePosition: 3,
  longitude: 5,
  latitude: 6,
  baroAltitude: 7,
  onGround: 8,
  velocity: 9,
  trueTrack: 10,
  verticalRate: 11,
  geoAltitude: 13,
  squawk: 14,
  positionSource: 16,
} as const;

/** 状態ベクトルの最小の長さ（添字 0〜16） */
export const OPENSKY_STATE_LENGTH = 17;

/** OpenSky の `position_source` で MLAT を表す値 */
const POSITION_SOURCE_MLAT = 2;

export type OpenSkyBoundingBox = { lamin: number; lomin: number; lamax: number; lomax: number };

/**
 * 半径 `r = radiusNm × 1.852` km の円（R = 6371km の球面上）を内包する緯度経度の矩形。
 * 角距離 `δ = r / R`（ラジアン）、中心緯度 φ として `dLat = δ`。円が極を含む（`sin δ ≥ cos φ`）なら経度は -180〜180、
 * そうでなければ円の東西の広がり `dLon = asin(sin δ / cos φ)` を中心から足し引きする。
 * 各辺を小数 4 桁で外側へ丸めてから緯度 ±90・経度 ±180 に収める（日付変更線での折り返しはしない）
 */
export function openSkyBoundingBox(q: NearbyQuery): OpenSkyBoundingBox {
  const delta = (q.radiusNm * NM_TO_KM) / EARTH_RADIUS_KM;
  const dLat = delta * DEG_PER_RAD;
  const sinDelta = Math.sin(delta);
  const cosLat = Math.cos(q.lat * RAD_PER_DEG);

  const lamin = clamp(floorToGrid(q.lat - dLat), -90, 90);
  const lamax = clamp(ceilToGrid(q.lat + dLat), -90, 90);
  if (sinDelta >= cosLat) return { lamin, lomin: -180, lamax, lomax: 180 };

  const dLon = Math.asin(sinDelta / cosLat) * DEG_PER_RAD;
  return {
    lamin,
    lomin: clamp(floorToGrid(q.lon - dLon), -180, 180),
    lamax,
    lomax: clamp(ceilToGrid(q.lon + dLon), -180, 180),
  };
}

export function openSkyUrl(q: NearbyQuery): string {
  const box = openSkyBoundingBox(q);
  // 各辺は既に小数 4 桁の格子上なので、formatUpstreamCoord は表記を readsb の URL と揃えるだけ（値は変わらない）
  const params = new URLSearchParams({
    lamin: formatUpstreamCoord(box.lamin),
    lomin: formatUpstreamCoord(box.lomin),
    lamax: formatUpstreamCoord(box.lamax),
    lomax: formatUpstreamCoord(box.lomax),
  });
  return `${OPENSKY_STATES_URL}?${params.toString()}`;
}

export function createOpenSkyProvider(options: OpenSkyProviderOptions = {}): PositionProvider {
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    id: OPENSKY_ID,
    async fetchNearby(q) {
      const body = await fetchUpstreamJson(openSkyUrl(q), { fetch: fetchImpl, timeoutMs, label: OPENSKY_ID });
      const { timeSec, states } = openSkyStates(body);
      const flights: Flight[] = [];
      for (const row of states) {
        const flight = normalizeOpenSkyState(row, timeSec);
        if (flight !== null) flights.push(flight);
      }
      return flights;
    },
  };
}

/**
 * 応答から応答時刻（秒）と状態ベクトルの配列を取り出す。`states` が null・欠落なら 0 機。
 * 応答がオブジェクトでない・`states` が配列以外・（機体があるのに）`time` が数値でない場合は `UpstreamError`
 */
export function openSkyStates(body: unknown): { timeSec: number; states: unknown[] } {
  if (!isRecord(body)) throw new UpstreamError(`${OPENSKY_ID}: response is not a JSON object`);

  const states = body.states;
  if (states === undefined || states === null) return { timeSec: 0, states: [] };
  if (!Array.isArray(states)) throw new UpstreamError(`${OPENSKY_ID}: "states" is not an array`);
  if (states.length === 0) return { timeSec: 0, states: [] };

  const timeSec = finiteNumber(body.time);
  if (timeSec === undefined) throw new UpstreamError(`${OPENSKY_ID}: "time" is not a number`);
  return { timeSec, states };
}

/**
 * OpenSky の状態ベクトル 1 件を `Flight` に正規化する。配列でない・長さが足りない・hex が文字列でない（空文字を含む）・
 * 位置や位置の受信時刻が無い機体と、§10.1 で除外（地上）となる機体は null。値が無い欄はオブジェクトに含めない
 */
export function normalizeOpenSkyState(row: unknown, responseTimeSec: number): Flight | null {
  if (!Array.isArray(row) || row.length < OPENSKY_STATE_LENGTH) return null;

  const hex: unknown = row[STATE.icao24];
  if (typeof hex !== "string" || hex === "") return null;

  const lat = finiteNumber(row[STATE.latitude]);
  const lon = finiteNumber(row[STATE.longitude]);
  if (lat === undefined || lon === undefined) return null;

  const timePosition = finiteNumber(row[STATE.timePosition]);
  if (timePosition === undefined) return null;
  const seenPosSec = Math.max(0, responseTimeSec - timePosition);

  const onGround = row[STATE.onGround] === true;
  const callsign = nonEmptyString(row[STATE.callsign]);

  // OpenSky には dbFlags・機種コードが無い
  const kind = classifyAircraft({ callsign, onGround });
  if (kind === "excluded") return null;

  const baroM = finiteNumber(row[STATE.baroAltitude]);
  const geoM = finiteNumber(row[STATE.geoAltitude]);
  const velocity = finiteNumber(row[STATE.velocity]);
  const verticalRate = finiteNumber(row[STATE.verticalRate]);

  return {
    hex,
    ...definedOnly({ callsign }),
    position: {
      lat,
      lon,
      altitudeBaroFt: baroM === undefined ? null : baroM / M_PER_FT,
      ...definedOnly({ altitudeGeomFt: geoM === undefined ? undefined : geoM / M_PER_FT }),
      onGround,
    },
    ...definedOnly({
      groundSpeedKt: velocity === undefined ? undefined : velocity * MPS_TO_KT,
      trackDeg: finiteNumber(row[STATE.trueTrack]),
      verticalRateFpm: verticalRate === undefined ? undefined : verticalRate * MPS_TO_FPM,
      squawk: nonEmptyString(row[STATE.squawk]),
    }),
    isMlat: row[STATE.positionSource] === POSITION_SOURCE_MLAT,
    seenPosSec,
    kind,
    source: OPENSKY_ID,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function floorToGrid(value: number): number {
  return Math.floor(value * BBOX_GRID) / BBOX_GRID;
}

function ceilToGrid(value: number): number {
  return Math.ceil(value * BBOX_GRID) / BBOX_GRID;
}

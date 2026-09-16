// readsb 形式の提供元（adsb.lol v2 / adsb.fi v3）と、その機体の正規化（docs/spec.md §8）。
import type { Flight } from "../../shared/types.ts";
import { classifyAircraft } from "../classify.ts";
import { definedOnly, finiteNumber, isRecord, nonEmptyString } from "./normalize.ts";
import { fetchUpstreamJson, formatUpstreamCoord, UpstreamError } from "./provider.ts";
import type { FetchLike, NearbyQuery, PositionProvider } from "./provider.ts";

export type ReadsbSource = "adsblol" | "adsbfi";

export type ReadsbProviderOptions = {
  fetch?: FetchLike;
  /** 1 要求のタイムアウト（既定 5000ms） */
  timeoutMs?: number;
};

export const DEFAULT_TIMEOUT_MS = 5000;

// URL の座標は `formatUpstreamCoord` で小数 4 桁に丸めて埋め込む（位置キャッシュのキーと同じ表記）
export function adsbLolUrl(q: NearbyQuery): string {
  return `https://api.adsb.lol/v2/point/${formatUpstreamCoord(q.lat)}/${formatUpstreamCoord(q.lon)}/${q.radiusNm}`;
}

export function adsbFiUrl(q: NearbyQuery): string {
  return `https://opendata.adsb.fi/api/v3/lat/${formatUpstreamCoord(q.lat)}/lon/${formatUpstreamCoord(q.lon)}/dist/${q.radiusNm}`;
}

export function createAdsbLolProvider(options: ReadsbProviderOptions = {}): PositionProvider {
  return createReadsbProvider("adsblol", adsbLolUrl, options);
}

export function createAdsbFiProvider(options: ReadsbProviderOptions = {}): PositionProvider {
  return createReadsbProvider("adsbfi", adsbFiUrl, options);
}

function createReadsbProvider(
  id: ReadsbSource,
  buildUrl: (q: NearbyQuery) => string,
  options: ReadsbProviderOptions,
): PositionProvider {
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    id,
    async fetchNearby(q) {
      const body = await fetchUpstreamJson(buildUrl(q), { fetch: fetchImpl, timeoutMs, label: id });
      const flights: Flight[] = [];
      for (const raw of readsbAircraftList(body, id)) {
        const flight = normalizeReadsbAircraft(raw, id);
        if (flight !== null) flights.push(flight);
      }
      return flights;
    },
  };
}

/**
 * 応答から機体の配列を取り出す。キーは `ac`（無ければ `aircraft`）。どちらも無ければ 0 機。
 * キーはあるが配列でない・応答がオブジェクトでない場合は `UpstreamError`
 */
export function readsbAircraftList(body: unknown, label: string): unknown[] {
  if (!isRecord(body)) throw new UpstreamError(`${label}: response is not a JSON object`);
  const key = Object.hasOwn(body, "ac") ? "ac" : Object.hasOwn(body, "aircraft") ? "aircraft" : undefined;
  if (key === undefined) return [];
  const list = body[key];
  if (!Array.isArray(list)) throw new UpstreamError(`${label}: "${key}" is not an array`);
  return list;
}

/**
 * readsb 形式の 1 機を `Flight` に正規化する。hex（空文字を含む）・位置・位置の受信時刻が無い機体と、
 * §10.1 で除外（地上・軍用）となる機体は null。負の `seen_pos` は 0 に丸める。値が無い欄はオブジェクトに含めない
 */
export function normalizeReadsbAircraft(raw: unknown, source: ReadsbSource): Flight | null {
  if (!isRecord(raw)) return null;

  // hex は前後空白を除いて空なら捨てる。値そのものは加工しない
  const hex = raw.hex;
  if (typeof hex !== "string" || hex.trim() === "") return null;

  const lat = finiteNumber(raw.lat);
  const lon = finiteNumber(raw.lon);
  if (lat === undefined || lon === undefined) return null;

  // 負の seen_pos は 0 に丸める（OpenSky の time − time_position と同じ規則）
  const seenPos = finiteNumber(raw.seen_pos);
  if (seenPos === undefined) return null;
  const seenPosSec = Math.max(0, seenPos);

  const onGround = raw.alt_baro === "ground";
  const altitudeBaroFt = finiteNumber(raw.alt_baro) ?? null;
  const callsign = nonEmptyString(raw.flight);
  const typeCode = nonEmptyString(raw.t);

  const kind = classifyAircraft({ callsign, typeCode, dbFlags: finiteNumber(raw.dbFlags), onGround });
  if (kind === "excluded") return null;

  const isMlat = raw.type === "mlat" || (Array.isArray(raw.mlat) && raw.mlat.includes("lat"));

  return {
    hex,
    ...definedOnly({ callsign, registration: nonEmptyString(raw.r), typeCode }),
    position: {
      lat,
      lon,
      altitudeBaroFt,
      ...definedOnly({ altitudeGeomFt: finiteNumber(raw.alt_geom) }),
      onGround,
    },
    ...definedOnly({
      groundSpeedKt: finiteNumber(raw.gs),
      trackDeg: finiteNumber(raw.track),
      verticalRateFpm: finiteNumber(raw.baro_rate) ?? finiteNumber(raw.geom_rate),
      targetAltitudeFt: finiteNumber(raw.nav_altitude_mcp),
      squawk: nonEmptyString(raw.squawk),
    }),
    isMlat,
    seenPosSec,
    kind,
    source,
  };
}

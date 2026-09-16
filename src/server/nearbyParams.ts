// GET /api/nearby のクエリ検証（AC-A2）。HTTP 400 への変換は呼び出し側（Hono のハンドラ）で行う。
import type { Flight } from "../shared/types.ts";
import { kmToUpstreamNm } from "./providers/provider.ts";

export type NearbyParams = {
  lat: number;
  lon: number;
  radiusKm: number;
  /** 上流へ渡す半径（海里）。`kmToUpstreamNm(radiusKm)` */
  radiusNm: number;
  kinds: Set<Flight["kind"]>;
};

export type ParseNearbyParamsResult = { ok: true; value: NearbyParams } | { ok: false; error: string };

export const DEFAULT_RADIUS_KM = 50;
export const MIN_RADIUS_KM = 10;
export const MAX_RADIUS_KM = 100;
export const DEFAULT_KINDS: readonly Flight["kind"][] = ["passenger", "cargo"];
export const ALL_KINDS: readonly Flight["kind"][] = ["passenger", "cargo", "other"];

/** 10 進表記のみ（前後空白・指数表記・`NaN`・`Infinity`・空文字・`+` 符号は不可） */
const DECIMAL = /^-?\d+(\.\d+)?$/;

type NumberResult = { ok: true; value: number } | { ok: false; error: string };

export function parseNearbyParams(query: Record<string, string | undefined>): ParseNearbyParamsResult {
  const lat = parseRequiredNumber(query.lat, "lat", -90, 90);
  if (!lat.ok) return lat;

  const lon = parseRequiredNumber(query.lon, "lon", -180, 180);
  if (!lon.ok) return lon;

  const radiusKm =
    query.radiusKm === undefined
      ? ({ ok: true, value: DEFAULT_RADIUS_KM } as const)
      : parseNumberInRange(query.radiusKm, "radiusKm", MIN_RADIUS_KM, MAX_RADIUS_KM);
  if (!radiusKm.ok) return radiusKm;

  const kinds = parseKinds(query.kinds);
  if (!kinds.ok) return kinds;

  return {
    ok: true,
    value: {
      lat: lat.value,
      lon: lon.value,
      radiusKm: radiusKm.value,
      radiusNm: kmToUpstreamNm(radiusKm.value),
      kinds: kinds.value,
    },
  };
}

function parseRequiredNumber(raw: string | undefined, name: string, min: number, max: number): NumberResult {
  if (raw === undefined) return { ok: false, error: `${name} は必須です（${min} 以上 ${max} 以下の 10 進数）` };
  return parseNumberInRange(raw, name, min, max);
}

function parseNumberInRange(raw: string, name: string, min: number, max: number): NumberResult {
  const rangeText = `${min} 以上 ${max} 以下の 10 進数`;
  if (raw === "") return { ok: false, error: `${name} が空です（${rangeText}で指定してください）` };
  if (!DECIMAL.test(raw)) return { ok: false, error: `${name} が不正です（${rangeText}で指定してください）` };

  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    return { ok: false, error: `${name} が範囲外です（${rangeText}で指定してください）` };
  }
  // "-0" は 0 として扱う
  return { ok: true, value: value === 0 ? 0 : value };
}

function parseKinds(raw: string | undefined): { ok: true; value: Set<Flight["kind"]> } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: new Set(DEFAULT_KINDS) };

  const allowedText = ALL_KINDS.join(" / ");
  const kinds = new Set<Flight["kind"]>();
  for (const part of raw.split(",")) {
    const item = part.trim().toLowerCase();
    if (item === "") {
      return { ok: false, error: `kinds に空の要素があります（${allowedText} をカンマ区切りで指定してください）` };
    }
    if (!isKind(item)) {
      return { ok: false, error: `kinds に未知の種類があります（${allowedText} をカンマ区切りで指定してください）` };
    }
    kinds.add(item);
  }
  return { ok: true, value: kinds };
}

function isKind(value: string): value is Flight["kind"] {
  return (ALL_KINDS as readonly string[]).includes(value);
}

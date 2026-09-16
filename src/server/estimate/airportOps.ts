// 運用方向の集計（docs/spec.md §10.2 の「運用方向の判定」/ AC-P2-30〜32・34・35）。
// 推定の記録（1 機 = 1 件）から AirportOps[] を作る純粋関数。I/O もグローバル状態も持たない。
// 記録の保持（10 分窓の Map<hex, ...>）と空港中心の取得は src/server/airportOpsSource.ts が持つ。
import type { AirportOps } from "../../shared/types.ts";
import { TARGET_AIRPORT_ICAOS, runwayConfigLabel } from "../data/airports.ts";

/** 集計に使う推定の記録（1 機の 1 時点）。滑走路まで決まった進入・出発だけが記録になる */
export type AirportOpsEntry = {
  /** 機体の hex（機体数はこれのユニーク数で数える。AC-P2-30 / 32） */
  hex: string;
  icao: string;
  phase: "arrival" | "departure";
  /** 滑走路の指示子（例: "22"） */
  runway: string;
  /** その推定のもとになった位置の取得時刻（ms） */
  at: number;
};

/** 集計に入れる記録の新しさ（ms）。`now − at` がこれを**超えた**記録は捨てる（AC-P2-35。ちょうどは残す） */
export const AIRPORT_OPS_WINDOW_MS = 10 * 60_000;

/** 滑走路ごとの機体数（多い順・同数は識別子の昇順に並べたもの） */
type RunwayCount = { runway: string; aircraft: number };

/**
 * 直近 10 分の記録を空港ごとに集計する（AC-P2-30〜32 / 34 / 35）。
 * - `now − at > AIRPORT_OPS_WINDOW_MS` の記録は捨てる
 * - 同じ hex が複数あれば `at` が最新の 1 件だけを数える（同時刻なら入力の後ろの方。AC-P2-34）
 * - 滑走路の並びは機体数の降順、同数なら識別子の昇順
 * - `icaos` に無い ICAO の記録は捨てる（対象空港以外を推測で出さない）。出力の順は `icaos` の順で、
 *   記録が 1 件も無い空港は出さない
 */
export function aggregateAirportOps(
  entries: readonly AirportOpsEntry[],
  now: number,
  icaos: readonly string[] = TARGET_AIRPORT_ICAOS,
): AirportOps[] {
  const latest = latestPerHex(entries, now, new Set(icaos));
  const updatedAt = new Date(now).toISOString();

  const result: AirportOps[] = [];
  for (const icao of icaos) {
    const forAirport = [...latest.values()].filter((entry) => entry.icao === icao);
    if (forAirport.length === 0) continue;
    const landing = countRunways(forAirport, "arrival");
    const departing = countRunways(forAirport, "departure");
    const configLabel = selectConfigLabel(icao, landing, departing);
    result.push({
      icao,
      landingRunways: landing.map((count) => count.runway),
      departingRunways: departing.map((count) => count.runway),
      ...(configLabel === undefined ? {} : { configLabel }),
      // hex のユニーク数（サンプル数ではない。AC-P2-32）。latestPerHex で 1 hex 1 件にしてある
      basedOn: forAirport.length,
      updatedAt,
    });
  }
  return result;
}

/** hex ごとに最新の 1 件（10 分窓の中・対象空港のものだけ）。同時刻なら入力の後ろの方を採る */
function latestPerHex(
  entries: readonly AirportOpsEntry[],
  now: number,
  icaos: ReadonlySet<string>,
): Map<string, AirportOpsEntry> {
  const latest = new Map<string, AirportOpsEntry>();
  for (const entry of entries) {
    // 比較を否定形で書き、NaN の at も除外する
    if (!(now - entry.at <= AIRPORT_OPS_WINDOW_MS)) continue;
    if (!icaos.has(entry.icao)) continue;
    const previous = latest.get(entry.hex);
    if (previous !== undefined && previous.at > entry.at) continue;
    latest.set(entry.hex, entry);
  }
  return latest;
}

/** その phase の滑走路ごとの機体数。機体数の降順、同数は識別子の昇順（安定した出力にする。AC-P2-30） */
function countRunways(entries: readonly AirportOpsEntry[], phase: AirportOpsEntry["phase"]): RunwayCount[] {
  const hexesByRunway = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (entry.phase !== phase) continue;
    const hexes = hexesByRunway.get(entry.runway);
    if (hexes === undefined) {
      hexesByRunway.set(entry.runway, new Set([entry.hex]));
    } else {
      hexes.add(entry.hex);
    }
  }
  return [...hexesByRunway]
    .map(([runway, hexes]) => ({ runway, aircraft: hexes.size }))
    .sort((a, b) => b.aircraft - a.aircraft || compareCodeUnits(a.runway, b.runway));
}

/**
 * 運用方向のラベル（AC-P2-31）。着陸の最頻 1 本で対応表を引き、着陸が 0 件なら出発の最頻 1 本で引く。
 * 表に無ければ undefined（推測で埋めない。spec §10.2 末尾）
 */
function selectConfigLabel(icao: string, landing: readonly RunwayCount[], departing: readonly RunwayCount[]): string | undefined {
  const top = landing[0];
  if (top !== undefined) {
    return runwayConfigLabel(icao, top.runway, "landing");
  }
  const topDeparting = departing[0];
  return topDeparting === undefined ? undefined : runwayConfigLabel(icao, topDeparting.runway, "departing");
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

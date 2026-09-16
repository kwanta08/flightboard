// 機体の種類の判定（docs/spec.md §10.1）。エミッタカテゴリには依存しない。
import type { Flight } from "../shared/types.ts";
import { CARGO_AIRLINE_ICAO, KNOWN_AIRLINE_ICAO, PASSENGER_AIRCRAFT_TYPES } from "./data/aircraftLists.ts";

/** 判定結果。`excluded` の機体は応答に含めない */
export type AircraftClass = Flight["kind"] | "excluded";

export type ClassifyInput = {
  callsign?: string;
  typeCode?: string;
  /** readsb の `dbFlags`（ビットフラグ） */
  dbFlags?: number;
  onGround: boolean;
};

/** 航空会社形式のコールサイン: ICAO 3 レター＋数字 1〜4 桁＋英字 0〜2 文字 */
export const AIRLINE_CALLSIGN_RE = /^[A-Z]{3}\d{1,4}[A-Z]{0,2}$/;

/** `dbFlags` の軍用ビット（ビット 0）。値 8 は LADD で軍用ではない */
export const DB_FLAG_MILITARY = 1;

/** §10.1 の規則を上から順に評価して種類を返す */
export function classifyAircraft(input: ClassifyInput): AircraftClass {
  // 1. 地上にいる
  if (input.onGround) return "excluded";

  // 2. 軍用フラグ（truthy ではなくビット 0 で判定する）
  if (((input.dbFlags ?? 0) & DB_FLAG_MILITARY) !== 0) return "excluded";

  const callsign = input.callsign?.trim() ?? "";
  const isAirlineCallsign = AIRLINE_CALLSIGN_RE.test(callsign);

  // 3. 航空会社形式のコールサインで、先頭 3 文字が既知の航空会社
  if (isAirlineCallsign) {
    const icao = callsign.slice(0, 3);
    if (KNOWN_AIRLINE_ICAO.has(icao)) {
      return CARGO_AIRLINE_ICAO.has(icao) ? "cargo" : "passenger";
    }
  }

  // 4. 旅客機の機種で、コールサインが航空会社形式
  const typeCode = input.typeCode?.trim() ?? "";
  if (isAirlineCallsign && PASSENGER_AIRCRAFT_TYPES.has(typeCode)) return "passenger";

  // 5. どれにも当てはまらない
  return "other";
}

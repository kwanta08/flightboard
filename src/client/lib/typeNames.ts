// 一覧の「機種」欄に出す表示名（F-03 の例示「B767-300」）。
// 主要な旅客機の ICAO 型式（Doc 8643）のうち、表示名に確信のあるものだけを載せる。
// 一覧のために機体情報を一括照会しない（§13 adsbdb への配慮）ので、表に無い型式は typeCode のまま出す。
import { DASH } from "./format.ts";

export const TYPE_NAMES: Readonly<Record<string, string>> = {
  // Airbus
  A318: "A318",
  A319: "A319",
  A320: "A320",
  A321: "A321",
  A19N: "A319neo",
  A20N: "A320neo",
  A21N: "A321neo",
  A332: "A330-200",
  A333: "A330-300",
  A339: "A330-900neo",
  A359: "A350-900",
  A35K: "A350-1000",
  A388: "A380",
  BCS1: "A220-100",
  BCS3: "A220-300",
  // Boeing
  B736: "B737-600",
  B737: "B737-700",
  B738: "B737-800",
  B739: "B737-900",
  B37M: "B737 MAX 7",
  B38M: "B737 MAX 8",
  B39M: "B737 MAX 9",
  B3XM: "B737 MAX 10",
  B744: "B747-400",
  B748: "B747-8",
  B752: "B757-200",
  B753: "B757-300",
  B762: "B767-200",
  B763: "B767-300",
  B764: "B767-400",
  B772: "B777-200",
  B773: "B777-300",
  B77W: "B777-300ER",
  B788: "B787-8",
  B789: "B787-9",
  B78X: "B787-10",
  // Embraer
  E170: "E170",
  E175: "E175",
  E75L: "E175",
  E75S: "E175",
  E190: "E190",
  E195: "E195",
  E290: "E190-E2",
  E295: "E195-E2",
  // Bombardier / De Havilland Canada
  CRJ2: "CRJ200",
  CRJ7: "CRJ700",
  CRJ9: "CRJ900",
  DH8A: "DHC-8-100",
  DH8B: "DHC-8-200",
  DH8C: "DHC-8-300",
  DH8D: "DHC-8-400",
  // ATR
  AT45: "ATR 42-500",
  AT46: "ATR 42-600",
  AT75: "ATR 72-500",
  AT76: "ATR 72-600",
};

/** 型式の表示名。表にあれば表示名、無ければ typeCode のまま、typeCode も無ければ DASH */
export function typeDisplayName(typeCode?: string): string {
  const code = typeCode?.trim();
  if (!code) {
    return DASH;
  }
  const key = code.toUpperCase();
  return Object.hasOwn(TYPE_NAMES, key) ? (TYPE_NAMES[key] as string) : code;
}

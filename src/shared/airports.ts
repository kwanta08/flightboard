// 対象空港（docs/spec.md Q9: 羽田 RJTT・成田 RJAA）の表示名。
// サーバー（推定結果の `estimate.airport.name`）とクライアント（一覧のバッジ・ヘッダーの運用方向）が
// 同じ表を読む。tsconfig.client.json の include は src/client・src/shared なので、
// クライアントからは src/server を import できない。中心座標や運用方向の対応表は src/server/data/airports.ts。

export type AirportDisplayName = {
  /** 画面に出す短い名前（例: "羽田"） */
  shortName: string;
  /** IATA コード（例: "HND"）。一覧のバッジの先頭に出す */
  code: string;
};

/** ICAO → 表示名。対象空港だけを持つ（推測で埋めない。spec §10.2 末尾） */
export const AIRPORT_DISPLAY_NAMES: Readonly<Record<string, AirportDisplayName>> = {
  RJTT: { shortName: "羽田", code: "HND" },
  RJAA: { shortName: "成田", code: "NRT" },
};

/**
 * ICAO から表示名を引く。表に無ければ undefined（呼び出し側で ICAO のまま出す）。
 * `constructor` のような Object.prototype のキーで引かれても undefined を返す（hasOwn で見る）。
 */
export function airportDisplayName(icao: string): AirportDisplayName | undefined {
  return Object.hasOwn(AIRPORT_DISPLAY_NAMES, icao) ? AIRPORT_DISPLAY_NAMES[icao] : undefined;
}

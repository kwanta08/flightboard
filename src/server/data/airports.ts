// 対象空港（docs/spec.md Q9: 羽田 RJTT・成田 RJAA だけ）の中心座標と、運用方向のラベル対応表。
// 表示名（羽田 / HND）はクライアントと共有するため src/shared/airports.ts にある。
//
// 運用:
// - 空港を増やすときはここに 1 行足し、npm run import-runways で滑走路端を取り込み直す。
// - ラベルの対応表は「その滑走路を使っている＝この運用方向」という言い切りなので、確かなものだけを入れる。

export type TargetAirport = {
  icao: string;
  /** 空港の中心（ARP）の緯度・経度。空港中心の取得と、接近中／離脱中の判定に使う */
  lat: number;
  lon: number;
};

/**
 * 対象空港の中心座標。値は adsbdb の空港データ（`src/server/adsbdb`）が返すもので、
 * 既存のテスト（`src/shared/geo.test.ts` の仕様 §6.5 の再現）が使っている座標と同じ。
 */
export const TARGET_AIRPORTS: readonly TargetAirport[] = [
  { icao: "RJTT", lat: 35.552299, lon: 139.779999 },
  { icao: "RJAA", lat: 35.764702, lon: 140.386002 },
];

/**
 * 東京付近の磁気偏角（西偏、度）。滑走路の指示子は磁方位を 10° に丸めたもの（ICAO Annex 14）なので、
 * 座標から計算した真方位と突き合わせるときは「磁方位 ≒ 真方位 + この値」に直してから比べる（AC-P2-02）。
 * データ（OurAirports 由来の src/server/data/runways.ts）ではなく、人が決める設定値なのでこちらに置く。
 *
 * 根拠は次の 2 つ。**どちらも一次情報では検証していない**（AIP AD 2.12 の公示磁方位や
 * NOAA の地磁気モデル（WMM / IGRF）には当たっていない）。
 * 1. 東京付近の磁気偏角が西偏 7〜8° 程度であること（広く知られている値）。
 * 2. src/server/data/runways.ts の 12 端で「指示子 × 10° − 座標から計算した真方位」を実際に計算すると、
 *    平均 8.9°・範囲 5.1°〜11.0° になること（各端の値は指示子の 10° 丸め ±5° を含む）。
 *    8 はこの範囲の中にあり、8 を引いた残差の最大は 3.0°（RJAA 16R/34L）で、AC-P2-02 の許容 7° に収まる。
 *    この数字は src/server/data/runways.test.ts が毎回検算する。
 */
export const MAGNETIC_VARIATION_DEG = 8;

/** 対象空港の ICAO（滑走路の取り込みと空港中心の取得が使う） */
export const TARGET_AIRPORT_ICAOS: readonly string[] = TARGET_AIRPORTS.map((airport) => airport.icao);

/** ICAO から対象空港を引く。対象外なら undefined */
export function targetAirport(icao: string): TargetAirport | undefined {
  return TARGET_AIRPORTS.find((airport) => airport.icao === icao);
}

export type RunwayConfig = {
  icao: string;
  /** 運用方向のラベル（例: "南風運用"） */
  label: string;
  /** そのラベルのとき着陸に使う滑走路 */
  landing: readonly string[];
  /** そのラベルのとき出発に使う滑走路 */
  departing: readonly string[];
};

/**
 * 運用方向のラベルの対応表（spec F-10・§10.2）。
 * 羽田の南風運用には、都心上空を通って 16L/16R に着陸する時間帯がある（spec F-10 2c「夕方の時間帯のみ」）ので
 * 着陸側に 16L/16R も入れる。表に無い滑走路ではラベルを付けない（推測で埋めない。spec §10.2 末尾）。
 */
export const RUNWAY_CONFIGS: readonly RunwayConfig[] = [
  { icao: "RJTT", label: "南風運用", landing: ["22", "23", "16L", "16R"], departing: ["16L", "16R", "22"] },
  { icao: "RJTT", label: "北風運用", landing: ["34L", "34R"], departing: ["05", "34R"] },
  { icao: "RJAA", label: "南風運用", landing: ["16L", "16R"], departing: ["16L", "16R"] },
  { icao: "RJAA", label: "北風運用", landing: ["34L", "34R"], departing: ["34L", "34R"] },
];

/**
 * 滑走路 1 本から運用方向のラベルを引く（集計側が「着陸の最頻 1 本」→ 無ければ「出発の最頻 1 本」の順で呼ぶ）。
 * 表に無ければ undefined。
 */
export function runwayConfigLabel(icao: string, runway: string, use: "landing" | "departing"): string | undefined {
  return RUNWAY_CONFIGS.find((config) => config.icao === icao && config[use].includes(runway))?.label;
}

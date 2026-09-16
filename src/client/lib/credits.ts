// 画面のフッターに出すデータ提供元のクレジットと免責（AC-B3・仕様 §13）。App.tsx はこれを描画するだけ。

export type Credit = {
  /** 識別子（描画の key に使う） */
  id: string;
  /** 表示する文言 */
  label: string;
  /** リンク先 */
  href: string;
};

/**
 * データ提供元のクレジット。仕様 §13 の列挙とは次の点が異なる（plan p1b「仮決めした解釈」）:
 * OurAirports は Phase 1 で使わないので載せず、実際に使う adsb.fi・OpenSky Network・airport-data.com を加える
 */
export const CREDITS: readonly Credit[] = [
  { id: "adsblol", label: "adsb.lol（ODbL 1.0）", href: "https://adsb.lol" },
  // adsb.fi は利用条件によりホームページへのリンクを付ける
  { id: "adsbfi", label: "adsb.fi", href: "https://adsb.fi" },
  { id: "opensky", label: "OpenSky Network", href: "https://opensky-network.org" },
  { id: "adsbdb", label: "adsbdb", href: "https://www.adsbdb.com" },
  { id: "airport-data", label: "機体写真: airport-data.com", href: "https://www.airport-data.com" },
  { id: "osm", label: "© OpenStreetMap contributors", href: "https://www.openstreetmap.org/copyright" },
];

/** OpenStreetMap の標準タイルの URL（セットアップ画面と一覧の地図で共有する） */
export const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

/** OpenStreetMap のタイルの帰属。Leaflet の attribution に渡す HTML で、著作権ページへのリンクを含む */
export const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** 免責（仕様 §13 の文のまま） */
export const DISCLAIMER = "経路の表示は推定です。航行や安全の判断には使わないでください";

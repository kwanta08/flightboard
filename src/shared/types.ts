// 正規化後のデータモデル（docs/spec.md §8）と BFF の API 契約。
// サーバー（src/server）とフロント（次ループ）の双方がここから import する。

export type Flight = {
  hex: string;
  callsign?: string;
  registration?: string;
  typeCode?: string;

  position: { lat: number; lon: number; altitudeBaroFt: number | null; altitudeGeomFt?: number; onGround: boolean };
  groundSpeedKt?: number;
  trackDeg?: number;
  verticalRateFpm?: number;
  targetAltitudeFt?: number;        // nav_altitude_mcp
  squawk?: string;
  isMlat: boolean;
  seenPosSec: number;               // 位置の最終受信から、応答時点までの経過秒（updatedAt 基準ではない）

  airline?: { icao: string; iata?: string; name: string };
  route?: { origin: Airport; destination: Airport; stops?: Airport[]; source: "adsbdb" };
  // 写真は撮影者名（credit）と写真ページ（link）が揃っているものだけ（仕様 §13。提供元は planespotters.net）
  aircraft?: { model?: string; photo?: { url: string; thumbnailUrl?: string; credit: string; link: string } };

  // ★F-10: 経路の推定
  estimate?: {
    phase: "departure" | "arrival" | "enroute" | "unknown";
    airport?: { icao: string; name: string };
    runway?: string;                 // 例: "22"
    confidence: number;              // 0-1
    evidence: string[];              // 例: ["方位のズレ 0.3°", "滑走路まで 10.7km", "降下中 -704fpm"]
    namedRoute?: {                   // レベル2・3
      id: string; name: string; matchScore: number; source: "aip-pdf" | "aixm" | "user" | "learned";
    };
  };

  kind: "passenger" | "cargo" | "other";
  source: "adsblol" | "adsbfi" | "opensky";
};

export type AirportOps = {         // 空港ごとの運用状況（推定）
  icao: string;
  landingRunways: string[];      // 例: ["22", "23"]
  departingRunways: string[];
  configLabel?: string;          // 例: "南風運用"
  basedOn: number;               // 判定に使った機体数
  updatedAt: string;
};

// §8 が参照するが仕様に定義が無いため、adsbdb の空港データ
// （icao_code / iata_code / name / municipality / latitude / longitude）に合わせて定める。
export type Airport = { icao: string; iata?: string; name: string; municipality?: string; lat?: number; lon?: number };

// ---- API 契約 ----

// GET /api/nearby → 200
export type NearbyResponse = { updatedAt: string; source: Flight["source"]; flights: Flight[]; airportOps: AirportOps[] };

// GET /api/flights/:hex → 200
export type FlightDetailResponse = { updatedAt: string; flight: Flight; track: TrackPoint[] };

// altitudeFt = altitudeGeomFt ?? altitudeBaroFt、at = ISO8601（位置の受信時刻 = 取得時刻 − seenPosSec）
export type TrackPoint = { lat: number; lon: number; altitudeFt: number | null; at: string };

// 400 / 404 / 500 / 502 の応答ボディ
export type ApiError = { error: string };

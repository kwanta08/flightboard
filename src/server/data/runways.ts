// 滑走路端のスナップショット（docs/spec.md §10.2 の滑走路推定が使う）。
//
// **このファイルは自動生成です。手で編集しないでください。**
// 出所: OurAirports の runways.csv（パブリックドメイン、https://ourairports.com/data/）
// 取り込み元: runways.csv
// 生成日: 2026-09-16
// 再生成: npm run import-runways -- <runways.csv のパス>
//
// 座標は OurAirports の値をそのまま持つ。AIP など一次情報との突き合わせはしていないので、
// 数十 m の誤差は検出できていない（src/server/data/runways.test.ts が見るのは、指示子との
// 方位の食い違いと公示滑走路長との差だけ）。
// 真方位はデータに持たない。自端 → 対向端の座標から bearingDeg() で計算する。
// CSV の {le,he}_heading_degT は取り込み時の突き合わせにだけ使い（差が 1° を超えたら下の警告に出す）、
// 値そのものはここへ持ち込まない。
//
// 取り込み時の警告（取り込みは止めていない。真方位は常に座標から計算する）:
// 警告: RJTT 05: CSV の真方位 57.0° と座標から計算した真方位 42.4° が 14.6° 食い違う（座標側を採った）
//
// AC-P2-03（対向端どうしの距離が公示滑走路長の ±10% に収まる）を外れた滑走路。
// 下の KNOWN_LENGTH_MISMATCHES と同じ内容で、src/server/data/runways.test.ts が
// 「ここに申告された集合」と「実際に ±10% を外れた滑走路の集合」の完全一致を検査する
// （例外をテスト側の定数に書かないため。黙らせるには取り込み直してここに載せるしかない）。
// 既知の不一致: RJAA 16L/34R — 端間 2.168km / 公示 2.500km（-13.3%、差 0.332km）
//
// この不一致について分かっていること:
// - 指示子（磁方位）と座標から計算した真方位の食い違いは最大 1.9° で、
//   AC-P2-02 の許容（7°）に収まっている。つまりこのずれは**滑走路中心線に沿った方向のずれ**であり、
//   中心線の向きそのものは動いていない（片端または両端が中心線に沿ってずれた形。どちらかは不明）。
// - したがって docs/spec.md §10.2 の主要な判別材料である「方位のズレ」には影響しない。
// - 端の座標のずれは最大 0.33km。§10.2 は距離を evidence の「滑走路まで ◯km」の表示だけでなく、
//   採点（距離km × 0.3）・許容ズレ（20° − 距離km × 0.4）・進入/出発の距離条件（35km / 25km）にも
//   使うので、距離を使う判定・採点すべてがこの分だけ動く（採点 0.1 点・許容ズレ 0.13° 相当）。
// - **どちらの端が旧位置かは判別できていない**（OurAirports の座標だけでは決められないので断定しない）。
// - AIP AD 2.12 の公示座標を持っていないので、座標側の補正はしていない。
//
// 磁気偏角（MAGNETIC_VARIATION_DEG）は人が決める設定値なので、生成物ではなく
// 手で保守する src/server/data/airports.ts にある。
import type { LengthMismatch, RunwayEnd } from "./importRunways.ts";

/** 対象空港の滑走路端。ident は磁方位ベースの指示子（例: "16L"） */
export const RUNWAY_ENDS: readonly RunwayEnd[] = [
  { icao: "RJTT", ident: "04", lat: 35.549015, lon: 139.761274, oppositeIdent: "22", lengthFt: 8202 },
  { icao: "RJTT", ident: "05", lat: 35.524001, lon: 139.803469, oppositeIdent: "23", lengthFt: 8202 },
  { icao: "RJTT", ident: "16L", lat: 35.565897, lon: 139.78655, oppositeIdent: "34R", lengthFt: 11024 },
  { icao: "RJTT", ident: "16R", lat: 35.560452, lon: 139.768734, oppositeIdent: "34L", lengthFt: 9843 },
  { icao: "RJTT", ident: "22", lat: 35.567459, lon: 139.777114, oppositeIdent: "04", lengthFt: 8202 },
  { icao: "RJTT", ident: "23", lat: 35.540598, lon: 139.822125, oppositeIdent: "05", lengthFt: 8202 },
  { icao: "RJTT", ident: "34L", lat: 35.536591, lon: 139.785672, oppositeIdent: "16R", lengthFt: 9843 },
  { icao: "RJTT", ident: "34R", lat: 35.53969, lon: 139.805142, oppositeIdent: "16L", lengthFt: 11024 },
  { icao: "RJAA", ident: "16L", lat: 35.80270004272461, lon: 140.3800048828125, oppositeIdent: "34R", lengthFt: 8202 },
  { icao: "RJAA", ident: "16R", lat: 35.77439880371094, lon: 140.3679962158203, oppositeIdent: "34L", lengthFt: 13123 },
  { icao: "RJAA", ident: "34L", lat: 35.74330139160156, lon: 140.39100646972656, oppositeIdent: "16R", lengthFt: 13123 },
  { icao: "RJAA", ident: "34R", lat: 35.78580093383789, lon: 140.39199829101562, oppositeIdent: "16L", lengthFt: 8202 },
];

/**
 * AC-P2-03 の既知の不一致（上のヘッダと同じ内容を、機械的に読める形で持つ）。
 * 取り込み（importRunwayEnds）が検出したものだけが入る。手で足さない・消さない。
 */
export const KNOWN_LENGTH_MISMATCHES: readonly LengthMismatch[] = [
  { icao: "RJAA", ident: "16L", oppositeIdent: "34R", endsApartKm: 2.168, publishedKm: 2.5, deviation: -0.1327, identDeviationDeg: 1.9 },
];

const ENDS_BY_ICAO = new Map<string, RunwayEnd[]>();
for (const end of RUNWAY_ENDS) {
  const ends = ENDS_BY_ICAO.get(end.icao);
  if (ends) {
    ends.push(end);
  } else {
    ENDS_BY_ICAO.set(end.icao, [end]);
  }
}

const NO_ENDS: readonly RunwayEnd[] = [];

/** その空港の滑走路端（RUNWAY_ENDS の並び順）。対象外の ICAO では空配列 */
export function runwayEndsFor(icao: string): readonly RunwayEnd[] {
  return ENDS_BY_ICAO.get(icao) ?? NO_ENDS;
}

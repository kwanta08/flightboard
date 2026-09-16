// 地図ペインの表示（AC-B10・AC-B11）。表示範囲・航跡の線・アイコンの位置と見た目・選択の操作を決める。
// MapPane.tsx は react-leaflet への配線だけを行う。
import { EARTH_RADIUS_KM, type LatLon } from "../../shared/geo.ts";
import type { Flight, TrackPoint } from "../../shared/types.ts";
import { extrapolatedPosition } from "./deadReckoning.ts";
import { CARGO_BADGE_LABEL } from "./flightRows.ts";
import { nonEmpty } from "./format.ts";
import { sameHex } from "./hex.ts";
import { aircraftIcon, type MapIconSpec } from "./mapIcons.ts";

/** 選択中のアイコンを他の機体より手前に出すための z-index の加算 */
export const SELECTED_Z_INDEX_OFFSET = 1000;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/** [緯度, 経度] */
export type LatLngPair = [number, number];

/**
 * 中心 `center`・半径 `radiusKm` の円（球面上）が収まる矩形 [[南, 西], [北, 東]]。
 * 緯度だけ [-90, 90] に丸める。経度は `center.lon ± Δλ` のまま返す（日付変更線の近くでは ±180 を超えてよい。
 * 切り詰めると円が矩形からはみ出す）。円が極を含むときは経度を全周 [-180, 180] にする
 */
export function radiusBounds(center: LatLon, radiusKm: number): [LatLngPair, LatLngPair] {
  const delta = radiusKm / EARTH_RADIUS_KM;
  const deltaDeg = delta * RAD_TO_DEG;
  const south = Math.max(-90, center.lat - deltaDeg);
  const north = Math.min(90, center.lat + deltaDeg);
  if (Math.abs(center.lat) + deltaDeg >= 90) {
    return [
      [south, -180],
      [north, 180],
    ];
  }
  // 球面上の円の経度方向の最大の張り出し: Δλ = asin(sin δ / cos φ)
  const dLonDeg = Math.asin(Math.min(1, Math.sin(delta) / Math.cos(center.lat * DEG_TO_RAD))) * RAD_TO_DEG;
  return [
    [south, center.lon - dLonDeg],
    [north, center.lon + dLonDeg],
  ];
}

/** 検索半径の km を Leaflet の Circle の半径（m）に換算する */
export function radiusMeters(radiusKm: number): number {
  return radiusKm * 1000;
}

/** 表示範囲を決める入力（観測地点と検索半径） */
export type RadiusView = { lat: number; lon: number; radiusKm: number };

/**
 * 地点か半径が前回から変わったか。変わったときだけ表示範囲を合わせ直す
 * （初回の表示範囲は MapContainer の bounds で決まっているので、前回を初回の値にしておけばマウント時は合わせ直さない）
 */
export function radiusViewChanged(previous: RadiusView, next: RadiusView): boolean {
  return previous.lat !== next.lat || previous.lon !== next.lon || previous.radiusKm !== next.radiusKm;
}

/**
 * 経度 `lon` を、`centerLon` に最も近い同値の経度（`lon` ± 360 の整数倍）にする。
 * 地図の表示範囲（`radiusBounds`）と補間（`projectPosition`）は観測地点の経度から ±180 を超えて連続に扱うので、
 * 上流の [-180, 180] の経度を観測地点と同じ側に寄せる（例: 中心 179.9 の地図で -179.9 → 180.1）。
 * 観測地点から 180° 未満の経度は変えない（同じ値を返す）。どちらかが非有限なら `lon` のまま
 */
export function unwrapLongitudeNear(lon: number, centerLon: number): number {
  if (!Number.isFinite(lon) || !Number.isFinite(centerLon)) {
    return lon;
  }
  const turns = Math.round((lon - centerLon) / 360);
  return turns === 0 ? lon : lon - turns * 360;
}

/**
 * 航跡の折れ線の点。`track` の順序を保ち、`current` が最後の点と同じ位置でなければ末尾に足す。
 * `track` が無ければ `current` だけ（それも無ければ空）。
 * `centerLon`（観測地点の経度）があれば、すべての点の経度をそれに寄せる（`unwrapLongitudeNear`。日付変更線をまたぐ航跡も連続にする）
 */
export function trackLine(track: readonly TrackPoint[] | undefined, current?: LatLon, centerLon?: number): LatLngPair[] {
  const near = (lon: number): number => (centerLon === undefined ? lon : unwrapLongitudeNear(lon, centerLon));
  const points: LatLngPair[] = (track ?? []).map((point) => [point.lat, near(point.lon)]);
  if (current === undefined) {
    return points;
  }
  const currentLon = near(current.lon);
  const last = points[points.length - 1];
  if (last === undefined || last[0] !== current.lat || last[1] !== currentLon) {
    points.push([current.lat, currentLon]);
  }
  return points;
}

/**
 * 機体のアイコンのボタン名（例「ANA245 を選択」。コールサインが無ければ hex）。
 * 貨物機は「（貨物）」を添える（例「FDX5901（貨物）を選択」。地図のアイコンの色だけで区別しない）
 */
export function aircraftAriaLabel(flight: Pick<Flight, "hex" | "callsign"> & Partial<Pick<Flight, "kind">>): string {
  const name = nonEmpty(flight.callsign) ?? flight.hex;
  return flight.kind === "cargo" ? `${name}（${CARGO_BADGE_LABEL}）を選択` : `${name} を選択`;
}

/** フォーカスしたアイコンで押すと選択するキー（Enter・Space。Leaflet 1.9 はマーカーの Enter を click にしない） */
export function isSelectKey(key: string): boolean {
  return key === "Enter" || key === " ";
}

/** 選択中のアイコンを手前に出す z-index の加算 */
export function aircraftZIndexOffset(selected: boolean): number {
  return selected ? SELECTED_Z_INDEX_OFFSET : 0;
}

/**
 * 前回渡した [緯度, 経度] と値が同じならその配列を、違えば新しい配列を返す
 * （react-leaflet は `position` の参照が変わるたびに setLatLng するので、動かない機体では同じ参照を渡す）
 */
export function reusePosition(previous: LatLngPair | undefined, next: LatLon): LatLngPair {
  if (previous !== undefined && previous[0] === next.lat && previous[1] === next.lon) {
    return previous;
  }
  return [next.lat, next.lon];
}

/**
 * 前回渡した線と点の数・各点の [緯度, 経度] が同じなら前回の配列を、1 点でも違えば `next` を返す。前回が無ければ `next`
 * （react-leaflet は Polyline の `positions` の参照が変わるたびに setLatLngs するので、変わらない線では同じ参照を渡す）
 */
export function reuseLine(previous: LatLngPair[] | undefined, next: LatLngPair[]): LatLngPair[] {
  if (previous === undefined || previous.length !== next.length) {
    return next;
  }
  const same = next.every((point, index) => {
    const before = previous[index];
    return before !== undefined && before[0] === point[0] && before[1] === point[1];
  });
  return same ? previous : next;
}

/** 地図に置く機体の印 1 つ分 */
export type AircraftMarkerView = {
  hex: string;
  /** 補間した位置 */
  position: LatLon;
  selected: boolean;
  icon: MapIconSpec;
  label: string;
  zIndexOffset: number;
};

/** 受信した位置の経度を `centerLon` に寄せた機体（補間の起点）。`centerLon` が無いか経度が変わらなければ同じオブジェクト */
function flightNearLongitude(flight: Flight, centerLon: number | undefined): Flight {
  if (centerLon === undefined) {
    return flight;
  }
  const lon = unwrapLongitudeNear(flight.position.lon, centerLon);
  return lon === flight.position.lon ? flight : { ...flight, position: { ...flight.position, lon } };
}

/**
 * 機体ごとの印。位置は `extrapolatedPosition(flight, receivedAtMs, nowMs)`、見た目は `aircraftIcon`。
 * `centerLon`（観測地点の経度）があれば、補間の起点の経度をそれに寄せる（`unwrapLongitudeNear`。日付変更線の反対側に出さない）。
 * 入力の `flights` は変えない（一覧・詳細の距離と方角は受信した位置のまま計算する）
 */
export function aircraftMarkers(
  flights: readonly Flight[],
  receivedAtMs: number | undefined,
  nowMs: number,
  selectedHex: string | undefined,
  centerLon?: number,
): AircraftMarkerView[] {
  return flights.map((flight) => {
    const selected = selectedHex !== undefined && sameHex(flight.hex, selectedHex);
    return {
      hex: flight.hex,
      position: extrapolatedPosition(flightNearLongitude(flight, centerLon), receivedAtMs, nowMs),
      selected,
      icon: aircraftIcon({ trackDeg: flight.trackDeg, selected, kind: flight.kind }),
      label: aircraftAriaLabel(flight),
      zIndexOffset: aircraftZIndexOffset(selected),
    };
  });
}

/** どの機体の航跡か（`hex`）と、その点（`/api/flights/:hex` の `track`） */
export type SelectedTrack = { hex: string; points: readonly TrackPoint[] };

/**
 * 選択中の機体の航跡の線。`track` が無い・未選択・`track.hex` が選択と違う（前に選んでいた機体の航跡）なら undefined（線を出さない）。
 * 選択中の機体が一覧に居れば、その補間位置を末尾に足す。hex は大文字小文字を区別しない（`sameHex`）。
 * `centerLon`（観測地点の経度）があれば、線のすべての点の経度をそれに寄せる（`aircraftMarkers` に渡したものと同じ値を渡す）
 */
export function selectedTrackLine(
  markers: readonly AircraftMarkerView[],
  selectedHex: string | undefined,
  track: SelectedTrack | undefined,
  centerLon?: number,
): LatLngPair[] | undefined {
  if (track === undefined || selectedHex === undefined || !sameHex(track.hex, selectedHex)) {
    return undefined;
  }
  const current = markers.find((marker) => sameHex(marker.hex, selectedHex))?.position;
  return trackLine(track.points, current, centerLon);
}

/**
 * 前回渡した航跡と、どの機体のものか（`hex`）と点の配列の参照（`points`）が同じなら前回のオブジェクトを、違えば `next` を返す
 * （詳細の状態が取り直し中・失敗などで変わっても、同じ詳細の航跡なら地図に同じ参照を渡し、地図の memo を保つ）
 */
export function reuseTrack(previous: SelectedTrack | undefined, next: SelectedTrack | undefined): SelectedTrack | undefined {
  if (previous !== undefined && next !== undefined && previous.hex === next.hex && previous.points === next.points) {
    return previous;
  }
  return next;
}

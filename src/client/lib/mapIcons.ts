// 地図のアイコンの見た目（AC-B10）。Leaflet に依存しない純粋関数で、L.divIcon に渡す値とメモ化のキーを返す。
// MapPane.tsx は key ごとに L.divIcon を作って再利用するだけにする。
import type { Flight } from "../../shared/types.ts";

/** L.divIcon に渡す値。`key` は見た目を決める入力から作り、同じ見た目なら同じ `key` */
export type MapIconSpec = {
  key: string;
  className: string;
  html: string;
  size: [number, number];
  anchor: [number, number];
};

export type AircraftIconInput = {
  trackDeg?: number;
  selected: boolean;
  kind: Flight["kind"];
};

/** 通常のアイコンの一辺（px） */
export const AIRCRAFT_ICON_SIZE_PX = 24;
/** 選択中のアイコンの一辺（px）。大きさで強調する（色だけに頼らない） */
export const AIRCRAFT_ICON_SELECTED_SIZE_PX = 36;

export const AIRCRAFT_ICON_CLASS = "aircraft-icon";
/** 選択中のアイコンに付けるクラス（枠線を描く） */
export const AIRCRAFT_ICON_SELECTED_CLASS = "aircraft-icon--selected";
/** 進行方向があるとき（回転する機体の形） */
export const AIRCRAFT_ICON_HEADING_CLASS = "aircraft-icon--heading";
/** 進行方向が無いとき（回転しない丸） */
export const AIRCRAFT_ICON_NO_HEADING_CLASS = "aircraft-icon--no-heading";

/** 真上（北）を向いた機体の形（24×24） */
const AIRCRAFT_PATH =
  "M12 1.5 13.6 8.6 22 12.8V15.2L13.6 12.6 13.1 18.8 16.2 21V22.6L12 21.5 7.8 22.6V21L10.9 18.8 10.4 12.6 2 15.2V12.8L10.4 8.6Z";

/** 角度（度）を 1° 単位に丸めて [0, 360) にする。非有限なら undefined */
function roundedHeading(trackDeg: number | undefined): number | undefined {
  if (trackDeg === undefined || !Number.isFinite(trackDeg)) {
    return undefined;
  }
  return ((Math.round(trackDeg) % 360) + 360) % 360;
}

function squareSize(px: number): { size: [number, number]; anchor: [number, number] } {
  return { size: [px, px], anchor: [px / 2, px / 2] };
}

/**
 * 機体のアイコン。`trackDeg` があれば 1° 単位に丸めた角度で回転する機体の形、無ければ回転しない丸。
 * 選択中は大きくし、枠線のクラスを付ける。貨物は `aircraft-icon--cargo` のクラスで区別する
 */
export function aircraftIcon({ trackDeg, selected, kind }: AircraftIconInput): MapIconSpec {
  const heading = roundedHeading(trackDeg);
  const shape = heading === undefined ? "dot" : `plane${heading}`;
  const classNames = [
    AIRCRAFT_ICON_CLASS,
    `aircraft-icon--${kind}`,
    heading === undefined ? AIRCRAFT_ICON_NO_HEADING_CLASS : AIRCRAFT_ICON_HEADING_CLASS,
  ];
  if (selected) {
    classNames.push(AIRCRAFT_ICON_SELECTED_CLASS);
  }
  const html =
    heading === undefined
      ? '<span class="aircraft-icon-dot" aria-hidden="true"></span>'
      : `<svg class="aircraft-icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false" style="transform: rotate(${heading}deg)"><path d="${AIRCRAFT_PATH}"/></svg>`;
  return {
    key: `${shape}|${selected ? "selected" : "normal"}|${kind}`,
    className: classNames.join(" "),
    html,
    ...squareSize(selected ? AIRCRAFT_ICON_SELECTED_SIZE_PX : AIRCRAFT_ICON_SIZE_PX),
  };
}

/** 観測地点の印の一辺（px） */
export const OBSERVER_ICON_SIZE_PX = 22;

/** 観測地点の印 */
export function observerIcon(): MapIconSpec {
  return {
    key: "observer",
    className: "observer-icon",
    html: '<span class="observer-icon-dot" aria-hidden="true"></span>',
    ...squareSize(OBSERVER_ICON_SIZE_PX),
  };
}

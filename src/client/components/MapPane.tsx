// 地図ペイン（AC-B10・AC-B11）。判断は lib/mapView・lib/mapIcons・lib/deadReckoning に置き、ここは react-leaflet への配線だけを行う。
import { divIcon, type DivIcon, type Marker as LeafletMarker, type PathOptions } from "leaflet";
import { memo, useEffect, useMemo, useRef } from "react";
import { Circle, MapContainer, Marker, Polyline, TileLayer, useMap } from "react-leaflet";
import type { Flight } from "../../shared/types.ts";
import { useNow } from "../hooks/useNow.ts";
import { OSM_ATTRIBUTION, OSM_TILE_URL } from "../lib/credits.ts";
import { observerIcon, type MapIconSpec } from "../lib/mapIcons.ts";
import {
  aircraftMarkers,
  type LatLngPair,
  radiusBounds,
  radiusMeters,
  type RadiusView,
  radiusViewChanged,
  reuseLine,
  reusePosition,
  type SelectedTrack,
  selectedTrackLine,
} from "../lib/mapView.ts";

type MapPaneProps = {
  /** 観測地点 */
  observer: { lat: number; lon: number };
  /** 検索半径（km） */
  radiusKm: number;
  flights: readonly Flight[];
  /** 応答を受けた時刻（補間の起点に使う） */
  receivedAt?: number;
  selectedHex?: string;
  onSelect(hex: string): void;
  /** 選択中の機体の航跡（/api/flights/:hex の track）と、どの機体のものか。`hex` が選択と違えば線を出さない */
  track?: SelectedTrack;
};

// L.divIcon を見た目の key ごとに 1 つだけ作って使い回す（同じ見た目なら同じオブジェクトを渡し、setIcon で DOM を作り直さない）
const iconCache = new Map<string, DivIcon>();
function leafletIcon(spec: MapIconSpec): DivIcon {
  const cached = iconCache.get(spec.key);
  if (cached !== undefined) return cached;
  const icon = divIcon({ className: spec.className, html: spec.html, iconSize: spec.size, iconAnchor: spec.anchor });
  iconCache.set(spec.key, icon);
  return icon;
}

const OBSERVER_ICON = leafletIcon(observerIcon());

// pathOptions は参照が変わるたびに setStyle されるので、固定のオブジェクトを渡す
const RADIUS_PATH_OPTIONS: PathOptions = { color: "#1f2a44", weight: 2, dashArray: "6 6", fillColor: "#1f2a44", fillOpacity: 0.04 };
const TRACK_PATH_OPTIONS: PathOptions = { color: "#d6336c", weight: 3, opacity: 0.9 };

/**
 * 地点・半径が変わったら円が収まるよう表示範囲を合わせる（MapContainer の bounds は初回にしか効かないため）。
 * 初回の表示範囲は MapContainer の bounds で決まっているので、マウント時は合わせ直さない（前回値を初回の地点・半径から始める）
 */
function FitToRadius({ lat, lon, radiusKm }: RadiusView) {
  const map = useMap();
  const previous = useRef<RadiusView>({ lat, lon, radiusKm });
  useEffect(() => {
    const next: RadiusView = { lat, lon, radiusKm };
    const changed = radiusViewChanged(previous.current, next);
    previous.current = next;
    if (changed) {
      map.fitBounds(radiusBounds({ lat, lon }, radiusKm));
    }
  }, [map, lat, lon, radiusKm]);
  return null;
}

type AircraftMarkerProps = {
  hex: string;
  position: LatLngPair;
  icon: DivIcon;
  label: string;
  zIndexOffset: number;
  onSelect(hex: string): void;
};

/** 機体 1 機分の印。props が変わらなければ描き直さない */
const AircraftMarker = memo(function AircraftMarker({ hex, position, icon, label, zIndexOffset, onSelect }: AircraftMarkerProps) {
  const markerRef = useRef<LeafletMarker>(null);

  const handlers = useMemo(() => ({ click: () => onSelect(hex) }), [hex, onSelect]);

  // Leaflet は title をアイコンの要素を作ったときにしか付けないので、ボタン名が変わったら付け直す
  useEffect(() => {
    markerRef.current?.getElement()?.setAttribute("title", label);
  }, [label]);

  // ボタン名は title（と上の effect での付け直し）だけで付く。
  // alt は Leaflet が img のアイコンにしか付けず、divIcon（div の要素）では効かないので渡さない。
  // keyboard={false}: キーボード操作の主役は一覧なので、アイコンは Tab の停止点にしない（機体の数だけ Tab が増えるため）
  return (
    <Marker
      ref={markerRef}
      position={position}
      icon={icon}
      title={label}
      keyboard={false}
      zIndexOffset={zIndexOffset}
      eventHandlers={handlers}
    />
  );
});

type AircraftLayerProps = Pick<MapPaneProps, "flights" | "receivedAt" | "selectedHex" | "onSelect" | "track"> & {
  /** 観測地点の経度（機体の位置と航跡の点の経度をこれに寄せる。日付変更線の反対側に出さない） */
  observerLon: number;
};

/** 機体の印と選択中の航跡。1 秒ごとの再描画をこの子に閉じる（App と一覧を巻き込まない） */
function AircraftLayer({ flights, receivedAt, selectedHex, onSelect, track, observerLon }: AircraftLayerProps) {
  const now = useNow(1000);
  const markers = aircraftMarkers(flights, receivedAt, now, selectedHex, observerLon);
  const selectedLine = selectedTrackLine(markers, selectedHex, track, observerLon);

  // 前回渡した位置の配列（hex ごと）と航跡の線。値が変わらなければ同じ参照を渡す（setLatLng・setLatLngs を避ける）
  const previousPositions = useRef(new Map<string, LatLngPair>());
  const previousLine = useRef<LatLngPair[] | undefined>(undefined);
  const positions = new Map<string, LatLngPair>();
  const line = selectedLine === undefined ? undefined : reuseLine(previousLine.current, selectedLine);
  useEffect(() => {
    previousPositions.current = positions;
    previousLine.current = line;
  });

  return (
    <>
      {markers.map((marker) => {
        const position = reusePosition(previousPositions.current.get(marker.hex), marker.position);
        positions.set(marker.hex, position);
        return (
          <AircraftMarker
            key={marker.hex}
            hex={marker.hex}
            position={position}
            icon={leafletIcon(marker.icon)}
            label={marker.label}
            zIndexOffset={marker.zIndexOffset}
            onSelect={onSelect}
          />
        );
      })}
      {line !== undefined ? <Polyline positions={line} pathOptions={TRACK_PATH_OPTIONS} interactive={false} /> : null}
    </>
  );
}

export function MapPane({ observer, radiusKm, flights, receivedAt, selectedHex, onSelect, track }: MapPaneProps) {
  const { lat, lon } = observer;
  const center = useMemo<LatLngPair>(() => [lat, lon], [lat, lon]);

  // 初回の表示範囲は bounds で 1 段で決める（center・zoom の後に fitBounds し直すと、無駄なタイル要求とズームの揺れが出る）。
  // bounds は初回にしか効かないので、その後の地点・半径の変更には FitToRadius が合わせる
  return (
    <MapContainer className="map-pane-container" bounds={radiusBounds(observer, radiusKm)}>
      <TileLayer url={OSM_TILE_URL} attribution={OSM_ATTRIBUTION} />
      <FitToRadius lat={lat} lon={lon} radiusKm={radiusKm} />
      <Circle center={center} radius={radiusMeters(radiusKm)} pathOptions={RADIUS_PATH_OPTIONS} interactive={false} />
      <Marker position={center} icon={OBSERVER_ICON} title="観測地点" keyboard={false} interactive={false} />
      <AircraftLayer
        flights={flights}
        receivedAt={receivedAt}
        selectedHex={selectedHex}
        onSelect={onSelect}
        track={track}
        observerLon={lon}
      />
    </MapContainer>
  );
}

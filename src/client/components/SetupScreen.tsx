// 地点のセットアップ画面（AC-B2・S-01）。判断は lib/setupFlow・lib/locationStore・lib/geolocation に置き、ここは描画と配線だけを行う。
import { divIcon, type DragEndEvent, type LeafletMouseEvent, type Marker as LeafletMarker } from "leaflet";
import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent, type Ref } from "react";
import { MapContainer, Marker, TileLayer, useMap, useMapEvents } from "react-leaflet";
import { OSM_ATTRIBUTION, OSM_TILE_URL } from "../lib/credits.ts";
import { requestPosition } from "../lib/geolocation.ts";
import type { Location } from "../lib/locationStore.ts";
import {
  applyGeolocationResult,
  canCancelSetup,
  changeElevationText,
  confirmErrorText,
  confirmLocation,
  initialSetupState,
  placePinByUser,
  SETUP_MAP_ZOOM,
  setupMessage,
  type LatLon,
  type MapPoint,
  type SetupTransition,
} from "../lib/setupFlow.ts";

type SetupScreenProps = {
  current?: Location;
  /** 見出し（画面の切り替え時に App がここへフォーカスを移す） */
  headingRef?: Ref<HTMLHeadingElement>;
  onConfirm(location: Location): void;
  onCancel?(): void;
};

// Leaflet の既定のマーカー画像はバンドラで壊れやすいので使わず、CSS で描く（中心が地点）
const PIN_ICON = divIcon({
  className: "setup-pin",
  html: '<span class="setup-pin-dot"></span>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

/** 地図のクリックの座標を渡す */
function PinOnClick({ onPick }: { onPick(point: MapPoint): void }) {
  const handlers = useMemo(() => ({ click: (event: LeafletMouseEvent) => onPick(event.latlng) }), [onPick]);
  useMapEvents(handlers);
  return null;
}

/** 表示範囲を target に移す（MapContainer の props は初回以降効かないため）。target が変わったときだけ動く */
function CenterOn({ target }: { target: LatLon }) {
  const map = useMap();
  useEffect(() => {
    map.setView([target.lat, target.lon], map.getZoom());
  }, [map, target]);
  return null;
}

export function SetupScreen({ current, headingRef, onConfirm, onCancel }: SetupScreenProps) {
  const [initial] = useState(() => initialSetupState(current));
  const [setup, setSetup] = useState<SetupTransition>(() => ({ state: initial }));
  const { state, recenter } = setup;

  useEffect(() => {
    if (!initial.requestGeolocation) {
      return;
    }
    let mounted = true;
    void requestPosition(navigator.geolocation).then((result) => {
      // アンマウント後に届いた結果は捨てる
      if (!mounted) {
        return;
      }
      setSetup((previous) => applyGeolocationResult(previous.state, result));
    });
    return () => {
      mounted = false;
    };
  }, [initial]);

  // 遷移は lib が返す SetupTransition でそのまま置き換える（recenter を持つかどうかは lib が決める）
  const handlePick = useCallback((point: MapPoint) => {
    setSetup((previous) => placePinByUser(previous.state, point));
  }, []);

  const markerHandlers = useMemo(
    () => ({
      // 何もしない。ピンをクリックしただけ（動かさない）のとき、click が地図に落ちて PinOnClick でピンがずれるのを防ぐ
      // （Marker は bubblingMouseEvents: false が既定なので、click を listen していれば地図へ伝わらない）
      click: () => {},
      dragend: (event: DragEndEvent) => {
        const { lat, lng } = (event.target as LeafletMarker).getLatLng();
        handlePick({ lat, lng });
      },
    }),
    [handlePick],
  );

  // ピンの [緯度, 経度] は緯度・経度が変わったときだけ作り直す（react-leaflet は position の参照が変わるたびに setLatLng するので、
  // 標高の入力や測位の結果などピンと無関係な再描画でドラッグ中のピンを戻さない）。フックの順を保つため、ピンが無いときも呼ぶ
  const pinLat = state.pin?.lat;
  const pinLon = state.pin?.lon;
  const pinPosition = useMemo<[number, number] | undefined>(
    () => (pinLat === undefined || pinLon === undefined ? undefined : [pinLat, pinLon]),
    [pinLat, pinLon],
  );

  const handleElevationChange = (event: ChangeEvent<HTMLInputElement>) => {
    const text = event.target.value;
    setSetup((previous) => changeElevationText(previous.state, text));
  };

  const confirmation = confirmLocation(state.pin, state.elevationText);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (confirmation.ok) {
      onConfirm(confirmation.location);
    }
  };

  return (
    <main className="setup" aria-label="地点の設定">
      <form className="setup-panel" onSubmit={handleSubmit}>
        <h2 className="setup-title" ref={headingRef} tabIndex={-1}>
          地点の設定
        </h2>
        <p className="setup-message" aria-live="polite">
          {setupMessage(state)}
        </p>

        <label className="setup-field">
          <span>標高（m）</span>
          <input
            className="setup-elevation"
            type="text"
            inputMode="decimal"
            value={state.elevationText}
            onChange={handleElevationChange}
          />
        </label>

        <p className="setup-error" aria-live="polite">
          {confirmErrorText(state)}
        </p>

        <div className="setup-actions">
          <button type="submit" className="setup-confirm" disabled={!confirmation.ok}>
            この場所で確定
          </button>
          {canCancelSetup(current) ? (
            <button type="button" className="setup-cancel" onClick={onCancel}>
              キャンセル
            </button>
          ) : null}
        </div>
      </form>

      <section className="setup-map" aria-label="地点を指定する地図">
        <MapContainer
          className="setup-map-container"
          center={[initial.center.lat, initial.center.lon]}
          zoom={SETUP_MAP_ZOOM}
        >
          <TileLayer url={OSM_TILE_URL} attribution={OSM_ATTRIBUTION} />
          <PinOnClick onPick={handlePick} />
          {recenter ? <CenterOn target={recenter} /> : null}
          {pinPosition !== undefined ? (
            <Marker
              position={pinPosition}
              icon={PIN_ICON}
              draggable
              title="観測地点（ドラッグで移動）"
              eventHandlers={markerHandlers}
            />
          ) : null}
        </MapContainer>
      </section>
    </main>
  );
}

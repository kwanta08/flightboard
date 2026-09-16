// 画面の骨組み（ヘッダー・左に一覧・右に地図の 2 ペイン・フッター）と、地点のセットアップとの切り替え。
// 判断は src/client/lib に置き、ここは描画と配線だけを行う。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Flight } from "../shared/types.ts";
import { DetailPanel } from "./components/DetailPanel.tsx";
import { FlightList } from "./components/FlightList.tsx";
import { ListToolbar } from "./components/ListToolbar.tsx";
import { MapPane } from "./components/MapPane.tsx";
import { SetupScreen } from "./components/SetupScreen.tsx";
import { useFlightDetail } from "./hooks/useFlightDetail.ts";
import { useNearby } from "./hooks/useNearby.ts";
import { CREDITS, DISCLAIMER } from "./lib/credits.ts";
import { detailRefreshKey, isDetailOpen, trackForSelection } from "./lib/detailState.ts";
import type { SortMode } from "./lib/flightRows.ts";
import {
  advanceWidenFocus,
  DEFAULT_KIND_OPTION,
  DEFAULT_RADIUS_KM,
  DEFAULT_SORT,
  focusAfterDetailClose,
  listBody,
  listRows,
  nearbyParamsFor,
  selectionAfterUserAction,
  widenPhaseAfterUserAction,
  type KindOptionValue,
  type WidenFocusPhase,
} from "./lib/listView.ts";
import {
  accessStorage,
  formatLocationHeader,
  loadLocation,
  saveLocation,
  type Location,
} from "./lib/locationStore.ts";
import { reuseTrack, type SelectedTrack } from "./lib/mapView.ts";
import { appScreen, focusTargetOnScreenChange, LOCATION_CHANGE_LABEL, type AppScreen } from "./lib/setupFlow.ts";

// App の状態が変わっても、セットアップ画面（地図とドラッグ中のピン）を描き直さない。
// そのため props（地点・見出しの ref・確定とキャンセル）は同じ値のまま渡す
const MemoizedSetupScreen = memo(SetupScreen);

// 一覧の並び替えや「半径を広げる」のフォーカス待ちで App が描き直されても、地図は props が変わったときだけ描き直す。
// そのため props（地点・機体の配列・選択の setter・航跡）は同じ値のまま渡し、毎秒変わる値は渡さない（1 秒ごとの補間は MapPane の中で進める）
const MemoizedMapPane = memo(MapPane);

/** データが無いときに地図へ渡す空の配列（描画のたびに新しい配列を作らない） */
const NO_FLIGHTS: readonly Flight[] = [];

export function App() {
  const [storage] = useState(() => accessStorage(() => window.localStorage));
  const [location, setLocation] = useState<Location | undefined>(() => loadLocation(storage));
  const [editing, setEditing] = useState(false);
  const previousScreen = useRef<AppScreen | undefined>(undefined);
  const setupHeadingRef = useRef<HTMLHeadingElement>(null);
  const locationChangeRef = useRef<HTMLButtonElement>(null);

  // 一覧の条件と選択（保存しない。plan p1b「仮決めした解釈」）
  const [radiusKm, setRadiusKm] = useState<number>(DEFAULT_RADIUS_KM);
  const [kindOption, setKindOption] = useState<KindOptionValue>(DEFAULT_KIND_OPTION);
  const [sortMode, setSortMode] = useState<SortMode>(DEFAULT_SORT);
  const [selectedHex, setSelectedHex] = useState<string | undefined>(undefined);

  // 「半径を広げる」の後にフォーカスを移す先の待ちと、移す先の要素
  const [widenPhase, setWidenPhase] = useState<WidenFocusPhase>("idle");
  const listRef = useRef<HTMLUListElement>(null);
  const widenButtonRef = useRef<HTMLButtonElement>(null);
  const radiusSelectRef = useRef<HTMLSelectElement>(null);

  // 利用者の操作の後、選択（詳細パネル）を保つか消すかは lib の表（selectionAfterUserAction）が決める
  const handleConfirm = useCallback(
    (next: Location) => {
      // 保存に失敗しても（localStorage が使えない等）この起動中は新しい地点で進める
      saveLocation(storage, next);
      setLocation(next);
      setEditing(false);
      setSelectedHex((hex) => selectionAfterUserAction(hex, "location-confirm"));
    },
    [storage],
  );

  const handleCancel = useCallback(() => {
    setEditing(false);
    setSelectedHex((hex) => selectionAfterUserAction(hex, "location-cancel"));
  }, []);

  const screen = appScreen(location, editing);

  const nearby = useNearby(nearbyParamsFor(screen, location, radiusKm, kindOption));
  // 行と本体は常に poller の状態（nearby）から作る（条件のキーが変わると poller がデータを消す）
  const rows = useMemo(() => listRows({ data: nearby.data, location, sortMode }), [nearby.data, location, sortMode]);
  const body = useMemo(
    () => listBody({ data: nearby.data, error: nearby.error, rows, radiusKm }),
    [nearby.data, nearby.error, rows, radiusKm],
  );

  // 選択中の機体の詳細（選択したときと、開いている間はポーリングの成功のたびに取り直す）。
  // 条件の変更で poller が receivedAt を消しても取り直さない（キーは lib の detailRefreshKey が前回の値を保つ）
  const previousRefreshKey = useRef<number | undefined>(undefined);
  const refreshKey = detailRefreshKey(nearby.receivedAt, previousRefreshKey.current);
  const detail = useFlightDetail(selectedHex, refreshKey);
  // 地図に渡す航跡（どの機体のものか付き）。詳細の状態（取り直し中・失敗など）が変わっても、
  // hex と点の配列が同じなら前回と同じ参照を渡す（地図の memo を保つ。使い回すかは lib の reuseTrack が決める）
  const previousTrack = useRef<SelectedTrack | undefined>(undefined);
  const track = reuseTrack(previousTrack.current, trackForSelection(detail, selectedHex));
  useEffect(() => {
    previousRefreshKey.current = refreshKey;
    previousTrack.current = track;
  });

  // 詳細パネルを閉じたら選択を解除し、パネルと一緒に消えるフォーカスを移す
  // （移す先は lib の focusAfterDetailClose。行が無く一覧を描画していなければ半径の選択欄）
  const handleDetailClose = useCallback(() => {
    setSelectedHex(undefined);
    const target = focusAfterDetailClose(body);
    if (target === "list") {
      listRef.current?.focus({ preventScroll: true });
    } else if (target === "radius-select") {
      radiusSelectRef.current?.focus({ preventScroll: true });
    }
  }, [body]);

  // 画面の切り替えで押したボタンが消えるので、フォーカスを移す先へ移す（初回の表示では移さない）
  useEffect(() => {
    const target = focusTargetOnScreenChange(previousScreen.current, screen);
    previousScreen.current = screen;
    if (target === "setup-heading") {
      setupHeadingRef.current?.focus();
    } else if (target === "location-change") {
      locationChangeRef.current?.focus();
    }
  }, [screen]);

  // 「半径を広げる」で押したボタンが取得し直す間に消えるので、新しい半径の結果が出たら移す先へ移す（待ちと移す先は lib が決める）
  useEffect(() => {
    const step = advanceWidenFocus(widenPhase, body);
    if (step.target === "list") {
      listRef.current?.focus();
    } else if (step.target === "widen-button") {
      widenButtonRef.current?.focus();
    } else if (step.target === "radius-select") {
      radiusSelectRef.current?.focus();
    }
    setWidenPhase(step.phase);
  }, [widenPhase, body]);

  const handleWidenRadius = (next: number) => {
    setRadiusKm(next);
    setWidenPhase("requested");
    setSelectedHex((hex) => selectionAfterUserAction(hex, "radius"));
  };

  // 利用者の操作の後、「半径を広げる」の後のフォーカスの待ちをやめるかは lib の表（widenPhaseAfterUserAction）が決める
  const handleSortChange = (next: SortMode) => {
    setSortMode(next);
    setWidenPhase((phase) => widenPhaseAfterUserAction(phase, "sort"));
    setSelectedHex((hex) => selectionAfterUserAction(hex, "sort"));
  };
  const handleKindChange = (next: KindOptionValue) => {
    setKindOption(next);
    setWidenPhase((phase) => widenPhaseAfterUserAction(phase, "kind"));
    setSelectedHex((hex) => selectionAfterUserAction(hex, "kind"));
  };
  const handleRadiusChange = (next: number) => {
    setRadiusKm(next);
    setWidenPhase((phase) => widenPhaseAfterUserAction(phase, "radius"));
    setSelectedHex((hex) => selectionAfterUserAction(hex, "radius"));
  };
  const handleLocationChange = () => {
    setEditing(true);
    setWidenPhase((phase) => widenPhaseAfterUserAction(phase, "location-change"));
    setSelectedHex((hex) => selectionAfterUserAction(hex, "location-change"));
  };
  // 一覧での選択と地図のアイコンでの選択は同じハンドラを通す。地図の memo を保つため参照は変えない
  const handleSelect = useCallback((hex: string) => {
    setSelectedHex(hex);
    setWidenPhase((phase) => widenPhaseAfterUserAction(phase, "select"));
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">FlightBoard</h1>
        <p className="app-location">{formatLocationHeader(location)}</p>
        {screen === "main" ? (
          <button
            type="button"
            className="app-location-change"
            ref={locationChangeRef}
            onClick={handleLocationChange}
          >
            {LOCATION_CHANGE_LABEL}
          </button>
        ) : null}
      </header>

      {screen === "setup" ? (
        <MemoizedSetupScreen
          current={location}
          headingRef={setupHeadingRef}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      ) : (
        <main className="app-main">
          <section className="pane pane-list" aria-label="周辺の機体の一覧">
            <ListToolbar
              state={nearby}
              sortMode={sortMode}
              kindOption={kindOption}
              radiusKm={radiusKm}
              radiusSelectRef={radiusSelectRef}
              onSortChange={handleSortChange}
              onKindChange={handleKindChange}
              onRadiusChange={handleRadiusChange}
            />
            <FlightList
              rows={rows}
              body={body}
              selectedHex={selectedHex}
              onSelect={handleSelect}
              onEscape={() => setSelectedHex(undefined)}
              onWidenRadius={handleWidenRadius}
              listRef={listRef}
              widenButtonRef={widenButtonRef}
            />
          </section>
          {/* 詳細パネルは地図の領域（section「地図」）の外で、地図より前に置く（タブ順を 一覧 → 詳細パネル → 地図のマーカー にする）。
              見た目は styles.css で地図の右側に重ねる。メイン画面では地点が決まっている（appScreen）。location の判定は型を絞り込むだけ */}
          <div className="pane pane-map">
            {location !== undefined && isDetailOpen(detail) ? (
              <DetailPanel state={detail} observer={location} onClose={handleDetailClose} />
            ) : null}
            <section className="map-frame" aria-label="地図">
              {location !== undefined ? (
                <MemoizedMapPane
                  observer={location}
                  radiusKm={radiusKm}
                  flights={nearby.data?.flights ?? NO_FLIGHTS}
                  receivedAt={nearby.receivedAt}
                  selectedHex={selectedHex}
                  onSelect={handleSelect}
                  track={track}
                />
              ) : null}
            </section>
          </div>
        </main>
      )}

      <footer className="app-footer">
        <ul className="credits" aria-label="データ提供元">
          {CREDITS.map((credit) => (
            <li key={credit.id}>
              <a href={credit.href} target="_blank" rel="noopener noreferrer">
                {credit.label}
              </a>
            </li>
          ))}
        </ul>
        <p className="disclaimer">{DISCLAIMER}</p>
      </footer>
    </div>
  );
}

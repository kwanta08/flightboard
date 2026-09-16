// 画面の骨組み（ヘッダー・左に一覧・右に地図の 2 ペイン・フッター）と、地点のセットアップとの切り替え。
// 判断は src/client/lib に置き、ここは描画と配線だけを行う。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Flight } from "../shared/types.ts";
import { DetailPanel } from "./components/DetailPanel.tsx";
import { FlightList } from "./components/FlightList.tsx";
import { ListToolbar } from "./components/ListToolbar.tsx";
import { MapPane } from "./components/MapPane.tsx";
import { SettingsScreen } from "./components/SettingsScreen.tsx";
import { SetupScreen } from "./components/SetupScreen.tsx";
import { useFlightDetail } from "./hooks/useFlightDetail.ts";
import { useNearby } from "./hooks/useNearby.ts";
import { CREDITS, DISCLAIMER } from "./lib/credits.ts";
import { detailRefreshKey, isDetailOpen, trackForSelection } from "./lib/detailState.ts";
import { airportOpsHeaderFor } from "./lib/estimateView.ts";
import type { SortMode } from "./lib/flightRows.ts";
import {
  advanceWidenFocus,
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
  applyLocationEdit,
  focusAfterRemoveLocation,
  formatLocationHeader,
  initLocations,
  locationEditMode,
  removeLocation,
  saveLocations,
  selectedLocation,
  selectLocation,
  type Location,
  type LocationBook,
  type LocationEditMode,
  type RemoveLocationFocus,
} from "./lib/locationStore.ts";
import { reuseTrack, type SelectedTrack } from "./lib/mapView.ts";
import {
  loadSettings,
  saveSettings,
  SETTINGS_OPEN_LABEL,
  withKindOption,
  withRadiusKm,
  type Settings,
} from "./lib/settingsStore.ts";
import { appScreen, focusTargetOnScreenChange, LOCATION_CHANGE_LABEL, type AppScreen } from "./lib/setupFlow.ts";

// App の状態が変わっても、セットアップ画面（地図とドラッグ中のピン）を描き直さない。
// そのため props（地点・開いた目的・見出しの ref・確定とキャンセル）は同じ値のまま渡す
// （確定のハンドラは一覧と目的を ref から読み、依存に入れない）
const MemoizedSetupScreen = memo(SetupScreen);

// 一覧の並び替えや「半径を広げる」のフォーカス待ちで App が描き直されても、地図は props が変わったときだけ描き直す。
// そのため props（地点・機体の配列・選択の setter・航跡）は同じ値のまま渡し、毎秒変わる値は渡さない（1 秒ごとの補間は MapPane の中で進める）
const MemoizedMapPane = memo(MapPane);

/** データが無いときに地図へ渡す空の配列（描画のたびに新しい配列を作らない） */
const NO_FLIGHTS: readonly Flight[] = [];

export function App() {
  const [storage] = useState(() => accessStorage(() => window.localStorage));
  // 登録した地点（v2。起動時に v1 から移行する）と設定。どちらも同じ 1 本のキーに保存する
  const [initial] = useState(() => initLocations(storage));
  const [book, setBook] = useState<LocationBook>(initial.book);
  const [settings, setSettings] = useState<Settings>(() => loadSettings(storage));
  // 地点か設定の保存に失敗しているか（設定画面に出す。plan「エラー処理について」2）。
  // 起動時の移行の書き出しの失敗もここから始める（読み取り専用の storage では、何も変えないうちから設定画面に出す）
  const [saveFailed, setSaveFailed] = useState(initial.saveFailed);
  // セットアップ画面を開いている目的（undefined なら開いていない）と、設定画面を開いているか
  const [editing, setEditing] = useState<LocationEditMode | undefined>(undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const previousScreen = useRef<AppScreen | undefined>(undefined);
  const setupHeadingRef = useRef<HTMLHeadingElement>(null);
  const settingsHeadingRef = useRef<HTMLHeadingElement>(null);
  const locationChangeRef = useRef<HTMLButtonElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const selectedLocationRef = useRef<HTMLInputElement>(null);
  // ［選択中の地点を削除］で押したボタンが無効になるとき、フォーカスを移す先（移す先は lib の focusAfterRemoveLocation が決める）
  const [removeFocus, setRemoveFocus] = useState<RemoveLocationFocus | undefined>(undefined);

  // 半径と表示する種類は設定（localStorage）に持つ。ツールバーから変えても設定へ書き戻す（二重管理にしない。F-09・F-03）
  const location = selectedLocation(book);
  const radiusKm = settings.radiusKm;
  const kindOption = settings.kindOption;
  // 高度・対地速度の表示の単位（AC-P2-72）。一覧の行と詳細パネルの両方へ同じ値を渡す
  const units = settings.units;

  // 一覧の並び替えと選択（保存しない。F-09 の項目ではない）
  const [sortMode, setSortMode] = useState<SortMode>(DEFAULT_SORT);
  const [selectedHex, setSelectedHex] = useState<string | undefined>(undefined);

  // 地点・設定の変更はこの 2 つを通して保存する（保存に失敗しても、この起動中は新しい値で進める）
  const applyBook = useCallback(
    (next: LocationBook) => {
      setBook(next);
      setSaveFailed(!saveLocations(storage, next));
    },
    [storage],
  );
  const applySettings = useCallback(
    (next: Settings) => {
      setSettings(next);
      setSaveFailed(!saveSettings(storage, next));
    },
    [storage],
  );

  // 「半径を広げる」の後にフォーカスを移す先の待ちと、移す先の要素
  const [widenPhase, setWidenPhase] = useState<WidenFocusPhase>("idle");
  const listRef = useRef<HTMLUListElement>(null);
  const widenButtonRef = useRef<HTMLButtonElement>(null);
  const radiusSelectRef = useRef<HTMLSelectElement>(null);

  // セットアップ画面を開いている間に App が描き直されても MemoizedSetupScreen の props を変えないため、
  // 確定のハンドラはいまの一覧と目的を ref から読む（依存を applyBook だけに保ち、ドラッグ中のピンを戻さない）。
  // 前提: セットアップ画面を出している間、book / editing は利用者の click でしか変わらない
  // （確定・地点の選択・削除はすべてクリック起点で、その間はポーリングも止まる。listView の nearbyParamsFor）。
  // ref の更新は useEffect なので、非同期に book を変える経路を足すと、描画と effect の間の確定が古い一覧を読む
  const bookRef = useRef(book);
  const editingRef = useRef(editing);
  useEffect(() => {
    bookRef.current = book;
    editingRef.current = editing;
  }, [book, editing]);

  // 利用者の操作の後、選択（詳細パネル）を保つか消すかは lib の表（selectionAfterUserAction）が決める
  const handleConfirm = useCallback(
    (next: Location) => {
      // 足すか置き換えるか（と目的が無いときの既定）は lib の locationEditMode・applyLocationEdit が決める
      applyBook(applyLocationEdit(bookRef.current, locationEditMode(editingRef.current), next));
      setEditing(undefined);
      setSelectedHex((hex) => selectionAfterUserAction(hex, "location-confirm"));
    },
    [applyBook],
  );

  const handleCancel = useCallback(() => {
    setEditing(undefined);
    setSelectedHex((hex) => selectionAfterUserAction(hex, "location-cancel"));
  }, []);

  const screen = appScreen(location, editing !== undefined, settingsOpen);
  // セットアップ画面を開いた目的（地点が無くて開いた初回は既定の change）
  const editMode = locationEditMode(editing);

  // 設定の更新間隔は poller に渡して、再読み込みなしで実行中のポーリングに反映する（AC-P2-74）
  const nearby = useNearby(nearbyParamsFor(screen, location, radiusKm, kindOption), settings.intervalMs);
  // 空港の運用方向（ヘッダーの表示と、詳細の「経路」の「運用方向」に使う）。
  // ヘッダーに出すかと文言は lib の airportOpsHeaderFor が決める（セットアップ画面・設定画面では undefined）
  const airportOps = nearby.data?.airportOps;
  const airportOpsHeader = airportOpsHeaderFor(screen, airportOps);
  // 行と本体は常に poller の状態（nearby）から作る（条件のキーが変わると poller がデータを消す）
  const rows = useMemo(
    () => listRows({ data: nearby.data, location, sortMode, units }),
    [nearby.data, location, sortMode, units],
  );
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
    } else if (target === "settings-heading") {
      settingsHeadingRef.current?.focus();
    } else if (target === "location-change") {
      locationChangeRef.current?.focus();
    } else if (target === "settings-button") {
      settingsButtonRef.current?.focus();
    }
  }, [screen]);

  // 地点を削除して［選択中の地点を削除］が無効になったら、描き直しの後にフォーカスを移す（移し終えたら待ちを解く）
  useEffect(() => {
    if (removeFocus === undefined) {
      return;
    }
    if (removeFocus === "selected-location") {
      selectedLocationRef.current?.focus();
    } else {
      // settings-heading（削除後の一覧が空）は画面の操作からは到達しない防御（lib の focusAfterRemoveLocation を見よ）
      settingsHeadingRef.current?.focus();
    }
    setRemoveFocus(undefined);
  }, [removeFocus]);

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
    applySettings(withRadiusKm(settings, next));
    setWidenPhase("requested");
    setSelectedHex((hex) => selectionAfterUserAction(hex, "radius"));
  };

  // 利用者の操作の後、「半径を広げる」の後のフォーカスの待ちをやめるかは lib の表（widenPhaseAfterUserAction）が決める
  const handleSortChange = (next: SortMode) => {
    setSortMode(next);
    setWidenPhase((phase) => widenPhaseAfterUserAction(phase, "sort"));
    setSelectedHex((hex) => selectionAfterUserAction(hex, "sort"));
  };
  // ツールバーでの変更も設定に書き戻す（設定画面と同じ値を見る。plan「仮決めした解釈」）
  const handleKindChange = (next: KindOptionValue) => {
    applySettings(withKindOption(settings, next));
    setWidenPhase((phase) => widenPhaseAfterUserAction(phase, "kind"));
    setSelectedHex((hex) => selectionAfterUserAction(hex, "kind"));
  };
  const handleRadiusChange = (next: number) => {
    applySettings(withRadiusKm(settings, next));
    setWidenPhase((phase) => widenPhaseAfterUserAction(phase, "radius"));
    setSelectedHex((hex) => selectionAfterUserAction(hex, "radius"));
  };
  // セットアップ画面を開く（一覧から離れるので、［地点を変更］と同じ扱いで待ちと選択を決める）
  const openSetup = (mode: LocationEditMode) => {
    setEditing(mode);
    setWidenPhase((phase) => widenPhaseAfterUserAction(phase, "location-change"));
    setSelectedHex((hex) => selectionAfterUserAction(hex, "location-change"));
  };
  const handleLocationChange = () => openSetup("change");
  const handleSettingsOpen = () => {
    setSettingsOpen(true);
    setWidenPhase((phase) => widenPhaseAfterUserAction(phase, "location-change"));
    setSelectedHex((hex) => selectionAfterUserAction(hex, "location-change"));
  };
  const handleSettingsClose = () => setSettingsOpen(false);
  // 地点の切り替えは地点の確定と同じ扱い（前の地点で選んだ機体の詳細を、新しい地点からの距離・方角で出したままにしない）
  const handleSelectLocation = (id: string) => {
    applyBook(selectLocation(book, id));
    setSelectedHex((hex) => selectionAfterUserAction(hex, "location-confirm"));
  };
  // 削除で［選択中の地点を削除］が無効になると、押したボタンからフォーカスが失われるので移す先を決めておく
  const handleRemoveLocation = (id: string) => {
    const next = removeLocation(book, id);
    applyBook(next);
    setRemoveFocus(focusAfterRemoveLocation(next));
    setSelectedHex((hex) => selectionAfterUserAction(hex, "location-confirm"));
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
        {/* 対象空港の運用方向（S-02・AC-P2-52）。S-02 の画面図どおり［変更］の後ろに置く。
            メイン画面では常に出し、まだ決まっていない空港は「判定中」と出す（出すかどうかも文言も lib/estimateView.ts） */}
        {airportOpsHeader !== undefined ? <p className="app-airport-ops">{airportOpsHeader}</p> : null}
        {/* ［設定］（S-02 の画面図どおり運用方向の後ろ）。設定画面・セットアップ画面では出さない（戻る先のボタンは各画面が持つ） */}
        {screen === "main" ? (
          <button type="button" className="app-settings-open" ref={settingsButtonRef} onClick={handleSettingsOpen}>
            {SETTINGS_OPEN_LABEL}
          </button>
        ) : null}
      </header>

      {screen === "setup" ? (
        <MemoizedSetupScreen
          current={location}
          mode={editMode}
          headingRef={setupHeadingRef}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      ) : screen === "settings" ? (
        <SettingsScreen
          book={book}
          settings={settings}
          saveFailed={saveFailed}
          headingRef={settingsHeadingRef}
          selectedLocationRef={selectedLocationRef}
          onSelectLocation={handleSelectLocation}
          onAddLocation={() => openSetup("add")}
          onEditLocation={() => openSetup("change")}
          onRemoveLocation={handleRemoveLocation}
          onSettingsChange={applySettings}
          onClose={handleSettingsClose}
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
              <DetailPanel
                state={detail}
                observer={location}
                airportOps={airportOps}
                units={units}
                onClose={handleDetailClose}
              />
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

import { describe, expect, it } from "vitest";
import type { Flight, NearbyResponse } from "../../shared/types.ts";
import { nearbyParamsKey, type NearbyParams } from "./api.ts";
import { buildRows, RADIUS_OPTIONS_KM, sortRows, summaryText, type SortMode } from "./flightRows.ts";
import type { Units } from "./format.ts";
import type { Location } from "./locationStore.ts";
import {
  activeDescendantId,
  advanceWidenFocus,
  DEFAULT_KIND_OPTION,
  DEFAULT_RADIUS_KM,
  DEFAULT_SORT,
  EMPTY_LIST_MESSAGE,
  flightRowId,
  focusAfterDetailClose,
  focusAfterWiden,
  isRowSelected,
  KIND_OPTIONS,
  kindOptionFromValue,
  listBody,
  listRows,
  nearbyParamsFor,
  RADIUS_OPTIONS,
  radiusFromValue,
  radiusOptionValue,
  ROW_CARGO_CLASS,
  ROW_CLASS,
  ROW_DIM_CLASS,
  ROW_SELECTED_CLASS,
  rowClassNames,
  rowElevationText,
  SELECTION_CLEARED_BY,
  selectionAfterUserAction,
  SORT_OPTIONS,
  sortModeFromValue,
  summaryFor,
  WIDEN_RADIUS_LABEL,
  WIDEN_WAIT_CANCELLED_BY,
  widenPhaseAfterUserAction,
  widenRadiusLabel,
  type KindOptionValue,
  type ListBody,
  type ListUserAction,
  type SelectionUserAction,
  type WidenFocusPhase,
} from "./listView.ts";
import { createPoller, type PollerState } from "./poller.ts";

// 仕様 6.5 の利用地点（流山）
const NAGAREYAMA: Location = { lat: 35.8709, lon: 139.9256, elevationM: 15 };

const UPDATED_AT = "2026-09-15T09:00:00.000Z";
const T0 = Date.parse(UPDATED_AT);

function makeFlight(overrides: Partial<Flight> & { hex: string }): Flight {
  return {
    position: { lat: 35.552299, lon: 139.779999, altitudeBaroFt: 3000, onGround: false },
    isMlat: false,
    seenPosSec: 0,
    kind: "passenger",
    source: "adsblol",
    ...overrides,
  };
}

function makeResponse(flights: Flight[]): NearbyResponse {
  return { updatedAt: UPDATED_AT, source: "adsblol", flights, airportOps: [] };
}

const ERROR = { at: T0 + 10_000, message: "サーバーに接続できませんでした" };

describe("並び替えの選択肢（AC-B5）", () => {
  it("近い順 / 仰角が高い順 / 高度順 / 便名順 の 4 種をこの順で持つ", () => {
    expect(SORT_OPTIONS).toEqual([
      { value: "distance", label: "近い順" },
      { value: "elevation", label: "仰角が高い順" },
      { value: "altitude", label: "高度順" },
      { value: "callsign", label: "便名順" },
    ]);
  });

  it("既定は近い順", () => {
    expect(DEFAULT_SORT).toBe("distance");
  });

  it("<select> の値を並び替えの種類に戻す。選択肢に無い値は undefined", () => {
    for (const option of SORT_OPTIONS) {
      expect(sortModeFromValue(option.value)).toBe(option.value);
    }
    expect(sortModeFromValue("speed")).toBeUndefined();
    expect(sortModeFromValue("")).toBeUndefined();
  });
});

describe("表示する種類の選択肢（AC-B5）", () => {
  it("旅客機＋貨物 / 旅客機のみ / 貨物のみ の 3 種をこの順で持つ", () => {
    expect(KIND_OPTIONS).toEqual([
      { value: "passenger,cargo", label: "旅客機＋貨物", kinds: ["passenger", "cargo"] },
      { value: "passenger", label: "旅客機のみ", kinds: ["passenger"] },
      { value: "cargo", label: "貨物のみ", kinds: ["cargo"] },
    ]);
  });

  it("既定は旅客機＋貨物", () => {
    expect(DEFAULT_KIND_OPTION).toBe("passenger,cargo");
  });

  it("<select> の値を表示する種類に戻す。選択肢に無い値は undefined", () => {
    for (const option of KIND_OPTIONS) {
      expect(kindOptionFromValue(option.value)).toBe(option.value);
    }
    expect(kindOptionFromValue("other")).toBeUndefined();
    expect(kindOptionFromValue("cargo,passenger")).toBeUndefined();
  });
});

describe("半径の選択肢（AC-B5）", () => {
  it("10 / 25 / 50 / 100 km に「半径 Nkm」の文言が付く", () => {
    expect(RADIUS_OPTIONS).toEqual([
      { km: 10, value: "10", label: "半径 10km" },
      { km: 25, value: "25", label: "半径 25km" },
      { km: 50, value: "50", label: "半径 50km" },
      { km: 100, value: "100", label: "半径 100km" },
    ]);
    expect(RADIUS_OPTIONS.map((option) => option.km)).toEqual([...RADIUS_OPTIONS_KM]);
  });

  it("既定は 50km で、選択肢に含まれる", () => {
    expect(DEFAULT_RADIUS_KM).toBe(50);
    expect(RADIUS_OPTIONS.some((option) => option.km === DEFAULT_RADIUS_KM)).toBe(true);
  });

  it("<select> の値と半径を往復できる。選択肢に無い値は undefined", () => {
    for (const km of RADIUS_OPTIONS_KM) {
      expect(radiusFromValue(radiusOptionValue(km))).toBe(km);
    }
    expect(radiusFromValue("30")).toBeUndefined();
    expect(radiusFromValue("")).toBeUndefined();
    expect(radiusFromValue("abc")).toBeUndefined();
  });
});

describe("nearbyParamsFor（取得の条件）", () => {
  it("セットアップ画面の間は、地点があっても undefined（取得しない）", () => {
    expect(nearbyParamsFor("setup", NAGAREYAMA, 50, "passenger,cargo")).toBeUndefined();
    expect(nearbyParamsFor("setup", undefined, 50, "passenger,cargo")).toBeUndefined();
  });

  it("メイン画面でも地点が無ければ undefined（取得しない）", () => {
    expect(nearbyParamsFor("main", undefined, 50, "passenger,cargo")).toBeUndefined();
  });

  // 設定画面では半径・更新間隔を変えられる。止めずに続けて、戻ったときには新しい条件の結果が出ているようにする（W6）
  it("設定画面の間は止めない（メイン画面と同じ条件）", () => {
    expect(nearbyParamsFor("settings", NAGAREYAMA, 50, "passenger,cargo")).toStrictEqual(
      nearbyParamsFor("main", NAGAREYAMA, 50, "passenger,cargo"),
    );
  });

  it("メイン画面では地点の緯度・経度と半径を渡す（標高は送らない）", () => {
    expect(nearbyParamsFor("main", NAGAREYAMA, 25, "passenger,cargo")).toStrictEqual({
      lat: 35.8709,
      lon: 139.9256,
      radiusKm: 25,
      kinds: ["passenger", "cargo"],
    });
  });

  it.each([
    ["passenger,cargo", ["passenger", "cargo"]],
    ["passenger", ["passenger"]],
    ["cargo", ["cargo"]],
  ] as const)("種類 %s → kinds %j", (kindOption, kinds) => {
    expect(nearbyParamsFor("main", NAGAREYAMA, 50, kindOption)?.kinds).toEqual(kinds);
  });

  it("各選択肢の kinds がそのまま条件になる", () => {
    for (const option of KIND_OPTIONS) {
      expect(nearbyParamsFor("main", NAGAREYAMA, DEFAULT_RADIUS_KM, option.value)?.kinds).toEqual(option.kinds);
    }
  });
});

describe("listRows（一覧に出す行）", () => {
  const flights = [
    makeFlight({ hex: "far000" }), // RJTT 上空（約 37.8km）
    makeFlight({ hex: "near00", position: { lat: 35.9, lon: 139.93, altitudeBaroFt: 5000, onGround: false } }),
  ];

  it("応答が無ければ空", () => {
    expect(listRows({ data: undefined, location: NAGAREYAMA, sortMode: "distance" })).toEqual([]);
  });

  it("地点が無ければ空", () => {
    expect(listRows({ data: makeResponse(flights), location: undefined, sortMode: "distance" })).toEqual([]);
  });

  it.each(["distance", "elevation", "altitude", "callsign"] as const satisfies readonly SortMode[])(
    "buildRows → sortRows（%s）と同じ行と順序",
    (sortMode) => {
      const rows = listRows({ data: makeResponse(flights), location: NAGAREYAMA, sortMode });
      expect(rows).toEqual(sortRows(buildRows(flights, NAGAREYAMA), sortMode));
    },
  );

  it("route の無い機体も行にする（件数が応答の機体数と同じ）", () => {
    const withoutRoute = makeFlight({ hex: "noroute" });
    const rows = listRows({ data: makeResponse([...flights, withoutRoute]), location: NAGAREYAMA, sortMode: "distance" });
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.hex === "noroute")?.routeText).toBeUndefined();
  });
});

describe("listRows: 表示の単位（AC-P2-72）", () => {
  const FEET_AND_KNOTS: Units = { altitude: "ft", speed: "kt" };
  const flights = [makeFlight({ hex: "unit00", groundSpeedKt: 250 })];
  const rowsWith = (units?: Units) =>
    listRows({ data: makeResponse(flights), location: NAGAREYAMA, sortMode: "distance", units });

  it("渡した単位が行の高度・対地速度に出る（buildRows へそのまま通す）", () => {
    expect(rowsWith(FEET_AND_KNOTS)).toEqual(sortRows(buildRows(flights, NAGAREYAMA, FEET_AND_KNOTS), "distance"));
    expect(rowsWith(FEET_AND_KNOTS)[0]?.altitudeText).toBe("3,000ft");
    expect(rowsWith(FEET_AND_KNOTS)[0]?.speedText).toBe("250kt");
  });

  it("単位を渡さなければ m・km/h（既定）", () => {
    expect(rowsWith()[0]?.altitudeText).toBe("910m");
    expect(rowsWith()[0]?.speedText).toBe("463km/h");
  });
});

describe("listBody（一覧の本体に出すもの）", () => {
  const oneRow = buildRows([makeFlight({ hex: "abc123" })], NAGAREYAMA);

  it("応答がまだ無く失敗も無い → loading", () => {
    expect(listBody({ data: undefined, error: undefined, rows: [], radiusKm: 50 })).toEqual({ kind: "loading" });
  });

  it("応答が無いまま失敗した → unavailable（0 件の案内は出さない）", () => {
    expect(listBody({ data: undefined, error: ERROR, rows: [], radiusKm: 50 })).toEqual({ kind: "unavailable" });
  });

  it.each([
    [10, 25],
    [25, 50],
    [50, 100],
  ])("応答があり 0 件・半径 %s km → empty、widenTo は %s km", (radiusKm, widenTo) => {
    expect(listBody({ data: makeResponse([]), error: undefined, rows: [], radiusKm })).toStrictEqual({
      kind: "empty",
      message: "近くに飛行機はいません",
      widenTo,
    });
  });

  it("応答があり 0 件・半径 100km → empty で widenTo 無し（これ以上広げない）", () => {
    expect(listBody({ data: makeResponse([]), error: undefined, rows: [], radiusKm: 100 })).toStrictEqual({
      kind: "empty",
      message: "近くに飛行機はいません",
    });
  });

  it("0 件の文言は AC-B7 の文と一字一句同じ", () => {
    expect(EMPTY_LIST_MESSAGE).toBe("近くに飛行機はいません");
  });

  it("行がある → rows", () => {
    expect(listBody({ data: makeResponse([makeFlight({ hex: "abc123" })]), error: undefined, rows: oneRow, radiusKm: 50 })).toEqual({
      kind: "rows",
    });
  });

  it("失敗中でも最後の応答の行があれば rows（行を残す、AC-B9）", () => {
    expect(listBody({ data: makeResponse([makeFlight({ hex: "abc123" })]), error: ERROR, rows: oneRow, radiusKm: 50 })).toEqual({
      kind: "rows",
    });
  });

  it("失敗中で最後の応答が 0 件なら empty", () => {
    expect(listBody({ data: makeResponse([]), error: ERROR, rows: [], radiusKm: 25 })).toStrictEqual({
      kind: "empty",
      message: "近くに飛行機はいません",
      widenTo: 50,
    });
  });
});

describe("widenRadiusLabel（AC-B7）", () => {
  it("「半径を広げる（Nkm）」", () => {
    expect(widenRadiusLabel(25)).toBe("半径を広げる（25km）");
    expect(widenRadiusLabel(100)).toBe("半径を広げる（100km）");
  });

  it("AC-B7 の「半径を広げる」を含む", () => {
    expect(WIDEN_RADIUS_LABEL).toBe("半径を広げる");
    expect(widenRadiusLabel(50).startsWith("半径を広げる")).toBe(true);
  });
});

describe("rowClassNames（AC-B6・AC-B8）", () => {
  it("visible の旅客機・未選択 → 行のクラスだけ", () => {
    expect(rowClassNames({ visibility: "visible", isCargo: false }, false)).toBe("flight-row");
  });

  it("仰角が無い（visibility 無し）→ 薄くしない", () => {
    expect(rowClassNames({ visibility: undefined, isCargo: false }, false)).toBe("flight-row");
  });

  it("hard（仰角 10° 未満）→ 薄く表示するクラス", () => {
    expect(rowClassNames({ visibility: "hard", isCargo: false }, false).split(" ")).toEqual([ROW_CLASS, ROW_DIM_CLASS]);
  });

  it("belowHorizon（仰角 0° 未満）→ 薄く表示するクラス", () => {
    expect(rowClassNames({ visibility: "belowHorizon", isCargo: false }, false).split(" ")).toEqual([ROW_CLASS, ROW_DIM_CLASS]);
  });

  it("選択中 → 選択のクラス", () => {
    expect(rowClassNames({ visibility: "visible", isCargo: false }, true).split(" ")).toEqual([ROW_CLASS, ROW_SELECTED_CLASS]);
  });

  it("貨物 → 貨物のクラス", () => {
    expect(rowClassNames({ visibility: "visible", isCargo: true }, false).split(" ")).toEqual([ROW_CLASS, ROW_CARGO_CLASS]);
  });

  it("薄い・選択中・貨物を併せ持てる", () => {
    expect(rowClassNames({ visibility: "hard", isCargo: true }, true).split(" ")).toEqual([
      ROW_CLASS,
      ROW_DIM_CLASS,
      ROW_SELECTED_CLASS,
      ROW_CARGO_CLASS,
    ]);
  });

  it("buildRows の行（流山から RJTT 上空 3000ft・仰角約 1.2°）は薄く表示する", () => {
    const [row] = buildRows([makeFlight({ hex: "86e7a0" })], NAGAREYAMA);
    expect(row?.visibility).toBe("hard");
    expect(rowClassNames(row!, false)).toContain(ROW_DIM_CLASS);
  });
});

describe("選択と行の id（AC-B8）", () => {
  const rows = [{ hex: "aaa111" }, { hex: "bbb222" }];

  it("isRowSelected は hex が選択中と同じときだけ true", () => {
    expect(isRowSelected("aaa111", "aaa111")).toBe(true);
    expect(isRowSelected("aaa111", "bbb222")).toBe(false);
    expect(isRowSelected("aaa111", undefined)).toBe(false);
  });

  it("行の id は hex ごとに異なる", () => {
    expect(flightRowId("aaa111")).not.toBe(flightRowId("bbb222"));
    expect(flightRowId("aaa111")).toContain("aaa111");
  });

  it("activeDescendantId: 選択中の機体が一覧にあればその行の id", () => {
    expect(activeDescendantId(rows, "bbb222")).toBe(flightRowId("bbb222"));
  });

  it("activeDescendantId: 未選択・一覧に無い機体なら undefined", () => {
    expect(activeDescendantId(rows, undefined)).toBeUndefined();
    expect(activeDescendantId(rows, "gone00")).toBeUndefined();
    expect(activeDescendantId([], "aaa111")).toBeUndefined();
  });

  it("選択の hex が大文字でも同じ機体の行を選択中とし、行の id は行の hex で作る（結合レビュー MINOR-6）", () => {
    expect(isRowSelected("bbb222", "BBB222")).toBe(true);
    expect(isRowSelected("aaa111", "BBB222")).toBe(false);
    expect(activeDescendantId(rows, "BBB222")).toBe(flightRowId("bbb222"));
  });
});

describe("rowElevationText（S-02「仰角 32°」）", () => {
  it("仰角の値に見出しを添える", () => {
    expect(rowElevationText({ elevationText: "1.1°" })).toBe("仰角 1.1°");
  });

  it("値が無い「—」でも見出しを添える", () => {
    expect(rowElevationText({ elevationText: "—" })).toBe("仰角 —");
  });
});

describe("summaryFor（AC-B5・AC-B9、計画 M3-1）", () => {
  const flights = [makeFlight({ hex: "a00001" }), makeFlight({ hex: "a00002" }), makeFlight({ hex: "a00003" })];

  it("成功時: summaryText と同じ「周辺 N 機・X 秒前に更新」", () => {
    const state = { data: makeResponse(flights), error: undefined };
    const { text } = summaryFor(state, T0 + 5_400);
    expect(text).toBe(summaryText({ count: 3, updatedAt: UPDATED_AT, now: T0 + 5_400, failed: false }));
    expect(text).toBe("周辺 3 機・5 秒前に更新");
  });

  it("件数は一覧の行数と同じ（route の無い機体を含む）", () => {
    const data = makeResponse(flights);
    const rows = listRows({ data, location: NAGAREYAMA, sortMode: "distance" });
    expect(summaryFor({ data, error: undefined }, T0).text).toBe(`周辺 ${rows.length} 機・0 秒前に更新`);
  });

  it("失敗時（データあり）: summaryText と同じ「更新できません（N 秒前のデータ）」", () => {
    const state = { data: makeResponse(flights), error: ERROR };
    const { text } = summaryFor(state, T0 + 25_000);
    expect(text).toBe(summaryText({ count: 3, updatedAt: UPDATED_AT, now: T0 + 25_000, failed: true }));
    expect(text).toBe("更新できません（25 秒前のデータ）");
  });

  it("失敗から成功に戻ると通常の文言になる", () => {
    const failing = summaryFor({ data: makeResponse(flights), error: ERROR }, T0 + 20_000).text;
    const recovered = summaryFor({ data: makeResponse(flights), error: undefined }, T0 + 20_000).text;
    expect(failing).toBe("更新できません（20 秒前のデータ）");
    expect(recovered).toBe("周辺 3 機・20 秒前に更新");
  });

  it("データが一度も無いまま失敗: 「更新できません」", () => {
    expect(summaryFor({ data: undefined, error: ERROR }, T0).text).toBe(
      summaryText({ count: 0, updatedAt: undefined, now: T0, failed: true }),
    );
    expect(summaryFor({ data: undefined, error: ERROR }, T0).text).toBe("更新できません");
  });

  it("初回取得前: 「取得中…」", () => {
    expect(summaryFor({ data: undefined, error: undefined }, T0).text).toBe("取得中…");
  });

  it("秒数は now に合わせて進む", () => {
    const state = { data: makeResponse(flights), error: undefined };
    expect(summaryFor(state, T0 + 1_000).text).toBe("周辺 3 機・1 秒前に更新");
    expect(summaryFor(state, T0 + 2_000).text).toBe("周辺 3 機・2 秒前に更新");
  });
});

describe("summaryFor の detail（失敗の文言を要約のツールチップに出す、結合レビュー MINOR-2）", () => {
  const flights = [makeFlight({ hex: "a00001" })];

  it("失敗中（データあり）は detail がエラーの文言。要約の文言はそのまま", () => {
    expect(summaryFor({ data: makeResponse(flights), error: ERROR }, T0 + 25_000)).toStrictEqual({
      text: "更新できません（25 秒前のデータ）",
      detail: "サーバーに接続できませんでした",
    });
  });

  it("データが一度も無いまま失敗しても detail がエラーの文言", () => {
    expect(summaryFor({ data: undefined, error: { at: T0, message: "応答がありません" } }, T0)).toStrictEqual({
      text: "更新できません",
      detail: "応答がありません",
    });
  });

  it("成功中は detail 無し", () => {
    const summary = summaryFor({ data: makeResponse(flights), error: undefined }, T0);
    expect(summary).toStrictEqual({ text: "周辺 1 機・0 秒前に更新" });
    expect("detail" in summary).toBe(false);
  });

  it("読み込み中（初回取得前）は detail 無し", () => {
    const summary = summaryFor({ data: undefined, error: undefined }, T0);
    expect(summary).toStrictEqual({ text: "取得中…" });
    expect("detail" in summary).toBe(false);
  });

  it("失敗中は detail があり、成功に戻ると detail が消える（入ると抜けるを対で）", () => {
    const failing = summaryFor({ data: makeResponse(flights), error: ERROR }, T0 + 20_000);
    const recovered = summaryFor({ data: makeResponse(flights), error: undefined }, T0 + 20_000);
    expect(failing.detail).toBe(ERROR.message);
    expect(recovered.detail).toBeUndefined();
  });
});

// ---- 条件の変更と poller（MAJOR-1: 古い条件のデータを新しい条件で描画しない） ----

// 外洋（ブラウザ受入確認 8 の地点）
const OCEAN: Location = { lat: 30.0, lon: 150.0, elevationM: 0 };

/** メイン画面での取得条件（地点があるので必ず決まる） */
function paramsAt(location: Location, radiusKm: number, kindOption: KindOptionValue = DEFAULT_KIND_OPTION): NearbyParams {
  const params = nearbyParamsFor("main", location, radiusKm, kindOption);
  if (params === undefined) throw new Error("取得条件が決まりません");
  return params;
}

/** 決着済みの Promise のコールバックを流す（poller のタイマーは注入しているので実時間は進めない） */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * useNearby と同じ条件のキー（nearbyParamsKey）を使う実際の poller。
 * load は手で決着させ、タイマー（刻み・期限）は動かさない。常に表示中
 */
function nearbyPoller() {
  type LoadCall = { params: NearbyParams; resolve(data: NearbyResponse): void; reject(error: unknown): void };
  const calls: LoadCall[] = [];
  const clock = { now: T0 };
  const poller = createPoller<NearbyParams>({
    load: (params) =>
      new Promise<NearbyResponse>((resolve, reject) => {
        calls.push({ params, resolve, reject });
      }),
    timers: { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} },
    paramsKey: nearbyParamsKey,
    visibility: { isVisible: () => true, subscribe: () => () => {} },
    now: () => clock.now,
  });
  const call = (index: number): LoadCall => {
    const found = calls[index];
    if (found === undefined) throw new Error(`load の ${index + 1} 回目の呼び出しがありません`);
    return found;
  };
  return { poller, call, clock };
}

/** App と同じ組み立てで、poller の状態と現在の条件（地点・半径）から一覧の行・本体・要約を作る */
function viewOf(state: PollerState, location: Location, radiusKm: number, now: number) {
  const rows = listRows({ data: state.data, location, sortMode: DEFAULT_SORT });
  const summary = summaryFor(state, now);
  return {
    rows,
    body: listBody({ data: state.data, error: state.error, rows, radiusKm }),
    summary: summary.text,
    summaryDetail: summary.detail,
  };
}

describe("条件の変更と一覧の表示（poller が条件のキーの変更でデータを消す、MAJOR-1）", () => {
  const flights = [
    makeFlight({ hex: "far000" }),
    makeFlight({ hex: "near00", position: { lat: 35.9, lon: 139.93, altitudeBaroFt: 5000, onGround: false } }),
  ];

  it("半径を広げた直後: data・error が無く、loading・行は空・「取得中…」で、次の段の「半径を広げる」を出さない", async () => {
    const { poller, call } = nearbyPoller();
    poller.start(paramsAt(NAGAREYAMA, 10));
    call(0).resolve(makeResponse([]));
    await flush();
    expect(viewOf(poller.getState(), NAGAREYAMA, 10, T0).body).toStrictEqual({
      kind: "empty",
      message: EMPTY_LIST_MESSAGE,
      widenTo: 25,
    });

    poller.setParams(paramsAt(NAGAREYAMA, 25));
    const state = poller.getState();
    expect(state.data).toBeUndefined();
    expect(state.error).toBeUndefined();
    const view = viewOf(state, NAGAREYAMA, 25, T0 + 1_000);
    expect(view.body).toStrictEqual({ kind: "loading" });
    expect(view.rows).toEqual([]);
    expect(view.summary).toBe("取得中…");
  });

  it("地点を変えた直後: 旧地点の機体を新しい地点からの距離で並べない（行は空・loading・「取得中…」）", async () => {
    const { poller, call } = nearbyPoller();
    poller.start(paramsAt(NAGAREYAMA, 50));
    call(0).resolve(makeResponse(flights));
    await flush();
    expect(viewOf(poller.getState(), NAGAREYAMA, 50, T0).rows).toHaveLength(2);

    poller.setParams(paramsAt(OCEAN, 50));
    const view = viewOf(poller.getState(), OCEAN, 50, T0 + 1_000);
    expect(view.rows).toEqual([]);
    expect(view.body).toStrictEqual({ kind: "loading" });
    expect(view.summary).toBe("取得中…");
  });

  it("種類を変えた直後も、旧条件の行を出さない", async () => {
    const { poller, call } = nearbyPoller();
    poller.start(paramsAt(NAGAREYAMA, 50, "passenger,cargo"));
    call(0).resolve(makeResponse(flights));
    await flush();

    poller.setParams(paramsAt(NAGAREYAMA, 50, "cargo"));
    const view = viewOf(poller.getState(), NAGAREYAMA, 50, T0 + 1_000);
    expect(view.rows).toEqual([]);
    expect(view.body).toStrictEqual({ kind: "loading" });
  });

  it("条件を変えた後に失敗: 旧条件のデータは戻らず unavailable・行は空・「更新できません」", async () => {
    const { poller, call, clock } = nearbyPoller();
    poller.start(paramsAt(NAGAREYAMA, 10));
    call(0).resolve(makeResponse(flights));
    await flush();

    poller.setParams(paramsAt(NAGAREYAMA, 25));
    clock.now = T0 + 5_000;
    call(1).reject(new Error("サーバーに接続できませんでした"));
    await flush();
    const state = poller.getState();
    expect(state.data).toBeUndefined();
    expect(state.error).toBeDefined();
    const view = viewOf(state, NAGAREYAMA, 25, T0 + 6_000);
    expect(view.body).toStrictEqual({ kind: "unavailable" });
    expect(view.rows).toEqual([]);
    expect(view.summary).toBe("更新できません");
  });

  it("同じ条件での失敗: 行を残し、「更新できません（N 秒前のデータ）」", async () => {
    const { poller, call, clock } = nearbyPoller();
    poller.start(paramsAt(NAGAREYAMA, 50));
    call(0).resolve(makeResponse(flights));
    await flush();

    poller.setParams(paramsAt(NAGAREYAMA, 50)); // 別のオブジェクトだが同じ条件（キー）
    clock.now = T0 + 20_000;
    call(1).reject(new Error("サーバーに接続できませんでした"));
    await flush();
    const state = poller.getState();
    expect(state.data).toEqual(makeResponse(flights));
    expect(state.error).toBeDefined();
    const view = viewOf(state, NAGAREYAMA, 50, T0 + 25_000);
    expect(view.rows).toHaveLength(2);
    expect(view.body).toStrictEqual({ kind: "rows" });
    expect(view.summary).toBe("更新できません（25 秒前のデータ）");
  });

  it("poller の失敗の文言が要約の detail に届き、次の成功で消える（結合レビュー MINOR-2）", async () => {
    const { poller, call, clock } = nearbyPoller();
    poller.start(paramsAt(NAGAREYAMA, 50));
    call(0).resolve(makeResponse(flights));
    await flush();
    expect(viewOf(poller.getState(), NAGAREYAMA, 50, T0).summaryDetail).toBeUndefined();

    poller.setParams(paramsAt(NAGAREYAMA, 50)); // 同じ条件で即 1 本
    clock.now = T0 + 10_000;
    call(1).reject(new Error("サーバーに接続できませんでした"));
    await flush();
    const failing = viewOf(poller.getState(), NAGAREYAMA, 50, T0 + 12_000);
    expect(failing.summary).toBe("更新できません（12 秒前のデータ）");
    expect(failing.summaryDetail).toBe("サーバーに接続できませんでした");

    poller.setParams(paramsAt(NAGAREYAMA, 50));
    call(2).resolve(makeResponse(flights));
    await flush();
    const recovered = viewOf(poller.getState(), NAGAREYAMA, 50, T0 + 12_000);
    expect(recovered.summary).toBe("周辺 2 機・12 秒前に更新");
    expect(recovered.summaryDetail).toBeUndefined();
  });
});

// ---- 「半径を広げる」の後のフォーカス（MINOR-2） ----

const LOADING_BODY = listBody({ data: undefined, error: undefined, rows: [], radiusKm: 50 });
const UNAVAILABLE_BODY = listBody({ data: undefined, error: ERROR, rows: [], radiusKm: 50 });
const EMPTY_WIDEN_BODY = listBody({ data: makeResponse([]), error: undefined, rows: [], radiusKm: 25 });
const EMPTY_LAST_BODY = listBody({ data: makeResponse([]), error: undefined, rows: [], radiusKm: 100 });
const ROWS_BODY = listBody({
  data: makeResponse([makeFlight({ hex: "abc123" })]),
  error: undefined,
  rows: buildRows([makeFlight({ hex: "abc123" })], NAGAREYAMA),
  radiusKm: 50,
});

const ALL_BODIES: ReadonlyArray<[string, ListBody]> = [
  ["loading", LOADING_BODY],
  ["unavailable", UNAVAILABLE_BODY],
  ["empty（次の段あり）", EMPTY_WIDEN_BODY],
  ["empty（100km）", EMPTY_LAST_BODY],
  ["rows", ROWS_BODY],
];

describe("focusAfterWiden（「半径を広げる」の後のフォーカス、AC-B7・AC-B8）", () => {
  it("前提: 各本体の種類", () => {
    expect(LOADING_BODY).toStrictEqual({ kind: "loading" });
    expect(UNAVAILABLE_BODY).toStrictEqual({ kind: "unavailable" });
    expect(EMPTY_WIDEN_BODY).toStrictEqual({ kind: "empty", message: EMPTY_LIST_MESSAGE, widenTo: 50 });
    expect(EMPTY_LAST_BODY).toStrictEqual({ kind: "empty", message: EMPTY_LIST_MESSAGE });
    expect(ROWS_BODY).toStrictEqual({ kind: "rows" });
  });

  it.each(ALL_BODIES)("待っていない（pending: false）→ %s でも undefined", (_label, body) => {
    expect(focusAfterWiden(false, body)).toBeUndefined();
  });

  it("待っていて取得中（loading）→ undefined（まだ待つ）", () => {
    expect(focusAfterWiden(true, LOADING_BODY)).toBeUndefined();
  });

  it("待っていて失敗（unavailable）→ undefined（新しい半径の結果ではない。失敗で待ちを終えるかは advanceWidenFocus）", () => {
    expect(focusAfterWiden(true, UNAVAILABLE_BODY)).toBeUndefined();
  });

  it("行が出た → 一覧", () => {
    expect(focusAfterWiden(true, ROWS_BODY)).toBe("list");
  });

  it("広げても 0 件で次の段がある → 次の段の「半径を広げる」", () => {
    expect(focusAfterWiden(true, EMPTY_WIDEN_BODY)).toBe("widen-button");
  });

  it("100km まで広げても 0 件（次の段が無い）→ 半径の選択欄", () => {
    expect(focusAfterWiden(true, EMPTY_LAST_BODY)).toBe("radius-select");
  });
});

describe("advanceWidenFocus（「半径を広げる」の後の待ちの進め方）", () => {
  it.each(ALL_BODIES)("idle → %s でも idle のまま、移さない", (_label, body) => {
    expect(advanceWidenFocus("idle", body)).toStrictEqual({ phase: "idle" });
  });

  it.each([
    ["empty（次の段あり）", EMPTY_WIDEN_BODY],
    ["empty（100km）", EMPTY_LAST_BODY],
    ["rows", ROWS_BODY],
  ] as const)("requested で %s（古い半径の表示が残っている）→ requested のまま、移さない", (_label, body) => {
    expect(advanceWidenFocus("requested", body)).toStrictEqual({ phase: "requested" });
  });

  it.each([
    ["loading", LOADING_BODY],
    ["unavailable", UNAVAILABLE_BODY],
  ] as const)("requested で %s（古いデータが消えた）→ waiting、まだ移さない", (_label, body) => {
    expect(advanceWidenFocus("requested", body)).toStrictEqual({ phase: "waiting" });
  });

  it("waiting で loading → waiting のまま", () => {
    expect(advanceWidenFocus("waiting", LOADING_BODY)).toStrictEqual({ phase: "waiting" });
  });

  it("waiting で unavailable（新しい半径の取得に失敗）→ 半径の選択欄へ移して idle に戻る（待ちに上限を設ける）", () => {
    expect(advanceWidenFocus("waiting", UNAVAILABLE_BODY)).toStrictEqual({ phase: "idle", target: "radius-select" });
  });

  it("一覧へ移す（list）のは本体が rows のときだけ（FlightList は rows のときだけ一覧を描画するので、移す先の要素が必ずある）", () => {
    const phases: readonly WidenFocusPhase[] = ["idle", "requested", "waiting"];
    const listTargets = phases.flatMap((phase) =>
      ALL_BODIES.filter(([, body]) => advanceWidenFocus(phase, body).target === "list").map(([label]) => `${phase}×${label}`),
    );
    expect(listTargets).toStrictEqual(["waiting×rows"]);
  });

  it.each([
    ["rows", "list", ROWS_BODY],
    ["empty（次の段あり）", "widen-button", EMPTY_WIDEN_BODY],
    ["empty（100km）", "radius-select", EMPTY_LAST_BODY],
  ] as const)("waiting で %s → 移す先 %s を返して idle に戻る", (_label, target, body) => {
    expect(advanceWidenFocus("waiting", body)).toStrictEqual({ phase: "idle", target });
  });

  it("poller と組み合わせて: 押した直後の描画（古い 0 件）では移さず、データが消えてから新しい半径の結果で移す", async () => {
    const { poller, call } = nearbyPoller();
    poller.start(paramsAt(NAGAREYAMA, 10));
    call(0).resolve(makeResponse([]));
    await flush();

    // 押した直後の描画: 半径は 25km だが、poller はまだ 10km の 0 件を持っている
    let phase: WidenFocusPhase = "requested";
    const stale = advanceWidenFocus(phase, viewOf(poller.getState(), NAGAREYAMA, 25, T0).body);
    expect(stale).toStrictEqual({ phase: "requested" });
    phase = stale.phase;

    // useNearby が条件を渡す → データが消える
    poller.setParams(paramsAt(NAGAREYAMA, 25));
    const cleared = advanceWidenFocus(phase, viewOf(poller.getState(), NAGAREYAMA, 25, T0).body);
    expect(cleared).toStrictEqual({ phase: "waiting" });
    phase = cleared.phase;

    // 25km でも 0 件 → 次の段（50km）の「半径を広げる」へ
    call(1).resolve(makeResponse([]));
    await flush();
    expect(advanceWidenFocus(phase, viewOf(poller.getState(), NAGAREYAMA, 25, T0).body)).toStrictEqual({
      phase: "idle",
      target: "widen-button",
    });
  });

  it("poller と組み合わせて: 新しい半径の取得に失敗したら半径の選択欄へ移して待ちを終え、後から再試行が成功しても移さない", async () => {
    const { poller, call, clock } = nearbyPoller();
    poller.start(paramsAt(NAGAREYAMA, 10));
    call(0).resolve(makeResponse([]));
    await flush();

    // 押した後、useNearby が新しい半径の条件を渡す → データが消える
    let phase: WidenFocusPhase = "requested";
    poller.setParams(paramsAt(NAGAREYAMA, 25));
    const cleared = advanceWidenFocus(phase, viewOf(poller.getState(), NAGAREYAMA, 25, T0).body);
    expect(cleared).toStrictEqual({ phase: "waiting" });
    phase = cleared.phase;

    // 25km の取得に失敗 → 半径の選択欄へ移して待ちを終える
    clock.now = T0 + 5_000;
    call(1).reject(new Error("サーバーに接続できませんでした"));
    await flush();
    const failed = advanceWidenFocus(phase, viewOf(poller.getState(), NAGAREYAMA, 25, T0 + 5_000).body);
    expect(failed).toStrictEqual({ phase: "idle", target: "radius-select" });
    phase = failed.phase;

    // 数十秒後の再試行（刻みの代わりに同じ条件で送り直す）で行が出ても、フォーカスは移さない
    clock.now = T0 + 40_000;
    poller.setParams(paramsAt(NAGAREYAMA, 25));
    call(2).resolve(makeResponse([makeFlight({ hex: "abc123" })]));
    await flush();
    const recovered = viewOf(poller.getState(), NAGAREYAMA, 25, T0 + 40_000).body;
    expect(recovered).toStrictEqual({ kind: "rows" });
    expect(advanceWidenFocus(phase, recovered)).toStrictEqual({ phase: "idle" });
  });
});

describe("widenPhaseAfterUserAction（どの操作で「半径を広げる」の後の待ちをやめるか）", () => {
  const ACTIONS: readonly ListUserAction[] = ["sort", "kind", "radius", "location-change", "select"];
  const PHASES: readonly WidenFocusPhase[] = ["idle", "requested", "waiting"];

  it("表: 並び替え・種類・半径・地点の変更・一覧や地図での選択は、すべて待ちをやめる", () => {
    expect(WIDEN_WAIT_CANCELLED_BY).toStrictEqual({
      sort: true,
      kind: true,
      radius: true,
      "location-change": true,
      select: true,
    });
  });

  it.each(ACTIONS.flatMap((action) => PHASES.map((phase) => [action, phase] as const)))(
    "%s の操作 → 待ち %s から idle",
    (action, phase) => {
      expect(widenPhaseAfterUserAction(phase, action)).toBe("idle");
    },
  );

  it("一覧や地図で機体を選んだら、その後に新しい半径の行が出てもフォーカスを一覧へ移さない", () => {
    const phase = widenPhaseAfterUserAction("waiting", "select");
    expect(advanceWidenFocus(phase, ROWS_BODY)).toStrictEqual({ phase: "idle" });
  });
});

describe("selectionAfterUserAction（どの操作で選択を解除するか、W7 コードレビュー MINOR-4）", () => {
  const ACTIONS: readonly SelectionUserAction[] = [
    "sort",
    "kind",
    "radius",
    "location-change",
    "location-confirm",
    "location-cancel",
  ];

  it("表: 地点の確定だけが選択を解除し、並び替え・種類・半径・［地点を変更］で開いただけ・キャンセルでは保つ", () => {
    expect(SELECTION_CLEARED_BY).toStrictEqual({
      sort: false,
      kind: false,
      radius: false,
      "location-change": false,
      "location-confirm": true,
      "location-cancel": false,
    });
  });

  it("前提: 表は上の 6 つの操作をすべて持つ", () => {
    expect(Object.keys(SELECTION_CLEARED_BY).sort()).toStrictEqual([...ACTIONS].sort());
  });

  it("地点を確定したら選択を解除する（詳細パネルを閉じる）", () => {
    expect(selectionAfterUserAction("86e7a0", "location-confirm")).toBeUndefined();
  });

  it.each(ACTIONS.filter((action) => action !== "location-confirm"))("%s では選択を保つ", (action) => {
    expect(selectionAfterUserAction("86e7a0", action)).toBe("86e7a0");
  });

  it.each(ACTIONS)("未選択のまま %s → 未選択", (action) => {
    expect(selectionAfterUserAction(undefined, action)).toBeUndefined();
  });
});

describe("focusAfterDetailClose（詳細を閉じた後のフォーカス、AC-B8）", () => {
  it("全本体（ALL_BODIES）で移す先が決まる: rows は一覧、それ以外は半径の選択欄", () => {
    expect(Object.fromEntries(ALL_BODIES.map(([label, body]) => [label, focusAfterDetailClose(body)]))).toStrictEqual({
      loading: "radius-select",
      unavailable: "radius-select",
      "empty（次の段あり）": "radius-select",
      "empty（100km）": "radius-select",
      rows: "list",
    });
  });

  it("一覧へ移すのは本体が rows のときだけ（FlightList は rows のときだけ一覧を描画するので、移す先の要素が必ずある）", () => {
    expect(ALL_BODIES.filter(([, body]) => focusAfterDetailClose(body) === "list").map(([label]) => label)).toStrictEqual([
      "rows",
    ]);
  });

  it("半径を変えた直後の取得中（一覧が無い）に閉じると、半径の選択欄（「半径を広げる」の後に移す先と同じ要素）", () => {
    const target = focusAfterDetailClose(LOADING_BODY);
    expect(target).toBe("radius-select");
    expect(advanceWidenFocus("waiting", EMPTY_LAST_BODY).target).toBe(target);
  });
});

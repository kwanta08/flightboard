import { describe, expect, it } from "vitest";
import type { GeolocationResult } from "./geolocation.ts";
import {
  appScreen,
  applyGeolocationResult,
  canCancelSetup,
  changeElevationText,
  confirmErrorText,
  confirmLocation,
  DEFAULT_CENTER,
  focusTargetOnScreenChange,
  formatAccuracy,
  initialSetupState,
  LOCATION_CHANGE_LABEL,
  setupTitle,
  pinFromMapPoint,
  pinFromResult,
  placePinByUser,
  setupMessage,
  type SetupState,
} from "./setupFlow.ts";
import { loadLocation, saveLocation, type LocationStorage } from "./locationStore.ts";

const NAGAREYAMA = { lat: 35.8709, lon: 139.9256, elevationM: 15 };
const OCEAN = { lat: 30, lon: 150, elevationM: 120 };

/** 測位の成功（流山の少し北） */
function located(accuracyM: number): GeolocationResult {
  return { ok: true, lat: 35.9, lon: 139.95, accuracyM };
}

/** 初回（現在値無し）に測位の結果が届いた状態 */
function afterGeolocation(result: GeolocationResult): SetupState {
  return applyGeolocationResult(initialSetupState(), result).state;
}

describe("DEFAULT_CENTER", () => {
  it("仕様 6.5 の利用地点（千葉県流山市周辺 35.86 / 139.90）", () => {
    expect(DEFAULT_CENTER).toEqual({ lat: 35.86, lon: 139.9 });
  });
});

describe("initialSetupState", () => {
  it("現在値があれば、そこを中心・ピン・標高にして Geolocation を要求しない", () => {
    expect(initialSetupState(OCEAN)).toEqual({
      center: { lat: 30, lon: 150 },
      pin: { lat: 30, lon: 150 },
      pinSource: "current",
      geolocation: { phase: "idle" },
      elevationText: "120",
      requestGeolocation: false,
    });
  });

  it("現在値の標高は丸めずに文字列にする", () => {
    expect(initialSetupState({ ...NAGAREYAMA, elevationM: 15.5 }).elevationText).toBe("15.5");
    expect(initialSetupState({ ...NAGAREYAMA, elevationM: -3.6 }).elevationText).toBe("-3.6");
    expect(initialSetupState({ ...NAGAREYAMA, elevationM: 15 }).elevationText).toBe("15");
  });

  it("現在値で開いて触らずに確定すると、保存値と同じ地点になる", () => {
    const current = { lat: 35.8615, lon: 139.8937, elevationM: 15.5 };
    const state = initialSetupState(current);
    expect(confirmLocation(state.pin, state.elevationText)).toEqual({ ok: true, location: current });
  });

  it.each(["15.5", "0.1", "-0.5", "-3.6", "15.0", "9000", "-500"])(
    "標高 %j で確定・保存し、［変更］で開いて触らずに確定すると、同じ地点になる（開いた直後に標高エラーも出ない）",
    (elevationText) => {
      const first = confirmLocation({ lat: 35.8615, lon: 139.8937 }, elevationText);
      if (!first.ok) throw new Error(first.error);
      const items = new Map<string, string>();
      const storage: LocationStorage = {
        getItem: (key) => items.get(key) ?? null,
        setItem: (key, value) => {
          items.set(key, value);
        },
      };
      expect(saveLocation(storage, first.location)).toBe(true);

      const reopened = initialSetupState(loadLocation(storage));
      expect(reopened.pinSource).toBe("current");
      expect(confirmErrorText(reopened)).toBeUndefined();
      expect(confirmLocation(reopened.pin, reopened.elevationText)).toEqual({ ok: true, location: first.location });
    },
  );

  it("現在値が無ければ、仮の中心・ピン無し・標高「0」で Geolocation を要求し、結果待ちにする", () => {
    const state = initialSetupState(undefined);
    expect(state).toEqual({
      center: DEFAULT_CENTER,
      geolocation: { phase: "pending" },
      elevationText: "0",
      requestGeolocation: true,
    });
    expect(state.pin).toBeUndefined();
    expect(state.pinSource).toBeUndefined();
  });

  it("add で開いたときは現在値を中心にするだけでピンは置かず、測位も要求しない（触らず確定して同じ地点が増えない）", () => {
    const state = initialSetupState(OCEAN, "add");
    expect(state).toEqual({
      center: { lat: 30, lon: 150 },
      geolocation: { phase: "idle" },
      elevationText: "0",
      requestGeolocation: false,
    });
    expect(state.pin).toBeUndefined();
    expect(state.pinSource).toBeUndefined();
    // ピンが無いので確定できない（地図で指定させる）
    expect(confirmLocation(state.pin, state.elevationText).ok).toBe(false);
    expect(setupMessage(state)).toBe("地図をクリックして地点を指定してください");
  });

  it("add で現在値が無ければ仮の中心（それでもピンは置かず測位も要求しない）", () => {
    expect(initialSetupState(undefined, "add")).toEqual({
      center: DEFAULT_CENTER,
      geolocation: { phase: "idle" },
      elevationText: "0",
      requestGeolocation: false,
    });
  });

  it("change を渡したときは省略したときと同じ", () => {
    expect(initialSetupState(OCEAN, "change")).toEqual(initialSetupState(OCEAN));
    expect(initialSetupState(undefined, "change")).toEqual(initialSetupState());
  });

  it("初期状態の中心を書き換えても DEFAULT_CENTER は変わらない", () => {
    const state = initialSetupState();
    state.center.lat = 0;
    expect(DEFAULT_CENTER).toEqual({ lat: 35.86, lon: 139.9 });
  });
});

describe("setupTitle", () => {
  it("add で開いたら「地点を追加」、それ以外は「地点の設定」（［変更］と見分けが付く）", () => {
    expect(setupTitle("add")).toBe("地点を追加");
    expect(setupTitle("change")).toBe("地点の設定");
    expect(setupTitle()).toBe("地点の設定");
  });
});

describe("canCancelSetup", () => {
  it("現在値があるときだけキャンセルできる", () => {
    expect(canCancelSetup(NAGAREYAMA)).toBe(true);
    expect(canCancelSetup(undefined)).toBe(false);
  });
});

describe("appScreen", () => {
  it("地点が無ければセットアップ", () => {
    expect(appScreen(undefined, false)).toBe("setup");
  });

  it("地点があればメイン画面", () => {
    expect(appScreen(NAGAREYAMA, false)).toBe("main");
  });

  it("地点があっても［変更］で編集中ならセットアップ", () => {
    expect(appScreen(NAGAREYAMA, true)).toBe("setup");
  });

  it("［設定］を開いていれば設定画面（S-04）", () => {
    expect(appScreen(NAGAREYAMA, false, true)).toBe("settings");
  });

  it("設定画面から地点を編集している間はセットアップ（戻ると設定画面に戻る）", () => {
    expect(appScreen(NAGAREYAMA, true, true)).toBe("setup");
  });

  it("地点が無ければ設定画面より先にセットアップ", () => {
    expect(appScreen(undefined, false, true)).toBe("setup");
  });
});

describe("LOCATION_CHANGE_LABEL", () => {
  it("ヘッダーのボタンの文言は「地点を変更」", () => {
    expect(LOCATION_CHANGE_LABEL).toBe("地点を変更");
  });
});

describe("focusTargetOnScreenChange", () => {
  it("初回の表示ではフォーカスを移さない", () => {
    expect(focusTargetOnScreenChange(undefined, "setup")).toBeUndefined();
    expect(focusTargetOnScreenChange(undefined, "main")).toBeUndefined();
  });

  it("メイン画面からセットアップに切り替わったら見出しへ", () => {
    expect(focusTargetOnScreenChange("main", "setup")).toBe("setup-heading");
  });

  it("セットアップからメイン画面に戻ったら［地点を変更］ボタンへ", () => {
    expect(focusTargetOnScreenChange("setup", "main")).toBe("location-change");
  });

  it("画面が変わらなければ移さない", () => {
    expect(focusTargetOnScreenChange("setup", "setup")).toBeUndefined();
    expect(focusTargetOnScreenChange("main", "main")).toBeUndefined();
    expect(focusTargetOnScreenChange("settings", "settings")).toBeUndefined();
  });

  it("設定画面に切り替わったら見出しへ（メインからでも、地点の編集から戻ったときでも）", () => {
    expect(focusTargetOnScreenChange("main", "settings")).toBe("settings-heading");
    expect(focusTargetOnScreenChange("setup", "settings")).toBe("settings-heading");
  });

  it("設定画面からメイン画面に戻ったらヘッダーの［設定］ボタンへ", () => {
    expect(focusTargetOnScreenChange("settings", "main")).toBe("settings-button");
  });

  it("設定画面から地点の編集に入ったらセットアップの見出しへ", () => {
    expect(focusTargetOnScreenChange("settings", "setup")).toBe("setup-heading");
  });

  it("初回の表示が設定画面でもフォーカスを移さない", () => {
    expect(focusTargetOnScreenChange(undefined, "settings")).toBeUndefined();
  });
});

describe("formatAccuracy", () => {
  it.each([
    [4, "約 10 m"],
    [25, "約 30 m"],
    [994, "約 990 m"],
    [999, "約 1.0 km"],
    [1000, "約 1.0 km"],
    [1001, "約 1.0 km"],
    [1550, "約 1.6 km"],
    [12345, "約 12.3 km"],
  ])("%d m は「%s」", (accuracyM, text) => {
    expect(formatAccuracy(accuracyM)).toBe(text);
  });
});

describe("setupMessage", () => {
  it("初期値つき（［変更］で開いた）なら精度注記の無い確認の文言（M3-4）", () => {
    expect(setupMessage(initialSetupState(NAGAREYAMA))).toBe("この場所でよいですか？");
  });

  it("初回の測位の結果待ちなら取得中の文言", () => {
    expect(setupMessage(initialSetupState())).toBe("現在地を取得しています…");
  });

  it("成功・精度 25m は確認の文言に精度を添える", () => {
    expect(setupMessage(afterGeolocation(located(25)))).toBe("この場所でよいですか？（精度 約 30 m）");
  });

  it("成功・精度 999m は確認の文言（10m 単位に丸めると 1000m になるので km 表記）", () => {
    expect(setupMessage(afterGeolocation(located(999)))).toBe("この場所でよいですか？（精度 約 1.0 km）");
  });

  it("成功・精度 1000m ちょうどは確認の文言（1km 以下）", () => {
    expect(setupMessage(afterGeolocation(located(1000)))).toBe("この場所でよいですか？（精度 約 1.0 km）");
  });

  it("成功・精度 1001m は精度が低い旨の文言", () => {
    expect(setupMessage(afterGeolocation(located(1001)))).toBe(
      "位置の精度が低いため、地図をクリックして正しい地点を指定してください（精度 約 1.0 km）",
    );
  });

  it("成功・精度 5400m は精度が低い旨の文言に km で精度を添える", () => {
    expect(setupMessage(afterGeolocation(located(5400)))).toBe(
      "位置の精度が低いため、地図をクリックして正しい地点を指定してください（精度 約 5.4 km）",
    );
  });

  it("精度が低いときの案内は AC-B2 の文をそのまま含み、精度は文末に括弧で添える（結合レビュー MINOR-7）", () => {
    const acSentence = "位置の精度が低いため、地図をクリックして正しい地点を指定してください";
    const message = setupMessage(afterGeolocation(located(5400)));
    expect(message).toContain(acSentence);
    expect(message.startsWith(acSentence)).toBe(true);
    expect(message.slice(acSentence.length)).toBe("（精度 約 5.4 km）");
  });

  it.each([
    ["denied", "地図をクリックして地点を指定してください（位置情報の利用が許可されていません）"],
    ["unavailable", "地図をクリックして地点を指定してください（現在地を取得できませんでした）"],
    ["timeout", "地図をクリックして地点を指定してください（現在地の取得に時間がかかりすぎました）"],
    ["unsupported", "地図をクリックして地点を指定してください（このブラウザは位置情報に対応していません）"],
  ] as const)("失敗（%s）でピンが無ければ地図のクリックを案内し理由を添える", (reason, text) => {
    expect(setupMessage(afterGeolocation({ ok: false, reason }))).toBe(text);
  });

  it("測位に失敗した後にユーザーがピンを置いたら、理由の案内をやめて確認の文言", () => {
    const { state } = placePinByUser(afterGeolocation({ ok: false, reason: "denied" }), { lat: 35.86, lng: 139.89 });
    expect(setupMessage(state)).toBe("この場所でよいですか？");
  });

  it("結果待ちの間にユーザーがピンを置いたら確認の文言", () => {
    expect(setupMessage(placePinByUser(initialSetupState(), { lat: 35.86, lng: 139.89 }).state)).toBe(
      "この場所でよいですか？",
    );
  });

  it("精度が低い測位の後にユーザーがピンを置いたら、精度の案内をやめて確認の文言", () => {
    const { state } = placePinByUser(afterGeolocation(located(5400)), { lat: 35.86, lng: 139.89 });
    expect(setupMessage(state)).toBe("この場所でよいですか？");
  });
});

describe("pinFromResult", () => {
  it("成功ならその位置", () => {
    expect(pinFromResult({ ok: true, lat: 35.8709, lon: 139.9256, accuracyM: 5400 })).toEqual({
      lat: 35.8709,
      lon: 139.9256,
    });
  });

  it("失敗なら undefined", () => {
    expect(pinFromResult({ ok: false, reason: "denied" })).toBeUndefined();
  });

  it("結果が無ければ undefined", () => {
    expect(pinFromResult(undefined)).toBeUndefined();
  });
});

describe("pinFromMapPoint", () => {
  it("範囲内の座標はそのまま", () => {
    expect(pinFromMapPoint(35.8709, 139.9256)).toEqual({ lat: 35.8709, lon: 139.9256 });
    expect(pinFromMapPoint(-90, -180)).toEqual({ lat: -90, lon: -180 });
    expect(pinFromMapPoint(90, 180)).toEqual({ lat: 90, lon: 180 });
  });

  it("経度が ±180 の外なら [-180, 180) に折り返す", () => {
    expect(pinFromMapPoint(30, 190)).toEqual({ lat: 30, lon: -170 });
    expect(pinFromMapPoint(30, -181)).toEqual({ lat: 30, lon: 179 });
    expect(pinFromMapPoint(30, 510)).toEqual({ lat: 30, lon: 150 });
  });

  it("緯度は [-90, 90] に収める", () => {
    expect(pinFromMapPoint(91, 150)).toEqual({ lat: 90, lon: 150 });
    expect(pinFromMapPoint(-95, 150)).toEqual({ lat: -90, lon: 150 });
  });
});

describe("placePinByUser", () => {
  it("クリック・ドラッグの座標にピンを置き、出どころを user にする（測位と標高は変えない）", () => {
    const { state } = placePinByUser({ ...initialSetupState(), elevationText: "15" }, { lat: 35.86, lng: 139.89 });
    expect(state.pin).toEqual({ lat: 35.86, lon: 139.89 });
    expect(state.pinSource).toBe("user");
    expect(state.geolocation).toEqual({ phase: "pending" });
    expect(state.elevationText).toBe("15");
  });

  it("経度が ±180 の外なら折り返す", () => {
    expect(placePinByUser(initialSetupState(), { lat: 30, lng: 510 }).state.pin).toEqual({ lat: 30, lon: 150 });
  });

  it("現在値のピンを動かすと出どころが user になる", () => {
    const { state } = placePinByUser(initialSetupState(NAGAREYAMA), { lat: 30, lng: 150 });
    expect(state.pin).toEqual({ lat: 30, lon: 150 });
    expect(state.pinSource).toBe("user");
  });

  it("ピンの配置では recenter が無い（測位成功で表示範囲を移した直後でも）", () => {
    expect(placePinByUser(initialSetupState(), { lat: 35.86, lng: 139.89 }).recenter).toBeUndefined();
    expect(placePinByUser(initialSetupState(NAGAREYAMA), { lat: 30, lng: 150 }).recenter).toBeUndefined();

    const locatedTransition = applyGeolocationResult(initialSetupState(), located(25));
    expect(locatedTransition.recenter).toEqual({ lat: 35.9, lon: 139.95 });
    const placed = placePinByUser(locatedTransition.state, { lat: 35.86, lng: 139.89 });
    expect(placed.recenter).toBeUndefined();
    expect(placed.state.pin).toEqual({ lat: 35.86, lon: 139.89 });
  });
});

describe("applyGeolocationResult", () => {
  it("ユーザーがピンを置いた後に測位成功 → ピンは動かず表示範囲も移さない。案内は精度注記なしの確認文言", () => {
    const userPlaced = placePinByUser(initialSetupState(), { lat: 35.86, lng: 139.89 }).state;
    const { state, recenter } = applyGeolocationResult(userPlaced, located(25));
    expect(state.pin).toEqual({ lat: 35.86, lon: 139.89 });
    expect(state.pinSource).toBe("user");
    expect(state.geolocation).toEqual({ phase: "done", result: located(25) });
    expect(recenter).toBeUndefined();
    expect(setupMessage(state)).toBe("この場所でよいですか？");
  });

  it("ピン無し＋測位成功 → 測位位置にピンを置き表示範囲を移す。案内は精度つき", () => {
    const { state, recenter } = applyGeolocationResult(initialSetupState(), located(25));
    expect(state.pin).toEqual({ lat: 35.9, lon: 139.95 });
    expect(state.pinSource).toBe("geolocation");
    expect(recenter).toEqual({ lat: 35.9, lon: 139.95 });
    expect(setupMessage(state)).toBe("この場所でよいですか？（精度 約 30 m）");
  });

  it("ピン無し＋測位失敗 → ピン無しのまま表示範囲も移さない。案内は理由つき", () => {
    const { state, recenter } = applyGeolocationResult(initialSetupState(), { ok: false, reason: "timeout" });
    expect(state.pin).toBeUndefined();
    expect(state.pinSource).toBeUndefined();
    expect(state.geolocation).toEqual({ phase: "done", result: { ok: false, reason: "timeout" } });
    expect(recenter).toBeUndefined();
    expect(setupMessage(state)).toBe("地図をクリックして地点を指定してください（現在地の取得に時間がかかりすぎました）");
  });

  it("ユーザーがピンを置いた後に測位失敗 → ピンは動かず、案内は確認文言", () => {
    const userPlaced = placePinByUser(initialSetupState(), { lat: 35.86, lng: 139.89 }).state;
    const { state, recenter } = applyGeolocationResult(userPlaced, { ok: false, reason: "denied" });
    expect(state.pin).toEqual({ lat: 35.86, lon: 139.89 });
    expect(state.pinSource).toBe("user");
    expect(recenter).toBeUndefined();
    expect(setupMessage(state)).toBe("この場所でよいですか？");
  });

  it("測位成功でピンが置かれた後にユーザーがドラッグ → 出どころが user になり精度注記が消える", () => {
    const locatedState = applyGeolocationResult(initialSetupState(), located(5400)).state;
    expect(setupMessage(locatedState)).toBe(
      "位置の精度が低いため、地図をクリックして正しい地点を指定してください（精度 約 5.4 km）",
    );
    const dragged = placePinByUser(locatedState, { lat: 35.87, lng: 139.93 }).state;
    expect(dragged.pin).toEqual({ lat: 35.87, lon: 139.93 });
    expect(dragged.pinSource).toBe("user");
    expect(setupMessage(dragged)).toBe("この場所でよいですか？");
  });

  it("現在値のピンは測位成功でも動かさない", () => {
    const { state, recenter } = applyGeolocationResult(initialSetupState(NAGAREYAMA), located(25));
    expect(state.pin).toEqual({ lat: 35.8709, lon: 139.9256 });
    expect(state.pinSource).toBe("current");
    expect(recenter).toBeUndefined();
    expect(setupMessage(state)).toBe("この場所でよいですか？");
  });

  it("標高の入力は変えない", () => {
    const { state } = applyGeolocationResult({ ...initialSetupState(), elevationText: "42" }, located(25));
    expect(state.elevationText).toBe("42");
  });
});

describe("changeElevationText", () => {
  it("標高の入力だけを変える", () => {
    const before = initialSetupState(NAGAREYAMA);
    const after = changeElevationText(before, "30").state;
    expect(after.elevationText).toBe("30");
    expect(after.pin).toEqual(before.pin);
    expect(after.pinSource).toBe("current");
  });

  it("標高の変更では recenter が無い", () => {
    expect(changeElevationText(initialSetupState(NAGAREYAMA), "30").recenter).toBeUndefined();
    expect(changeElevationText(initialSetupState(), "30").recenter).toBeUndefined();
  });

  it("測位成功（ピン無し）の直後に標高を変えると recenter が消える（ピンと測位の結果は残る）", () => {
    const locatedTransition = applyGeolocationResult(initialSetupState(), located(25));
    expect(locatedTransition.recenter).toEqual({ lat: 35.9, lon: 139.95 });
    const changed = changeElevationText(locatedTransition.state, "42");
    expect(changed.recenter).toBeUndefined();
    expect(changed.state).toEqual({ ...locatedTransition.state, elevationText: "42" });
  });
});

describe("confirmErrorText", () => {
  it("ピンが無くても、標高が正しければエラーを出さない", () => {
    expect(confirmErrorText(initialSetupState())).toBeUndefined();
    expect(confirmErrorText(afterGeolocation({ ok: false, reason: "denied" }))).toBeUndefined();
    expect(confirmErrorText({ ...initialSetupState(), elevationText: "" })).toBeUndefined();
  });

  it("ピンがあり標高が正しければエラーを出さない", () => {
    expect(confirmErrorText(initialSetupState(NAGAREYAMA))).toBeUndefined();
  });

  it("標高が不正ならそのエラー（ピンの有無によらない）", () => {
    expect(confirmErrorText(changeElevationText(initialSetupState(NAGAREYAMA), "abc").state)).toMatch(/標高/);
    expect(confirmErrorText(changeElevationText(initialSetupState(NAGAREYAMA), "9001").state)).toMatch(/標高/);
    expect(confirmErrorText(changeElevationText(initialSetupState(), "abc").state)).toMatch(/標高/);
  });
});

describe("confirmLocation", () => {
  it("ピンが無ければ地図のクリックを促すエラー", () => {
    expect(confirmLocation(undefined, "15")).toEqual({
      ok: false,
      error: "地図をクリックして地点を指定してください",
    });
  });

  it("標高が不正ならそのエラー", () => {
    const result = confirmLocation({ lat: 35.8709, lon: 139.9256 }, "abc");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/標高/);
    }
  });

  it("標高が範囲外ならエラー", () => {
    expect(confirmLocation({ lat: 35.8709, lon: 139.9256 }, "9001").ok).toBe(false);
  });

  it("ピンと正しい標高があれば確定する地点を返す", () => {
    expect(confirmLocation({ lat: 35.8709, lon: 139.9256 }, "15.5")).toEqual({
      ok: true,
      location: { lat: 35.8709, lon: 139.9256, elevationM: 15.5 },
    });
  });

  it("標高が空なら 0m で確定する", () => {
    expect(confirmLocation({ lat: 30, lon: 150 }, "")).toEqual({
      ok: true,
      location: { lat: 30, lon: 150, elevationM: 0 },
    });
  });
});

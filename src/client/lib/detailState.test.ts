import { describe, expect, it } from "vitest";
import type { Flight, FlightDetailResponse, TrackPoint } from "../../shared/types.ts";
import {
  detailBody,
  detailFailureEvent,
  detailRefreshKey,
  detailResultEvent,
  detailStateFor,
  INITIAL_DETAIL_STATE,
  isDetailOpen,
  reduceDetailState,
  trackForSelection,
  type DetailState,
} from "./detailState.ts";

const HEX_A = "86e7a0";
const HEX_B = "84c1b2";

function makeFlight(hex: string): Flight {
  return {
    hex,
    position: { lat: 35.55, lon: 139.78, altitudeBaroFt: 3000, onGround: false },
    isMlat: false,
    seenPosSec: 0,
    kind: "passenger",
    source: "adsblol",
  };
}

function makeDetail(hex: string, updatedAt: string): FlightDetailResponse {
  const track: TrackPoint[] = [{ lat: 35.5, lon: 139.7, altitudeFt: 2000, at: updatedAt }];
  return { updatedAt, flight: makeFlight(hex), track };
}

const DETAIL_A = makeDetail(HEX_A, "2026-09-15T00:00:00.000Z");
const DETAIL_A_NEWER = makeDetail(HEX_A, "2026-09-15T00:00:10.000Z");
const DETAIL_B = makeDetail(HEX_B, "2026-09-15T00:00:00.000Z");

const LOADING_A: DetailState = { hex: HEX_A, status: "loading" };
const LOADED_A: DetailState = { hex: HEX_A, status: "loaded", detail: DETAIL_A };

describe("reduceDetailState: 選択の変更", () => {
  it("初期状態は idle（未選択・詳細なし）", () => {
    expect(INITIAL_DETAIL_STATE).toEqual({ status: "idle" });
  });

  it("未選択から選ぶと、その hex で loading（詳細なし）", () => {
    expect(reduceDetailState(INITIAL_DETAIL_STATE, { type: "select", hex: HEX_A })).toEqual({ hex: HEX_A, status: "loading" });
  });

  it("詳細を表示中に別の hex を選ぶと、詳細が消えて loading", () => {
    const next = reduceDetailState(LOADED_A, { type: "select", hex: HEX_B });
    expect(next).toEqual({ hex: HEX_B, status: "loading" });
    expect(next.detail).toBeUndefined();
  });

  it("同じ hex を選び直しても状態は変わらない（同じオブジェクト）", () => {
    expect(reduceDetailState(LOADED_A, { type: "select", hex: HEX_A })).toBe(LOADED_A);
  });

  it("選択を解除すると idle（hex も詳細も消える）", () => {
    const next = reduceDetailState(LOADED_A, { type: "select", hex: undefined });
    expect(next).toEqual({ status: "idle" });
    expect(next.hex).toBeUndefined();
    expect(next.detail).toBeUndefined();
  });

  it("未選択のまま選択解除しても変わらない", () => {
    expect(reduceDetailState(INITIAL_DETAIL_STATE, { type: "select", hex: undefined })).toBe(INITIAL_DETAIL_STATE);
  });
});

describe("reduceDetailState: 取り直し（request）", () => {
  it("同じ hex の再取得では、最後の結果（loaded）と表示中の詳細を残したまま取り直し中（pending）", () => {
    const next = reduceDetailState(LOADED_A, { type: "request" });
    expect(next.status).toBe("loaded");
    expect(next.pending).toBe(true);
    expect(next.hex).toBe(HEX_A);
    expect(next.detail).toBe(DETAIL_A);
  });

  it("未選択では変わらない", () => {
    expect(reduceDetailState(INITIAL_DETAIL_STATE, { type: "request" })).toBe(INITIAL_DETAIL_STATE);
  });

  it("取得中の再取得では変わらない（同じオブジェクト）", () => {
    expect(reduceDetailState(LOADING_A, { type: "request" })).toBe(LOADING_A);
    const refreshing: DetailState = { hex: HEX_A, status: "loading", detail: DETAIL_A };
    expect(reduceDetailState(refreshing, { type: "request" })).toBe(refreshing);
  });

  it("取り直し中の再取得では変わらない（同じオブジェクト）", () => {
    const refreshing = reduceDetailState(LOADED_A, { type: "request" });
    expect(reduceDetailState(refreshing, { type: "request" })).toBe(refreshing);
  });

  it("404 の後の再取得は not-found のまま取り直し中（詳細なし）", () => {
    const next = reduceDetailState({ hex: HEX_A, status: "not-found" }, { type: "request" });
    expect(next).toEqual({ hex: HEX_A, status: "not-found", pending: true });
    expect(next.detail).toBeUndefined();
  });

  it("失敗の後の再取得は error のまま取り直し中。同じ hex の詳細があれば残す", () => {
    expect(reduceDetailState({ hex: HEX_A, status: "error" }, { type: "request" })).toEqual({
      hex: HEX_A,
      status: "error",
      pending: true,
    });
    const next = reduceDetailState({ hex: HEX_A, status: "error", detail: DETAIL_A }, { type: "request" });
    expect(next.status).toBe("error");
    expect(next.pending).toBe(true);
    expect(next.hex).toBe(HEX_A);
    expect(next.detail).toBe(DETAIL_A);
  });

  it("取り直し中に届いた結果（成功・404・失敗）で取り直し中が消える", () => {
    const refreshing = reduceDetailState(LOADED_A, { type: "request" });
    expect(reduceDetailState(refreshing, { type: "success", hex: HEX_A, detail: DETAIL_A_NEWER }).pending).toBeUndefined();
    expect(reduceDetailState(refreshing, { type: "not-found", hex: HEX_A }).pending).toBeUndefined();
    expect(reduceDetailState(refreshing, { type: "failure", hex: HEX_A }).pending).toBeUndefined();
  });

  it("取り直し中に別の hex を選ぶと、最後の結果も取り直し中も消えて loading", () => {
    const refreshingNotFound = reduceDetailState({ hex: HEX_A, status: "not-found" }, { type: "request" });
    expect(reduceDetailState(refreshingNotFound, { type: "select", hex: HEX_B })).toStrictEqual({ hex: HEX_B, status: "loading" });
  });
});

describe("reduceDetailState: 結果", () => {
  it("選択中の hex の成功で loaded（詳細を入れる）", () => {
    expect(reduceDetailState(LOADING_A, { type: "success", hex: HEX_A, detail: DETAIL_A })).toEqual(LOADED_A);
  });

  it("取り直しの成功で詳細が新しいものに替わる", () => {
    const refreshing = reduceDetailState(LOADED_A, { type: "request" });
    const next = reduceDetailState(refreshing, { type: "success", hex: HEX_A, detail: DETAIL_A_NEWER });
    expect(next).toEqual({ hex: HEX_A, status: "loaded", detail: DETAIL_A_NEWER });
  });

  it("別の hex の結果（成功・404・失敗）は捨てる", () => {
    const loadingB: DetailState = { hex: HEX_B, status: "loading" };
    expect(reduceDetailState(loadingB, { type: "success", hex: HEX_A, detail: DETAIL_A })).toBe(loadingB);
    expect(reduceDetailState(loadingB, { type: "not-found", hex: HEX_A })).toBe(loadingB);
    expect(reduceDetailState(loadingB, { type: "failure", hex: HEX_A })).toBe(loadingB);
  });

  it("選択を解除した後に届いた結果は捨てる", () => {
    expect(reduceDetailState(INITIAL_DETAIL_STATE, { type: "success", hex: HEX_A, detail: DETAIL_A })).toBe(
      INITIAL_DETAIL_STATE,
    );
  });

  it("404 で not-found（表示中の詳細も消す）", () => {
    expect(reduceDetailState(LOADING_A, { type: "not-found", hex: HEX_A })).toEqual({ hex: HEX_A, status: "not-found" });
    const refreshing = reduceDetailState(LOADED_A, { type: "request" });
    const next = reduceDetailState(refreshing, { type: "not-found", hex: HEX_A });
    expect(next).toEqual({ hex: HEX_A, status: "not-found" });
    expect(next.detail).toBeUndefined();
  });

  it("失敗で error。同じ hex の詳細があれば残す", () => {
    const refreshing = reduceDetailState(LOADED_A, { type: "request" });
    const next = reduceDetailState(refreshing, { type: "failure", hex: HEX_A });
    expect(next.status).toBe("error");
    expect(next.detail).toBe(DETAIL_A);
  });

  it("詳細が無いまま失敗すると error（詳細なし）", () => {
    const next = reduceDetailState(LOADING_A, { type: "failure", hex: HEX_A });
    expect(next).toEqual({ hex: HEX_A, status: "error" });
    expect("detail" in next).toBe(false);
  });

  it("失敗の後に成功すると loaded に戻る（error が消える）", () => {
    const failed = reduceDetailState(LOADING_A, { type: "failure", hex: HEX_A });
    expect(reduceDetailState(failed, { type: "success", hex: HEX_A, detail: DETAIL_A })).toEqual(LOADED_A);
  });

  it("別の機体の詳細を表示中に選択を変えてから前の機体の結果が届いても、前の詳細は出ない", () => {
    const selectedB = reduceDetailState(LOADED_A, { type: "select", hex: HEX_B });
    const next = reduceDetailState(selectedB, { type: "success", hex: HEX_A, detail: DETAIL_A_NEWER });
    expect(next).toEqual({ hex: HEX_B, status: "loading" });
    const loadedB = reduceDetailState(next, { type: "success", hex: HEX_B, detail: DETAIL_B });
    expect(loadedB).toEqual({ hex: HEX_B, status: "loaded", detail: DETAIL_B });
  });
});

describe("detailBody: パネルの本体の出し分け", () => {
  it("未選択は empty", () => {
    expect(detailBody(INITIAL_DETAIL_STATE)).toEqual({ kind: "empty" });
  });

  it("詳細が無く取得中は loading", () => {
    expect(detailBody(LOADING_A)).toEqual({ kind: "loading" });
  });

  it("取得済みは view", () => {
    expect(detailBody(LOADED_A)).toEqual({ kind: "view", detail: DETAIL_A });
  });

  it("詳細があれば取り直し中でも view", () => {
    expect(detailBody({ hex: HEX_A, status: "loading", detail: DETAIL_A })).toEqual({ kind: "view", detail: DETAIL_A });
  });

  it("詳細があれば失敗中でも view", () => {
    expect(detailBody({ hex: HEX_A, status: "error", detail: DETAIL_A })).toEqual({ kind: "view", detail: DETAIL_A });
  });

  it("404 は not-found", () => {
    expect(detailBody({ hex: HEX_A, status: "not-found" })).toEqual({ kind: "not-found" });
  });

  it("詳細が無いまま失敗は error", () => {
    expect(detailBody({ hex: HEX_A, status: "error" })).toEqual({ kind: "error" });
  });
});

describe("detailBody: 最後の結果と取り直し中（W7 コードレビュー MINOR-1）", () => {
  const REQUEST = { type: "request" } as const;

  it("404 の後の取り直し中も not-found のまま（取得中に戻らない）", () => {
    const notFound = reduceDetailState(LOADING_A, { type: "not-found", hex: HEX_A });
    expect(detailBody(reduceDetailState(notFound, REQUEST))).toEqual({ kind: "not-found" });
  });

  it("その取り直しが成功すると view", () => {
    const refreshing = reduceDetailState(reduceDetailState(LOADING_A, { type: "not-found", hex: HEX_A }), REQUEST);
    const loaded = reduceDetailState(refreshing, { type: "success", hex: HEX_A, detail: DETAIL_A });
    expect(detailBody(loaded)).toEqual({ kind: "view", detail: DETAIL_A });
  });

  it("失敗の後の取り直し中も error のまま", () => {
    const failed = reduceDetailState(LOADING_A, { type: "failure", hex: HEX_A });
    expect(detailBody(reduceDetailState(failed, REQUEST))).toEqual({ kind: "error" });
  });

  it("詳細の後の取り直し中は view のまま", () => {
    expect(detailBody(reduceDetailState(LOADED_A, REQUEST))).toEqual({ kind: "view", detail: DETAIL_A });
  });

  it("選択を変えた直後は loading（前の機体の 404 の案内を出さない）", () => {
    const refreshingNotFound = reduceDetailState({ hex: HEX_A, status: "not-found" }, REQUEST);
    expect(detailBody(reduceDetailState(refreshingNotFound, { type: "select", hex: HEX_B }))).toEqual({ kind: "loading" });
    expect(detailBody(detailStateFor(refreshingNotFound, HEX_B))).toEqual({ kind: "loading" });
  });

  it("選択した直後の取得（まだ結果が無い）は loading", () => {
    const selected = reduceDetailState(INITIAL_DETAIL_STATE, { type: "select", hex: HEX_A });
    expect(detailBody(reduceDetailState(selected, REQUEST))).toEqual({ kind: "loading" });
  });
});

describe("detailStateFor: 選択に合わせた状態", () => {
  it("状態が同じ hex のものならそのまま（同じオブジェクト）", () => {
    expect(detailStateFor(LOADED_A, HEX_A)).toBe(LOADED_A);
  });

  it("選択が変わった直後の描画では、前の機体の詳細を出さず loading", () => {
    expect(detailStateFor(LOADED_A, HEX_B)).toEqual({ hex: HEX_B, status: "loading" });
  });

  it("選択が解除された直後の描画では idle", () => {
    expect(detailStateFor(LOADED_A, undefined)).toEqual({ status: "idle" });
  });
});

describe("isDetailOpen", () => {
  it("選択中なら true、未選択なら false", () => {
    expect(isDetailOpen(LOADING_A)).toBe(true);
    expect(isDetailOpen({ hex: HEX_A, status: "not-found" })).toBe(true);
    expect(isDetailOpen(INITIAL_DETAIL_STATE)).toBe(false);
  });
});

describe("trackForSelection: 地図に渡す航跡", () => {
  it("選択中の機体の詳細が取れていれば { hex, points }（points は詳細の track と同じ参照）", () => {
    const track = trackForSelection(LOADED_A, HEX_A);
    expect(track).toEqual({ hex: HEX_A, points: DETAIL_A.track });
    expect(track?.points).toBe(DETAIL_A.track);
  });

  it("取り直し中・取り直しの失敗中も表示中の詳細の track", () => {
    expect(trackForSelection({ hex: HEX_A, status: "loading", detail: DETAIL_A }, HEX_A)?.points).toBe(DETAIL_A.track);
    expect(trackForSelection({ hex: HEX_A, status: "error", detail: DETAIL_A }, HEX_A)?.points).toBe(DETAIL_A.track);
  });

  it("詳細の hex が選択と違えば trackForSelection は undefined（前の機体の航跡を渡さない）", () => {
    expect(trackForSelection(LOADED_A, HEX_B)).toBeUndefined();
  });

  it("未選択・詳細なし（取得中・404）では undefined", () => {
    expect(trackForSelection(LOADED_A, undefined)).toBeUndefined();
    expect(trackForSelection(LOADING_A, HEX_A)).toBeUndefined();
    expect(trackForSelection({ hex: HEX_A, status: "not-found" }, HEX_A)).toBeUndefined();
  });
});

describe("hex の大文字小文字を区別しない（結合レビュー MINOR-6）", () => {
  const HEX_A_UPPER = HEX_A.toUpperCase();

  it("前提: 大文字にした hex は文字列としては違う", () => {
    expect(HEX_A_UPPER).not.toBe(HEX_A);
  });

  it("選択中の hex と大文字小文字だけ違う結果（成功・404・失敗）も、同じ機体の結果として反映する", () => {
    const loaded = reduceDetailState(LOADING_A, { type: "success", hex: HEX_A_UPPER, detail: DETAIL_A });
    expect(loaded.status).toBe("loaded");
    expect(loaded.detail).toBe(DETAIL_A);
    expect(reduceDetailState(LOADING_A, { type: "not-found", hex: HEX_A_UPPER }).status).toBe("not-found");
    expect(reduceDetailState(LOADING_A, { type: "failure", hex: HEX_A_UPPER }).status).toBe("error");
  });

  it("大文字小文字だけ違う hex を選び直しても状態は変わらない（同じオブジェクト。詳細を消さない）", () => {
    expect(reduceDetailState(LOADED_A, { type: "select", hex: HEX_A_UPPER })).toBe(LOADED_A);
    expect(detailStateFor(LOADED_A, HEX_A_UPPER)).toBe(LOADED_A);
  });

  it("trackForSelection: 選択の hex と大文字小文字だけ違っても航跡を渡す", () => {
    expect(trackForSelection(LOADED_A, HEX_A_UPPER)?.points).toBe(DETAIL_A.track);
  });
});

describe("detailResultEvent / detailFailureEvent: 取得の結果をイベントにする", () => {
  it("詳細は success、\"not-found\" は not-found", () => {
    expect(detailResultEvent(HEX_A, DETAIL_A)).toEqual({ type: "success", hex: HEX_A, detail: DETAIL_A });
    expect(detailResultEvent(HEX_A, "not-found")).toEqual({ type: "not-found", hex: HEX_A });
  });

  it("中断の例外は undefined（成功にも失敗にも数えない）", () => {
    expect(detailFailureEvent(HEX_A, new DOMException("中断", "AbortError"))).toBeUndefined();
  });

  it("中断以外の例外は failure", () => {
    expect(detailFailureEvent(HEX_A, new Error("HTTP 502"))).toEqual({ type: "failure", hex: HEX_A });
    expect(detailFailureEvent(HEX_A, "unknown")).toEqual({ type: "failure", hex: HEX_A });
  });

  it("期限切れで中断した（abortReason: timeout）なら、中断の例外でも failure（W7 コードレビュー MINOR-2）", () => {
    expect(detailFailureEvent(HEX_A, new DOMException("中断", "AbortError"), "timeout")).toEqual({ type: "failure", hex: HEX_A });
    expect(detailFailureEvent(HEX_A, new Error("HTTP 502"), "timeout")).toEqual({ type: "failure", hex: HEX_A });
  });

  it("選択の変更・取り直し・アンマウントで中断した（abortReason: superseded）なら undefined（行き違いで届いた失敗も数えない）", () => {
    expect(detailFailureEvent(HEX_A, new DOMException("中断", "AbortError"), "superseded")).toBeUndefined();
    expect(detailFailureEvent(HEX_A, new Error("HTTP 502"), "superseded")).toBeUndefined();
  });
});

describe("detailRefreshKey: 詳細を取り直すきっかけのキー（W7 コードレビュー MINOR-3）", () => {
  it("number → undefined（条件の変更で poller がデータを消した）ではキーが変わらない", () => {
    expect(detailRefreshKey(undefined, 1_000)).toBe(1_000);
  });

  it("undefined → 新しい number（新しい条件での成功）で変わる", () => {
    expect(detailRefreshKey(2_000, 1_000)).toBe(2_000);
    expect(detailRefreshKey(2_000, undefined)).toBe(2_000);
  });

  it("同じ number では変わらない", () => {
    expect(detailRefreshKey(1_000, 1_000)).toBe(1_000);
  });

  it("まだ成功が無ければ undefined", () => {
    expect(detailRefreshKey(undefined, undefined)).toBeUndefined();
  });

  it("成功 → 条件の変更で消える → 新しい条件で成功、の流れでキーが変わるのは成功の 2 回だけ（取り直しは 1 回ずつ）", () => {
    const receivedAts = [1_000, undefined, undefined, 2_000];
    let key: number | undefined;
    const keys = receivedAts.map((receivedAt) => {
      key = detailRefreshKey(receivedAt, key);
      return key;
    });
    expect(keys).toEqual([1_000, 1_000, 1_000, 2_000]);
    const changes = keys.filter((value, index) => index === 0 || value !== keys[index - 1]);
    expect(changes).toEqual([1_000, 2_000]);
  });
});

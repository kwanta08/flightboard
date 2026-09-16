// ブラウザの Geolocation で現在地を 1 回取得し、成功・失敗の理由を値で返す（AC-B2・S-01）。
// Geolocation は注入する（テストでは偽物を渡す）。

export type GeolocationFailureReason = "denied" | "unavailable" | "timeout" | "unsupported";

export type GeolocationResult =
  | { ok: true; lat: number; lon: number; accuracyM: number }
  | { ok: false; reason: GeolocationFailureReason };

export type RequestPositionOptions = {
  /** ブラウザに渡すタイムアウト（ms） */
  timeoutMs?: number;
};

/** ブラウザが timeout を守らずどちらのコールバックも呼ばない場合に、自前で打ち切るまでの上乗せ（ms） */
const FALLBACK_TIMEOUT_MARGIN_MS = 1000;

/** 直近 1 分以内の測位結果なら使い回してよい */
const MAXIMUM_AGE_MS = 60000;

function reasonFromErrorCode(code: number): GeolocationFailureReason {
  switch (code) {
    case 1:
      return "denied";
    case 2:
      return "unavailable";
    case 3:
      return "timeout";
    default:
      return "unavailable";
  }
}

/**
 * 現在地を 1 回取得する。`geo` が無ければ unsupported。
 * 成功・エラー・自前のタイムアウト（timeoutMs + 1000ms）のうち最初に起きたものだけを結果にする
 */
export function requestPosition(
  geo: Pick<Geolocation, "getCurrentPosition"> | undefined,
  { timeoutMs = 10000 }: RequestPositionOptions = {},
): Promise<GeolocationResult> {
  if (geo === undefined || geo === null) {
    return Promise.resolve({ ok: false, reason: "unsupported" });
  }

  return new Promise<GeolocationResult>((resolve) => {
    let settled = false;
    const settle = (result: GeolocationResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(fallbackTimer);
      resolve(result);
    };

    const fallbackTimer = setTimeout(() => {
      settle({ ok: false, reason: "timeout" });
    }, timeoutMs + FALLBACK_TIMEOUT_MARGIN_MS);

    try {
      geo.getCurrentPosition(
        (position) => {
          settle({
            ok: true,
            lat: position.coords.latitude,
            lon: position.coords.longitude,
            accuracyM: position.coords.accuracy,
          });
        },
        (error) => {
          settle({ ok: false, reason: reasonFromErrorCode(error.code) });
        },
        { timeout: timeoutMs, maximumAge: MAXIMUM_AGE_MS },
      );
    } catch {
      // 実装によっては同期的に例外を投げる。取得できなかったものとして扱う
      settle({ ok: false, reason: "unavailable" });
    }
  });
}

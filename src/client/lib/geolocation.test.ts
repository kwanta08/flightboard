import { afterEach, describe, expect, it, vi } from "vitest";
import { requestPosition, type GeolocationResult } from "./geolocation.ts";

/** 成功・エラーのコールバックを手で呼べる偽の Geolocation */
function fakeGeolocation() {
  const calls: Array<{
    success: PositionCallback;
    error: PositionErrorCallback | null | undefined;
    options: PositionOptions | undefined;
  }> = [];

  const geo: Geolocation = {
    getCurrentPosition(success, error, options) {
      calls.push({ success, error, options });
    },
    watchPosition: () => 0,
    clearWatch: () => {},
  };

  const lastCall = () => {
    const call = calls.at(-1);
    if (call === undefined) {
      throw new Error("getCurrentPosition が呼ばれていません");
    }
    return call;
  };

  return {
    geo,
    calls,
    succeed(lat: number, lon: number, accuracy: number) {
      const coords: GeolocationCoordinates = {
        latitude: lat,
        longitude: lon,
        accuracy,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
        toJSON: () => ({}),
      };
      const position: GeolocationPosition = { coords, timestamp: 0, toJSON: () => ({}) };
      lastCall().success(position);
    },
    fail(code: number) {
      const error: GeolocationPositionError = {
        code,
        message: `code ${code}`,
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      };
      lastCall().error?.(error);
    },
  };
}

/** Promise の解決を記録する（偽タイマーでまだ解決していないことを確かめるため） */
function track(promise: Promise<GeolocationResult>) {
  const state: { result?: GeolocationResult } = {};
  void promise.then((result) => {
    state.result = result;
  });
  return state;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("requestPosition", () => {
  it("成功なら緯度・経度・精度を返す", async () => {
    const fake = fakeGeolocation();
    const promise = requestPosition(fake.geo, {});
    fake.succeed(35.8709, 139.9256, 25);
    await expect(promise).resolves.toEqual({ ok: true, lat: 35.8709, lon: 139.9256, accuracyM: 25 });
  });

  it.each([
    [1, "denied"],
    [2, "unavailable"],
    [3, "timeout"],
    [0, "unavailable"],
    [99, "unavailable"],
  ] as const)("エラーコード %d は %s", async (code, reason) => {
    const fake = fakeGeolocation();
    const promise = requestPosition(fake.geo);
    fake.fail(code);
    await expect(promise).resolves.toEqual({ ok: false, reason });
  });

  it("geo が無ければ unsupported", async () => {
    await expect(requestPosition(undefined)).resolves.toEqual({ ok: false, reason: "unsupported" });
  });

  it("getCurrentPosition を 1 回呼び、既定で timeout 10000ms・maximumAge 60000ms を渡す", () => {
    const fake = fakeGeolocation();
    void requestPosition(fake.geo);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.options).toEqual({ timeout: 10000, maximumAge: 60000 });
  });

  it("timeoutMs を指定するとその値を timeout として渡す", () => {
    const fake = fakeGeolocation();
    void requestPosition(fake.geo, { timeoutMs: 5000 });
    expect(fake.calls[0]?.options).toEqual({ timeout: 5000, maximumAge: 60000 });
  });

  it("どちらのコールバックも呼ばれないとき、timeoutMs + 1000ms 後に timeout で解決する", async () => {
    vi.useFakeTimers();
    const fake = fakeGeolocation();
    const state = track(requestPosition(fake.geo, { timeoutMs: 5000 }));

    await vi.advanceTimersByTimeAsync(5999);
    expect(state.result).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(state.result).toEqual({ ok: false, reason: "timeout" });
  });

  it("既定の timeoutMs では 11000ms 後に自前で timeout になる", async () => {
    vi.useFakeTimers();
    const fake = fakeGeolocation();
    const state = track(requestPosition(fake.geo));

    await vi.advanceTimersByTimeAsync(10999);
    expect(state.result).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(state.result).toEqual({ ok: false, reason: "timeout" });
  });

  it("自前のタイムアウトの後に成功が届いても timeout のまま", async () => {
    vi.useFakeTimers();
    const fake = fakeGeolocation();
    const state = track(requestPosition(fake.geo, { timeoutMs: 1000 }));

    await vi.advanceTimersByTimeAsync(2000);
    fake.succeed(35.8709, 139.9256, 25);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.result).toEqual({ ok: false, reason: "timeout" });
  });

  it("成功の後にエラーが呼ばれても最初の結果のまま", async () => {
    const fake = fakeGeolocation();
    const promise = requestPosition(fake.geo);
    fake.succeed(35.8709, 139.9256, 25);
    fake.fail(1);
    await expect(promise).resolves.toEqual({ ok: true, lat: 35.8709, lon: 139.9256, accuracyM: 25 });
  });

  it("エラーの後に成功が呼ばれても最初の結果のまま", async () => {
    const fake = fakeGeolocation();
    const promise = requestPosition(fake.geo);
    fake.fail(2);
    fake.succeed(35.8709, 139.9256, 25);
    await expect(promise).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("コールバックが呼ばれたら自前のタイムアウトのタイマーを解除する", async () => {
    vi.useFakeTimers();
    const fake = fakeGeolocation();
    const promise = requestPosition(fake.geo);
    expect(vi.getTimerCount()).toBe(1);
    fake.succeed(35.8709, 139.9256, 25);
    await promise;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("getCurrentPosition が同期的に例外を投げたら unavailable", async () => {
    const geo: Pick<Geolocation, "getCurrentPosition"> = {
      getCurrentPosition: () => {
        throw new Error("not allowed");
      },
    };
    await expect(requestPosition(geo)).resolves.toEqual({ ok: false, reason: "unavailable" });
  });
});

// 周辺の機体の自動更新を React に配線する（AC-B9・AC-B5）。
// 判断は lib/poller.ts（いつ送るか・結果の反映）と lib/api.ts（要求・条件のキー）に置き、ここはブラウザの API をつなぐだけにする。
import { useEffect, useState, useSyncExternalStore } from "react";
import { fetchNearby, nearbyParamsKey, type NearbyParams } from "../lib/api.ts";
import { createPoller, documentVisibility, type Poller, type PollerState } from "../lib/poller.ts";

function createBrowserNearbyPoller(): Poller<NearbyParams> {
  return createPoller<NearbyParams>({
    load: (params, signal) => fetchNearby(params, { fetch: (input, init) => window.fetch(input, init), signal }),
    timers: {
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (id) => window.clearInterval(id as number),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (id) => window.clearTimeout(id as number),
    },
    // 下の useNearby が条件の変更を判定するのと同じキーで、古い条件のデータを消すかを決める
    paramsKey: nearbyParamsKey,
    visibility: documentVisibility(document),
    now: () => Date.now(),
  });
}

/**
 * 条件 `params` で周辺の機体を自動更新し、その状態を返す。
 * `params` が undefined の間は開始しない。最初に決まったら開始し、以後は値（緯度・経度・半径・種類）が変わったときだけ条件を渡す。
 * アンマウント（と `params` が undefined に戻ったとき）に停止する
 */
export function useNearby(params: NearbyParams | undefined): PollerState {
  const [poller] = useState(createBrowserNearbyPoller);
  const key = nearbyParamsKey(params);
  const hasParams = key !== undefined;

  // 条件の値が変わったら渡す（オブジェクトの同一性ではなく key で比べる）。
  // 開始前は覚えるだけ、開始後は poller の規則で即 1 本送る。下の開始より先に宣言し、条件が決まった描画では start の前に呼ばれる
  useEffect(() => {
    if (params !== undefined) poller.setParams(params);
  }, [poller, key]);

  // 条件が決まったら開始し、アンマウントで停止する
  useEffect(() => {
    if (params === undefined) return;
    poller.start(params);
    return () => poller.stop();
  }, [poller, hasParams]);

  return useSyncExternalStore(poller.subscribe, poller.getState);
}

// 一定間隔で再描画して現在時刻を返す（「X 秒前に更新」を 1 秒ごとに進める、AC-B5）。判断は書かない。
import { useEffect, useState } from "react";

/** `intervalMs` ごとに再描画して現在時刻（epoch ミリ秒）を返す。アンマウントで解除する */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);

  return now;
}

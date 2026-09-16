// 起動時の部品の合成（位置の 3 提供元のフォールバック・adsbdb・航跡 → HTTP アプリ）。
// index.ts から呼ぶ。テストでは fetch・時計・待機・ファイルの有無を差し替えて配線を確かめる（上流には接続しない）。
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { createAdsbdbClient } from "./adsbdb/client.ts";
import { createEnrichment } from "./adsbdb/enrichment.ts";
import { createApp } from "./app.ts";
import { createFallbackProvider } from "./providers/fallback.ts";
import { createOpenSkyProvider } from "./providers/opensky.ts";
import type { FetchLike } from "./providers/provider.ts";
import { createAdsbFiProvider, createAdsbLolProvider } from "./providers/readsb.ts";
import { createTrackStore } from "./trackStore.ts";

export type ComposeAppOptions = {
  /** 位置の 3 提供元と adsbdb が共用する fetch（既定 `globalThis.fetch`） */
  fetch?: FetchLike;
  /** 現在時刻（ms）。フォールバック・adsbdb・航跡・アプリで共用する（既定 `Date.now`） */
  now?: () => number;
  /** adsbdb の要求の間隔を空ける待機（既定 `setTimeout` で待つ） */
  sleep?: (ms: number) => Promise<void>;
  /** ビルド済みクライアントのディレクトリ（`createApp` の `staticRoot`）。未指定なら静的配信しない */
  staticRoot?: string;
  /** ファイルが存在するか（`staticRoot` の `index.html` の確認に使う。既定 `node:fs` の `existsSync`） */
  fileExists?: (path: string) => boolean;
};

/** `staticRoot` に `index.html` が無いときに console.error に出す案内 */
export const MESSAGE_CLIENT_BUILD_NOT_FOUND = "ビルド済みの画面が見つかりません（npm run build または npm start を実行してください）";

export function composeApp(options: ComposeAppOptions = {}): Hono {
  const fetchImpl: FetchLike = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fileExists = options.fileExists ?? existsSync;
  const { staticRoot } = options;

  if (staticRoot !== undefined && !fileExists(join(staticRoot, "index.html"))) {
    // 起動は続ける（API は使える。画面の要求は「ページが見つかりません」の 404 になる）
    console.error(MESSAGE_CLIENT_BUILD_NOT_FOUND);
  }

  // 位置は adsb.lol → adsb.fi → OpenSky の順に試す（AC-A4）
  const positions = createFallbackProvider(
    [
      createAdsbLolProvider({ fetch: fetchImpl }),
      createAdsbFiProvider({ fetch: fetchImpl }),
      createOpenSkyProvider({ fetch: fetchImpl }),
    ],
    { now },
  );
  const adsbdbClient = createAdsbdbClient({ fetch: fetchImpl, now, sleep });
  const enrichment = createEnrichment({ client: adsbdbClient, now });
  const tracks = createTrackStore({ now });
  return createApp({ positions, enrichment, tracks, now, staticRoot });
}

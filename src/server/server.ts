// Node の HTTP サーバーとして Hono アプリを待ち受ける（@hono/node-server）。
import { serve } from "@hono/node-server";
import type { HttpBindings } from "@hono/node-server";
import { Server } from "node:http";
import type { AddressInfo } from "node:net";

export const DEFAULT_HOSTNAME = "127.0.0.1";
export const DEFAULT_PORT = 3000;
export const MAX_PORT = 65535;

/** `fetch` を持つアプリ（Hono アプリはこれに代入できる） */
export type FetchApp = {
  fetch: (request: Request, env: HttpBindings) => Response | Promise<Response>;
};

export type StartServerOptions = {
  app: FetchApp;
  /** 待ち受けるポート。0 なら OS が空きポートを割り当てる */
  port: number;
  /** 待ち受けるアドレス（既定 127.0.0.1） */
  hostname?: string;
};

export type RunningServer = {
  /** 実際に待ち受けているアドレスとポートの URL（例 `http://127.0.0.1:54321`） */
  url: string;
  /** 待ち受けを止め、接続がすべて閉じたら解決する（2 回目以降は 1 回目と同じ Promise） */
  close(): Promise<void>;
};

export type ParsePortResult = { ok: true; value: number } | { ok: false; error: string };

const DECIMAL_INT = /^\d+$/;

/** `PORT` 環境変数の値を読む。未設定なら 3000。0〜65535 の 10 進整数以外（空文字・空白入りを含む）はエラー */
export function parsePortEnv(raw: string | undefined): ParsePortResult {
  if (raw === undefined) return { ok: true, value: DEFAULT_PORT };
  const value = Number(raw);
  if (!DECIMAL_INT.test(raw) || value > MAX_PORT) {
    return { ok: false, error: `PORT が不正です: ${JSON.stringify(raw)}（0 以上 ${MAX_PORT} 以下の整数で指定してください）` };
  }
  return { ok: true, value };
}

export function startServer(options: StartServerOptions): Promise<RunningServer> {
  const { app, port } = options;
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);

    const server = serve({ fetch: (request, env) => app.fetch(request, env as HttpBindings), port, hostname }, (info) => {
      server.off("error", onError);
      let closing: Promise<void> | undefined;
      resolve({
        url: formatUrl(info),
        close() {
          closing ??= new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => (error ? rejectClose(error) : resolveClose()));
            // 待機中の keep-alive 接続を閉じ、close の完了を待たせない
            if (server instanceof Server) server.closeIdleConnections();
          });
          return closing;
        },
      });
    });
    server.once("error", onError);
  });
}

function formatUrl(info: AddressInfo): string {
  const host = info.family === "IPv6" ? `[${info.address}]` : info.address;
  return `http://${host}:${info.port}`;
}

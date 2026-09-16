// 起動エントリ（npm start）。PORT を読み、合成したアプリ（compose.ts）を待ち受けて URL を表示するだけにする。
import { fileURLToPath } from "node:url";
import { composeApp } from "./compose.ts";
import { parsePortEnv, startServer } from "./server.ts";

const port = parsePortEnv(process.env.PORT);
if (!port.ok) {
  console.error(port.error);
  process.exit(1);
}

// ビルド済みクライアント（npm run build の出力）。作業ディレクトリに依存しないよう、このファイルの位置から決める
const staticRoot = fileURLToPath(new URL("../../dist/client", import.meta.url));
const app = composeApp({ staticRoot });

try {
  const server = await startServer({ app, port: port.value });
  console.log(`FlightBoard BFF を起動しました: ${server.url}`);
} catch (error) {
  console.error(`サーバーを起動できませんでした（PORT=${port.value}）。ポートが使用中なら PORT 環境変数で変更してください`);
  console.error(error);
  process.exit(1);
}

// ブラウザ用クライアントのビルド設定（npm run build）。入出力は作業ディレクトリに依存しないよう、この設定ファイルの位置からの絶対パスで決める。
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./src/client", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("./dist/client", import.meta.url)),
    // outDir が root の外にあるため明示する（古いビルド成果物を残さない）
    emptyOutDir: true,
  },
});

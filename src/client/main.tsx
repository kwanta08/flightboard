// ブラウザ側のエントリ。スタイルを読み込み、App を描画する配線だけを行う。
import "leaflet/dist/leaflet.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("描画先の #root 要素が見つかりません");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

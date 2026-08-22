import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
// 真斜体字形,给对话框水印用(components/AgentPlate.tsx)。不引这份浏览器只会把正体
// 做切变合成假斜体,在水印那个字号下很明显。只有 latin 子集会实际下载。
import "@fontsource-variable/inter/wght-italic.css";
import "./styles/global.css";
import { App } from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

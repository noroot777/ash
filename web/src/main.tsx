import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
// 真斜体字形,给对话框水印用(components/AgentPlate.tsx)。不引这份浏览器只会把正体
// 做切变合成假斜体,在水印那个字号下很明显。只有 latin 子集会实际下载。
import "@fontsource-variable/inter/wght-italic.css";
import "./styles/global.css";
// 配色开关在任何组件渲染之前就位(index.html 已经按镜像拨过一次，这里接管后续的翻面)。
import "./lib/theme.ts";
import { App } from "./App.tsx";
import { AppCrash, ErrorBoundary } from "./components/ErrorBoundary.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary fallback={(error) => <AppCrash error={error} />}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextMeterChip } from "../src/components/ContextMeterChip.tsx";

const withCompactWindow = renderToStaticMarkup(
  <ContextMeterChip context={{
    used: 272_074,
    window: 1_000_000,
    windowEstimated: false,
    compactWindow: 400_000,
  }} />,
);
assert.match(withCompactWindow, /上下文剩 32%/, "胶囊应按执行器的 400k 自动压缩窗口计算剩余量");
assert.match(withCompactWindow, /272,074 \/ 400,000 token/, "无障碍说明也必须使用自动压缩窗口");

const modelWindowOnly = renderToStaticMarkup(
  <ContextMeterChip context={{ used: 272_074, window: 1_000_000, windowEstimated: false }} />,
);
assert.match(modelWindowOnly, /上下文剩 73%/, "没配自动压缩窗口时仍应使用 CLI 自报的模型窗口");

console.log("context meter compact-window priority ok");

import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { browserPreviewUrl, previewNoticeText } from "../src/lib/previewUrl.ts";
import { SystemAuthoredMessage, SystemBoundary, SystemEventDigest, SystemEventNote } from "../src/task-detail/SystemNotice.tsx";
import type { ConversationItem } from "../src/task-detail/conversationModel.ts";

const path = "/api/tasks/preview-task/preview/open/web";
const remotePage = "https://ash.example:8443/tasks/preview-task?view=chat";
const expected = "https://ash.example:8443" + path;
assert.equal(browserPreviewUrl(path, remotePage), expected);
assert.equal(browserPreviewUrl(path, "http://localhost:4317/"), "http://localhost:4317" + path);
assert.equal(browserPreviewUrl("http://localhost:5173/nested/?q=1#part", remotePage), "http://ash.example:5173/nested/?q=1#part");
assert.equal(browserPreviewUrl("http://[::1]:5173/", remotePage), "http://ash.example:5173/");
assert.equal(browserPreviewUrl("http://localhost:5173/", "http://127.0.0.1:4317/"), "http://localhost:5173/");
assert.equal(browserPreviewUrl("https://preview.example/app/", remotePage), "https://preview.example/app/");
assert.equal(browserPreviewUrl(path, "invalid page"), path);

const freeText = `自由工作流预览已打开（手动）：${path}`;
const presetText = `预览已起：${path}（\`npm run dev\`）`;
for (const text of [freeText, presetText]) {
  assert.equal(previewNoticeText(text, remotePage), text.replace(path, expected));
}
assert.equal(previewNoticeText(`预览已起：${expected}`, remotePage), `预览已起：${expected}`);
assert.equal(previewNoticeText("无关路径：/api/tasks/preview-task/log", remotePage), "无关路径：/api/tasks/preview-task/log");
assert.equal(previewNoticeText(`${path}\n${path}`, remotePage), `${expected}\n${expected}`);

const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
try {
  Object.defineProperty(globalThis, "location", { configurable: true, value: { href: remotePage } });
  assert.equal(browserPreviewUrl(path), expected, "toast 和链接使用当前访问页面的 origin");
  for (const text of [freeText, presetText]) {
    const item: Extract<ConversationItem, { kind: "event" }> = { kind: "event", id: "preview", text, tone: "neutral" };
    const surfaces = [
      <SystemEventNote item={item} />,
      <SystemBoundary item={item} />,
      <SystemBoundary item={item} mode="aligned" surface="team" />,
      <SystemEventDigest items={[item]} mode="collapsed" />,
      <SystemAuthoredMessage item={{ kind: "user", id: "action", text: "预览已启动", attachments: [] }} related={[item]} />,
    ];
    for (const surface of surfaces) {
      assert(renderToStaticMarkup(surface).includes(expected), "时间线各呈现方式均包含可复制的完整地址");
    }
  }
  Object.defineProperty(globalThis, "location", { configurable: true, value: { href: "https://another-ash.example/" } });
  assert.equal(previewNoticeText(freeText), freeText.replace(path, "https://another-ash.example" + path), "历史记录跟随当前访问入口");
  Reflect.deleteProperty(globalThis, "location");
  assert.equal(previewNoticeText(freeText), freeText, "无浏览器上下文时仍能安全渲染");
} finally {
  if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor);
  else Reflect.deleteProperty(globalThis, "location");
}
console.log("preview URL presentation: ok");

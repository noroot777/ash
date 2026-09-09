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
const directUrl = "http://localhost:51234/nested/?q=1#part";
const directExpected = "http://ash.example:51234/nested/?q=1#part";
const directFree = `自由工作流预览已打开（自动识别：npm run dev）：${directUrl}`;
const directPreset = `预览已起：${directUrl}（\`npm run dev\`）`;
for (const text of [freeText, presetText]) {
  assert.equal(previewNoticeText(text, remotePage), text.replace(path, expected));
}
for (const text of [directFree, directPreset]) {
  assert.equal(previewNoticeText(text, remotePage), text.replace(directUrl, directExpected));
  assert.equal(previewNoticeText(text, "http://localhost:4317/"), text, "本地入口保留直连回环地址");
}
for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"]) {
  assert.equal(previewNoticeText(`预览已起：https://${host}:51234/`, remotePage), "预览已起：https://ash.example:51234/");
}
assert.equal(previewNoticeText("预览已起：http://localhost:51234（启动成功）", remotePage), "预览已起：http://ash.example:51234/（启动成功）");
assert.equal(previewNoticeText("预览已起：http://localhost:51234/。", remotePage), "预览已起：http://ash.example:51234/。");
assert.equal(previewNoticeText(directFree, "http://192.168.1.8:4317/"), directFree.replace("localhost", "192.168.1.8"));
assert.equal(previewNoticeText(directFree, "http://[2001:db8::8]:4317/"), directFree.replace("localhost", "[2001:db8::8]"));
for (const url of ["http://localhost.example:51234/", "http://127.0.0.10:51234/", "http://localhost@external.example/"]) {
  assert.equal(previewNoticeText(`预览已起：${url}`, remotePage), `预览已起：${url}`, "不改写回环名称的非回环前缀");
}
assert.equal(previewNoticeText(`预览已起：${expected}`, remotePage), `预览已起：${expected}`);
assert.equal(previewNoticeText("无关路径：/api/tasks/preview-task/log", remotePage), "无关路径：/api/tasks/preview-task/log");
assert.equal(previewNoticeText(`${path}\n${path}`, remotePage), `${expected}\n${expected}`);

const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
try {
  Object.defineProperty(globalThis, "location", { configurable: true, value: { href: remotePage } });
  assert.equal(browserPreviewUrl(path), expected, "toast 和链接使用当前访问页面的 origin");
  for (const [text, url] of [[freeText, expected], [presetText, expected], [directFree, directExpected], [directPreset, directExpected]]) {
    const item: Extract<ConversationItem, { kind: "event" }> = { kind: "event", id: "preview", text, tone: "neutral" };
    const surfaces = [
      <SystemEventNote item={item} />,
      <SystemBoundary item={item} />,
      <SystemBoundary item={item} mode="aligned" surface="team" />,
      <SystemEventDigest items={[item]} mode="collapsed" />,
      <SystemAuthoredMessage item={{ kind: "user", id: "action", text: "预览已启动", attachments: [] }} related={[item]} />,
    ];
    for (const surface of surfaces) {
      const markup = renderToStaticMarkup(surface);
      assert(markup.includes(url), "反代和直连的时间线各呈现方式均包含当前入口的完整地址");
      assert(!markup.includes("localhost"), "远程入口的直连时间线不残留回环地址");
    }
  }
  Object.defineProperty(globalThis, "location", { configurable: true, value: { href: "https://another-ash.example/" } });
  assert.equal(previewNoticeText(freeText), freeText.replace(path, "https://another-ash.example" + path), "历史记录跟随当前访问入口");
  assert.equal(previewNoticeText(directFree), directFree.replace("localhost", "another-ash.example"), "直连历史记录也跟随当前入口");
  Reflect.deleteProperty(globalThis, "location");
  assert.equal(previewNoticeText(freeText), freeText, "无浏览器上下文时仍能安全渲染");
  assert.equal(previewNoticeText(directFree), directFree, "无浏览器上下文时保留原始直连地址");
} finally {
  if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor);
  else Reflect.deleteProperty(globalThis, "location");
}
console.log("preview URL presentation: ok");

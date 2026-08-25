import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ScheduledMessage } from "@ash/shared";
import { ScheduledMessageTray } from "../src/components/ScheduledMessages.tsx";

const row = (id: string, text: string, sendAt: string): ScheduledMessage => ({
  id,
  taskId: "task",
  text,
  attachments: [],
  agent: null,
  executorId: null,
  model: null,
  reasoningEffort: null,
  mode: "queued",
  sendAt,
  status: "pending",
  createdAt: sendAt,
  sentAt: null,
});

const html = renderToStaticMarkup(
  <ScheduledMessageTray
    messages={[
      row("later", "第二条", "2026-08-25T10:00:01.000Z"),
      row("first", "第一条", "2026-08-25T10:00:00.000Z"),
    ]}
    loading={false}
    error={null}
    cancelingIds={new Set()}
    steeringIds={new Set()}
    onSteer={() => undefined}
    onCancel={() => undefined}
  />,
);

assert.equal((html.match(/>引导会话</g) ?? []).length, 1, "两条 queued 只能显示一个托盘级引导动作");
assert.match(html, /用最早的排队消息“第一条”引导会话/, "唯一动作必须指向队首消息");
assert.ok(
  html.lastIndexOf("scheduled-message-guide-row") > html.lastIndexOf("scheduled-message-row"),
  "引导动作应位于队列末尾，而不是塞进每一行",
);
const source = readFileSync(new URL("../src/components/ScheduledMessages.tsx", import.meta.url), "utf8");
const reloadSource = source.slice(source.indexOf("const reload"), source.indexOf("useEffect", source.indexOf("const reload")));
assert.match(source, /const \[actionError, setActionError\]/, "动作错误必须与加载错误分开保存");
assert.doesNotMatch(reloadSource, /setActionError/, "quiet reload 不得清掉刚返回的引导失败原因");
console.log("✓ 待发送托盘末尾只显示一个“引导会话”，并作用于队首消息");

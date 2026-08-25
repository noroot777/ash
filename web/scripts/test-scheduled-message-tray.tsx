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
const firstRowStart = html.indexOf('<div class="scheduled-message-row">');
const firstRowEnd = html.indexOf("</div>", firstRowStart);
const firstRow = html.slice(firstRowStart, firstRowEnd);
const secondRow = html.slice(html.indexOf('<div class="scheduled-message-row">', firstRowEnd));
assert.match(firstRow, /scheduled-message-guide/, "引导动作应放在队首消息行内");
assert.doesNotMatch(secondRow, /scheduled-message-guide/, "较晚消息行不得重复显示引导动作");
assert.ok(
  firstRow.indexOf("scheduled-message-guide") < firstRow.indexOf("取消排队中的待发送消息"),
  "引导动作应位于取消按钮左侧",
);
const source = readFileSync(new URL("../src/components/ScheduledMessages.tsx", import.meta.url), "utf8");
const reloadSource = source.slice(source.indexOf("const reload"), source.indexOf("useEffect", source.indexOf("const reload")));
assert.match(source, /const \[actionError, setActionError\]/, "动作错误必须与加载错误分开保存");
assert.doesNotMatch(reloadSource, /setActionError/, "quiet reload 不得清掉刚返回的引导失败原因");
console.log("✓ 队首消息行内、取消按钮左侧只显示一个“引导会话”");

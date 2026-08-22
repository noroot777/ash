import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Task } from "@ash/shared";
import { ConversationFeed } from "../src/task-detail/ConversationFeed.tsx";
import type { ConversationItem } from "../src/task-detail/conversationModel.ts";

const at = "2026-08-14T02:42:00.000Z";
const task = {
  id: "continuation-time",
  title: "续写时间",
  body: "",
  status: "done",
  mode: "single",
} as unknown as Task;

const agent = (id: string): ConversationItem => ({
  kind: "agent",
  id,
  sessionId: "session",
  label: "codex@cpa",
  at,
  endedAt: null,
  continuation: true,
  markdown: "继续处理。",
  segments: [{ id: `${id}:segment`, markdown: "继续处理。", events: [], attachments: [] }],
});

const render = (eventAt?: string) => renderToStaticMarkup(
  <ConversationFeed
    task={task}
    items={[
      {
        kind: "event",
        id: "note",
        text: "已预约完成后审查。",
        at: eventAt,
        variant: "note",
        tone: "neutral",
      },
      agent(eventAt ? "persisted" : "live"),
    ]}
    sessions={[]}
    loading={false}
    error={null}
  />,
);

const count = (text: string, needle: string) => text.split(needle).length - 1;

const persisted = render(at);
assert.equal(count(persisted, "<time>"), 1, "落盘旁注已有时间时，续写段不应重复");
assert.equal(count(persisted, 'aria-label="复制这条回复"'), 1, "压平消息头不能删掉复制入口");
assert.match(persisted, /task-message-copy-action/, "无用时的续写段应把复制入口放到尾栏");

const live = render();
assert.equal(count(live, "<time>"), 1, "直播旁注没有时间时，续写段必须保留唯一时间");
assert.equal(count(live, 'aria-label="复制这条回复"'), 1, "直播续写段必须保留复制入口");
assert.doesNotMatch(live, /task-message-copy-action/, "直播续写段仍使用正常消息头");

console.log("conversation-continuation ok");

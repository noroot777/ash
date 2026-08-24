import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Task } from "@ash/shared";
import { ConversationFeed } from "../src/task-detail/ConversationFeed.tsx";
import type { ConversationItem } from "../src/task-detail/conversationModel.ts";
import { TeamFeed } from "../src/team/TeamFeed.tsx";

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

const note: ConversationItem = {
  kind: "event",
  id: "note",
  text: "已预约完成后审查。",
  at,
  variant: "note",
  tone: "neutral",
};
const continuation = agent("persisted");

const render = () => renderToStaticMarkup(
  <ConversationFeed
    task={task}
    items={[note, continuation]}
    sessions={[]}
    loading={false}
    error={null}
  />,
);

const count = (text: string, needle: string) => text.split(needle).length - 1;

const persisted = render();
assert.equal(count(persisted, "<time>"), 1, "落盘旁注已有时间时，续写段不应重复");
assert.equal(count(persisted, 'aria-label="复制这条回复"'), 1, "压平消息头不能删掉复制入口");
assert.match(persisted, /task-message-copy-action/, "无用时的续写段应把复制入口放到尾栏");

const team = renderToStaticMarkup(
  <TeamFeed
    task={{ ...task, mode: "team" } as Task}
    rows={[
      { kind: "conv", key: "note", item: note },
      { kind: "conv", key: "agent", item: continuation },
    ]}
    workers={[]}
    onOpenWorker={() => undefined}
    onAskLead={() => undefined}
    delegatingIds={new Set()}
    indicatorForTask={() => null}
  />,
);
assert.equal(count(team, "<time>"), 1, "团队旁注也应自己显示时间，续写段不再另起一行");
assert.match(team, /conversation-note[^>]*>已预约完成后审查。<time>/);
assert.doesNotMatch(team, /team-feed-agent[^>]*><header>/, "团队续写没有额外元信息时不应留下空消息头");

console.log("conversation-continuation ok");

import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "@ash/shared";
import { buildConversationItems } from "../src/task-detail/conversationModel.ts";
import {
  conversationFeedRows,
  reviewLaneMessageRoles,
  type ConversationReviewLane,
} from "../src/task-detail/conversationReviewLanes.ts";
import { ConversationFeed } from "../src/task-detail/ConversationFeed.tsx";
import { ReviewerLane } from "../src/task-detail/ReviewerLane.tsx";

const session = {
  id: "presentation",
  taskId: "t1",
  agentType: "codex",
  executor: "codex@local",
  role: "single",
  startedAt: "2026-08-11T02:00:00.000Z",
  endedAt: null,
} as unknown as Session;

const turn = (kind: string, text: string, at: string, extra: Record<string, string> = {}) =>
  `\x1e${JSON.stringify({ t: kind, text, at, ...extra })}`;

const build = (lines: string[]) => buildConversationItems(
  [{ session, output: lines.join("\n"), trace: [] }],
  [session],
  [],
);

const start = "自由工作流第 3 轮审查开始：5.5审查 · 逻辑检查。";
const end = "自由工作流第 3 轮审查未通过，意见已发回会话；修复确认完成后自动复审。";
const freePrompt = "【自由工作流审查未通过 · 第 3 轮】\n请先完整读取 report.md，再调用 complete_task。\n\n证据目录：/tmp/review";

const protocolItems = build([
  turn("system", start, "2026-08-11T02:00:00.000Z"),
  turn("system", "〔系统〕继续（从中断处）", "2026-08-11T02:01:00.000Z"),
  turn("system", end, "2026-08-11T02:40:00.000Z"),
  turn("user", freePrompt, "2026-08-11T02:41:00.000Z", { by: "system" }),
]);

const withoutReport = conversationFeedRows(protocolItems);
const protocolLane = withoutReport.find((row): row is ConversationReviewLane => row.kind === "review-lane");
assert.ok(protocolLane);
assert.deepEqual(
  protocolLane.items.map((item) => item.kind === "event" ? item.text : item.kind),
  [end],
  "卡内隐藏开始和 checkpoint，只保留结论",
);
assert.equal(
  withoutReport.some((row) => row.kind === "item" && row.item.kind === "user" && row.item.text === freePrompt),
  true,
  "没有 report.md 时保留自由派审 prompt 作为证据目录兜底",
);

const withReport = conversationFeedRows(protocolItems, { reviews: [{
  id: "fr3",
  reviewerName: "5.5审查",
  model: "claude-opus-5",
  target: { kind: "workspace" },
  rounds: [{ round: 3, startedAt: "2026-08-11T02:00:00.000Z", reportMarkdown: "# 报告" }],
}] as never });
assert.equal(
  withReport.some((row) => row.kind === "item" && row.item.kind === "user" && row.item.text === freePrompt),
  false,
  "report.md 可打开时隐藏自由派审修复 prompt",
);

const plainResume = conversationFeedRows(build([
  "暂停前正文。",
  turn("system", "〔系统〕继续（从中断处）", "2026-08-11T03:00:00.000Z"),
  "续跑正文。",
]));
assert.equal(
  plainResume.some((row) => row.kind === "item" && row.item.kind === "event" && row.item.text.includes("继续（从中断处）")),
  true,
  "普通任务必须保留续跑标记",
);

const inlinePrompt = "【自动验证未通过 · 第 1 轮】\n请先完整读取 report.md。\n\n证据目录：/tmp/inline";
const inlineRows = conversationFeedRows(build([
  turn("system", "第 1 轮验证开始：就在这个任务的工作目录里跑。", "2026-08-11T04:00:00.000Z"),
  "审查正文。",
  turn("system", "第 1 轮验证未通过，意见已发回会话。", "2026-08-11T04:30:00.000Z"),
  turn("user", inlinePrompt, "2026-08-11T04:31:00.000Z", { by: "system" }),
]));
assert.equal(
  inlineRows.some((row) => row.kind === "item" && row.item.kind === "user" && row.item.text === inlinePrompt),
  false,
  "就地验证的同款巨型修复 prompt 也应隐藏",
);

const emptyLane = conversationFeedRows(build([
  turn("system", "自由工作流第 4 轮审查开始：5.5审查 · 逻辑检查。", "2026-08-11T05:00:00.000Z"),
])).find((row): row is ConversationReviewLane => row.kind === "review-lane");
assert.ok(emptyLane);
assert.equal(emptyLane.items.length, 0);
const emptyMarkup = renderToStaticMarkup(<ReviewerLane taskId="t1" lane={emptyLane}>{null}</ReviewerLane>);
assert.match(emptyMarkup, /verify-lane is-collapsed/, "空正文卡按收起态绘制，不留分隔线");
assert.doesNotMatch(emptyMarkup, />展开<|>收起</, "没有正文时不显示无效的展开按钮");
assert.match(emptyMarkup, /class="verify-lane-body"[^>]*hidden=""/, "没有正文时 body 必须隐藏");

// 派审附言是这一轮审查的输入，卡里必须看得见 —— 否则它写完就只剩派审对话框里那个
// textarea 知道，用户读结论时无从核对「我要求重点看的那一点他看了没有」。
const noteText = "重点看 SSE 断线重连，别只跑单测。";
const noteLane = conversationFeedRows(protocolItems, { reviews: [{
  id: "fr3",
  reviewerName: "5.5审查",
  model: "claude-opus-5",
  note: noteText,
  retryLimit: 2,
  target: { kind: "workspace" },
  rounds: [{ round: 3, startedAt: "2026-08-11T02:00:00.000Z", reportMarkdown: "# 报告" }],
}] as never }).find((row): row is ConversationReviewLane => row.kind === "review-lane");
assert.ok(noteLane);
assert.equal(noteLane.note, noteText, "附言从 run 上补进审查卡");
const noteMarkup = renderToStaticMarkup(<ReviewerLane taskId="t1" lane={noteLane}>{null}</ReviewerLane>);
assert.match(noteMarkup, /派审附言/, "卡内正文顶部摆出附言");
assert.match(noteMarkup, /重点看 SSE 断线重连/, "附言正文原样呈现");
assert.match(noteMarkup, /含附言/, "卡头留标记，折叠着也看得出这一轮带附言");

// —— 卡内首条气泡的头曾经是卡头的逐字复读：审查者名、模型、轮次徽标、开始时间、用时
// 全部在卡头上写过一遍。省掉整条头之后，模型旁边的智能水平只剩卡头这一处，必须补上。
const laneRun = (turnStartedAt: string, verifyRound?: number) => ({
  at: turnStartedAt,
  turnStartedAt,
  event: { kind: "run", model: "gpt-5.5", reasoningEffort: "high", ...(verifyRound ? { verifyRound } : {}) },
});
const laneItems = buildConversationItems([{
  session,
  output: [
    turn("system", "第 1 轮验证开始：就在这个任务的工作目录里跑。", "2026-08-11T06:00:00.000Z"),
    "审查正文。",
    turn("system", "第 1 轮验证通过。", "2026-08-11T06:30:00.000Z"),
  ].join("\n"),
  trace: [laneRun("2026-08-11T06:00:00.000Z", 1)],
} as never], [session], []);
const inlineLane = conversationFeedRows(laneItems)
  .find((row): row is ConversationReviewLane => row.kind === "review-lane");
assert.ok(inlineLane);
assert.equal(inlineLane.reviewerEffort, "high", "智能水平跟着模型一起搬到卡头");
const laneAgent = inlineLane.items.find((item) => item.kind === "agent");
assert.ok(laneAgent);
assert.equal(reviewLaneMessageRoles(inlineLane).get(laneAgent.id), "lead", "本轮第一条审查发言由卡头代言");

const feedMarkup = renderToStaticMarkup(
  <ConversationFeed
    task={{ id: "t1", status: "done" } as never}
    items={laneItems}
    sessions={[session]}
    loading={false}
    error={null}
  />,
);
assert.match(feedMarkup, /gpt-5\.5 · high/, "卡头报出模型与智能水平");
assert.doesNotMatch(feedMarkup, /agent-run-identity/, "卡内首条气泡不再重复审查者与模型");
assert.doesNotMatch(feedMarkup, /verify-badge/, "轮次徽标是卡头标题的复读，卡内不出");
assert.doesNotMatch(feedMarkup, /task-turn-duration/, "用时已在卡头，首条气泡不再重复");
assert.doesNotMatch(feedMarkup, /task-message-avatar/, "卡头左边已有一颗盾，卡内气泡不再各挂一颗");

console.log("review-presentation ok");

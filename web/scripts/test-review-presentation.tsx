import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "@ash/shared";
import { buildConversationItems } from "../src/task-detail/conversationModel.ts";
import { conversationFeedRows, type ConversationReviewLane } from "../src/task-detail/conversationReviewLanes.ts";
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

console.log("review-presentation ok");

import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "@ash/shared";
import { buildConversationItems } from "../src/task-detail/conversationModel.ts";
import { conversationFeedRows, type ConversationReviewLane } from "../src/task-detail/conversationReviewLanes.ts";
import { ReviewerLane } from "../src/task-detail/ReviewerLane.tsx";
import { conversationSystemRows } from "../src/task-detail/conversationSystemRows.ts";
import { SystemAuthoredMessage } from "../src/task-detail/SystemNotice.tsx";

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
  false,
  "没有 report.md 时也不退回巨型系统消息",
);
assert.equal(protocolLane.repairHandoff?.text, freePrompt, "没有 report.md 时把证据目录保留在卡内展开区");
const protocolMarkup = renderToStaticMarkup(<ReviewerLane taskId="t1" lane={protocolLane}>{null}</ReviewerLane>);
assert.match(protocolMarkup, /verify-lane--repair/, "审查失败交接使用紧凑状态卡");
assert.match(protocolMarkup, /查看审查要求/, "原始要求仍有明确入口");
assert.match(protocolMarkup, /证据目录：\/tmp\/review/, "服务端渲染时原始证据目录没有丢失");

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
assert.equal(
  withReport.find((row): row is ConversationReviewLane => row.kind === "review-lane")?.repairHandoff?.text,
  freePrompt,
  "有报告入口时原始交接同样留在卡内",
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
assert.equal(
  inlineRows.find((row): row is ConversationReviewLane => row.kind === "review-lane")?.repairHandoff?.text,
  inlinePrompt,
  "就地验证的原始要求并入本轮卡片",
);

const conflictPrompt = "【验收未通过 · 需要你解冲突】\n用户点了验收通过，合并时发生冲突，已经安全回滚。\n\n冲突文件：\n- server/package.json\n- web/src/App.tsx\n\n请你来解决：\n1. 在任务分支合并 main；\n2. 解完重新验收。";
const conflictItems = build([
  turn("system", "开始验收：准备安全合并到 main。", "2026-08-11T06:00:00.000Z"),
  turn("system", "验收未完成：合并任务分支到 main 发生冲突。", "2026-08-11T06:00:01.000Z"),
  turn("system", "冲突交接：已叫醒该任务去解冲突。", "2026-08-11T06:00:02.000Z"),
  turn("user", conflictPrompt, "2026-08-11T06:00:03.000Z", { by: "system" }),
]);
const conflictRows = conversationSystemRows(conversationFeedRows(conflictItems));
assert.equal(conflictRows.length, 1, "冲突的开始、失败、交接与长指令应收成一条旁注");
const conflictRow = conflictRows[0];
assert.equal(conflictRow.kind, "system-action");
assert.equal(conflictRow.related.length, 3, "原始系统记录保留在旁注展开区");
const conflictMarkup = renderToStaticMarkup(<SystemAuthoredMessage item={conflictRow.item} related={conflictRow.related} />);
assert.match(conflictMarkup, /验收遇到冲突/);
assert.match(conflictMarkup, /目标分支未改动/);
assert.match(conflictMarkup, /server\/package\.json/);
assert.match(conflictMarkup, /流程记录 3 条/);

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

console.log("review-presentation ok");

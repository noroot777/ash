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
import { ReviewBubble } from "../src/task-detail/ReviewBubble.tsx";
import { lastSentence, reviewProgress } from "../src/task-detail/reviewProgress.ts";

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
// 还没开口的那一轮：右边一颗气泡，写「第 N 轮审查中」；没有可摊的，就不是一颗点了没反应的键。
const emptyMarkup = renderToStaticMarkup(<ReviewBubble taskId="t1" lane={emptyLane} progress={reviewProgress(emptyLane, { status: "running" }, true)} />);
assert.match(emptyMarkup, /<div class="review-verdict is-pending">/, "进行中也是右边那一颗气泡");
assert.match(emptyMarkup, /workspace-status-dot--run[^"]*" aria-hidden="true"><\/span><span data-selection-content="">第 4 轮审查中<\/span>/, "没说话时气泡里写轮次，字前一颗会动的点");
assert.doesNotMatch(emptyMarkup, /<button type="button" class="review-verdict-text"/, "没有正文时没有无效的展开键");
assert.match(emptyMarkup, /class="review-verdict-text is-static" tabindex="0"/, "键盘照样走得进来，指到才出的那一行看得见");
assert.doesNotMatch(emptyMarkup, /verify-lane|ShieldCheck|进行中/, "没有卡、没有盾、没有「进行中」徽章");

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
assert.equal(noteLane.note, noteText, "附言从 run 上补进这一轮");
// 收了口的一轮是一颗审查结论气泡：平时只有一句结论，附言、报告、证据都在右侧「审查」格那一轮里。
const noteMarkup = renderToStaticMarkup(<ReviewBubble taskId="t1" lane={noteLane} />);
assert.match(noteMarkup, /class="review-verdict"/, "出了结论的一轮收成一颗气泡");
assert.match(noteMarkup, /<button type="button" class="review-verdict-text"[^>]*><span data-selection-content="">第 3 轮审查未通过<\/span><\/button>/, "结论写在字里，不带颜色（单独摆的一轮是过去的事）");
assert.doesNotMatch(noteMarkup, /turn-footnote-dot/, "过去的事不带点");
assert.match(noteMarkup, /<header><b>审查者<\/b><span class="review-verdict-meta"> · 5\.5审查 · 40m 0s · /, "指到才出的那一行：发送者写在最前面，后面是谁审的、用时、时刻");
assert.match(noteMarkup, /<button type="button" aria-label="审查报告">/, "有报告时那一行里带一颗报告键");
assert.equal((noteMarkup.match(/<svg/g) ?? []).length, 1, "气泡里唯一的图形是报告键");
assert.doesNotMatch(noteMarkup, /重点看 SSE 断线重连/, "附言不摊在会话里");
const opened: Array<unknown> = [];
const linkedMarkup = renderToStaticMarkup(<ReviewBubble taskId="t1" lane={noteLane} onOpenRound={(round) => opened.push(round)} />);
assert.match(linkedMarkup, /aria-label="第 3 轮审查未通过，在右侧审查格里打开这一轮"/, "接上审查格时整颗气泡就是去那一轮的键");
const liveMarkup = renderToStaticMarkup(<ReviewBubble lane={noteLane} live />);
assert.match(liveMarkup, /<div class="review-verdict" role="status">/, "还是现在的未通过：读屏听得到");
assert.match(liveMarkup, /<span class="turn-footnote-dot is-bad" aria-hidden="true"><\/span><span data-selection-content="">第 3 轮审查未通过/, "字前一颗红点");
assert.doesNotMatch(renderToStaticMarkup(<ReviewBubble lane={{ ...noteLane, conclusion: "verified", verdict: "passed" }} live />), /turn-footnote-dot|role="status"/, "通过不带任何颜色");
assert.match(renderToStaticMarkup(<ReviewBubble lane={{ ...noteLane, conclusion: "inconclusive", verdict: "inconclusive" }} live />), /turn-footnote-dot is-warn/, "没有给出结论：琥珀点");
assert.doesNotMatch(renderToStaticMarkup(<ReviewBubble lane={noteLane} />), /aria-label="审查报告"/, "拿不到任务（报告地址挂在任务上）就不出报告键");
// 还在跑的那一轮：附言是这一轮审查的输入，收着时浮出那一行看得出「含附言」，摊开后在最前（DOM 测试里点开看）。
const runningNoteLane = { ...noteLane, complete: false, conclusion: null, verdict: null, reportAvailable: false, report: null };
const runningNoteMarkup = renderToStaticMarkup(<ReviewBubble taskId="t1" lane={runningNoteLane} progress={reviewProgress(runningNoteLane, { status: "running" }, true)} />);
assert.match(runningNoteMarkup, /<span class="review-verdict-meta"> · 5\.5审查 · claude-opus-5 · 第 3\/3 轮审查 · [^<]* · 含附言<\/span>/, "浮出那一行：谁、模型、第几轮/最多几轮、开始时刻、含附言");
assert.match(runningNoteMarkup, /aria-expanded="false"/, "默认收着");
assert.doesNotMatch(runningNoteMarkup, /重点看 SSE 断线重连/, "收着时附言不摊开");
const findingsMarkup = renderToStaticMarkup(<ReviewBubble taskId="t1" lane={{ ...noteLane, findings: 2 }} />);
assert.match(findingsMarkup, />第 3 轮审查未通过，2 条意见</, "抽得出意见条数时写进那一句");

// —— 气泡里写审查者最新说完的那一句；还在冒字的半句不算（逐字换字就是抖）——
assert.equal(lastSentence("先核对需求。\n\n改动面已过一遍；接下来验证启动状态。", false), "接下来验证启动状态。");
assert.equal(lastSentence("先核对需求。接下来验证启", true), "先核对需求。", "还在说的那一回合只认说完了的句子");
assert.equal(lastSentence("## 结论\n\n- **两处**入口都按 `run` 事件判断。", false), "两处入口都按 run 事件判断。", "markdown 记号剥掉，标题不算一句");
assert.equal(lastSentence("看一下：\n```sh\ngit status", true), "看一下：", "没闭合的代码块不算话");
assert.equal(lastSentence("跑了 a.ts 和 b.ts", true), null, "文件名里的点不是句末");

const said = (markdown: string, endedAt: string | null, segments?: unknown[]) => ({
  kind: "agent", id: `r:${markdown.length}`, label: "5.5审查", agentType: "claude", reviewer: { round: 3 }, at: "2026-08-11T02:00:10.000Z", endedAt, markdown,
  segments: segments ?? [{ id: "s0", markdown, events: [], attachments: [] }],
}) as never;
const speaking = { ...runningNoteLane, items: [
  said("我先核对需求、实际改动和回归登记。", "2026-08-11T02:01:00.000Z"),
  said("改动面已过一遍；接下来验证配置冲突。正在看", null, [
    { id: "a", markdown: "改动面已过一遍；接下来验证配置冲突。正在看", events: [], attachments: [] },
    { id: "b", markdown: "", events: [{ kind: "tool", label: "Bash", detail: JSON.stringify({ command: "git diff --stat" }) }], attachments: [] },
  ]),
] };
const running = reviewProgress(speaking, { status: "running" }, true);
assert.deepEqual(
  { phase: running.phase, text: running.text, said: running.said },
  { phase: "running", text: "接下来验证配置冲突。", said: true },
  "气泡里是审查者最新说完的那一句",
);
assert.match(running.step ?? "", /git diff --stat/, "下面那一行是正在跑的那条命令");
const runningMarkup = renderToStaticMarkup(<ReviewBubble taskId="t1" lane={speaking} progress={running} />);
assert.match(runningMarkup, /class="review-progress-say"[^>]*>接下来验证配置冲突。<\/span>/, "那一句最多两行");
assert.match(runningMarkup, /<p class="review-progress-now"><span class="review-progress-step">[^<]*git diff --stat[^<]*<\/span><time>/, "收着时气泡下面：在跑的命令 + 用时");
assert.match(runningMarkup, /aria-label="第 3\/3 轮审查：接下来验证配置冲突。"/, "气泡是一颗有名字的键");

// —— 在等、停了：点不动（或者没有），字说现在等的是谁、等什么 ——
const phases = [
  [{ status: "paused", question: "要不要连 Windows 一起验？" }, "question", "在等你答复它的提问", "workspace-status-dot--wait"],
  [{ status: "paused", monitorRunning: true }, "monitor", "在等哨兵的结果", "workspace-status-dot--queue"],
  [{ status: "paused" }, "checkpoint", "停在检查点，等续跑", "workspace-status-dot--wait"],
  [{ status: "running", upstreamStalled: true }, "stalled", "在等模型上游回话", "workspace-status-dot--stalled"],
  [{ status: "failed" }, "stopped", "第 3 轮审查停了，没有给出结论", null],
] as const;
for (const [facts, phase, text, dot] of phases) {
  const progress = reviewProgress(speaking, facts as never, true);
  assert.deepEqual({ phase: progress.phase, text: progress.text, step: progress.step }, { phase, text, step: null }, phase);
  const markup = renderToStaticMarkup(<ReviewBubble taskId="t1" lane={speaking} progress={progress} />);
  assert.doesNotMatch(markup, /workspace-status-dot--run/, `${phase}：点不动`);
  if (dot) assert.match(markup, new RegExp(dot), `${phase}：静止的那一档记号`);
  else assert.doesNotMatch(markup, /workspace-status-dot/, `${phase}：停了就没有点`);
  assert.doesNotMatch(markup, /review-progress-step/, `${phase}：没有在跑的命令`);
}
assert.equal(reviewProgress(speaking, { status: "running" }, false).phase, "stopped", "后面有人接了话的那一轮不是「此刻」");
// 停了的那一轮收着时，气泡下面是它最后那句尾注（原因、继续本轮审查）。
const stoppedMarkup = renderToStaticMarkup(
  <ReviewBubble taskId="t1" lane={speaking} progress={reviewProgress(speaking, { status: "failed" }, true)} trailing={<p className="cause">这一轮审查是中途断掉的</p>} />,
);
assert.match(stoppedMarkup, /<p class="cause">这一轮审查是中途断掉的<\/p>/);
assert.doesNotMatch(stoppedMarkup, /review-progress-now/);

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
assert.doesNotMatch(feedMarkup, /class="turn-head"><b>/, "卡内首条气泡不再重复审查者");
assert.doesNotMatch(feedMarkup, /turn-meta">[^<]*gpt-5\.5/, "卡内首条气泡不再重复模型");
assert.doesNotMatch(feedMarkup, /verify-badge/, "轮次徽标是卡头标题的复读，卡内不出");
assert.doesNotMatch(feedMarkup, /turn-meta">[^<]*用时/, "用时已在卡头，首条气泡不再重复");
assert.doesNotMatch(feedMarkup, /task-message-avatar/, "卡头左边已有一颗盾，卡内气泡不再各挂一颗");

// 跑完了：同一轮在会话里收成一句，卡头那些（模型、智能水平）不再摆出来。
const doneItems = buildConversationItems([{
  session,
  output: [
    turn("system", "第 1 轮验证开始：就在这个任务的工作目录里跑。", "2026-08-11T06:00:00.000Z"),
    "审查正文。",
    // 就地验证通过不写收尾旁注，结论来自审查者 report_stage 写下的阶段翻档（见 test-reviewer-turn）。
    turn("system", "验收阶段更新：已验证（verified）", "2026-08-11T06:30:00.000Z"),
  ].join("\n"),
  trace: [laneRun("2026-08-11T06:00:00.000Z", 1)],
} as never], [session], []);
const doneMarkup = renderToStaticMarkup(
  <ConversationFeed task={{ id: "t1", status: "done" } as never} items={doneItems} sessions={[session]} loading={false} error={null} />,
);
assert.match(doneMarkup, />第 1 轮验证通过</);
assert.doesNotMatch(doneMarkup, /class="verify-lane/, "收了口的一轮不再是整张卡");

console.log("review-presentation ok");

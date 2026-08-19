// 会话里的审查者身份：就地验证是搭在被验任务自己身上的旁路回合，常复用同一条会话，
// 同一个执行器自审时连名字都一样 —— 没有下面这三条，「在验我」和「在做需求」两种发言
// 在会话里完全分不开：
//   1) trace/直播的 run 事件带 verifyRound 时，这一回合归审查者，并报出第几轮
//   2) 自由派审的独立审查回合靠会话的 reviewer 身份认出来，没有轮次号
//   3) 换身份是 continuation 的断点 —— 否则验证回合会被当成「同一个人接着说」，
//      连头像和执行器名都不重报，比完全不区分更糟
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildConversationItems, conversationToMarkdown } from "../src/task-detail/conversationModel.ts";
import { isVerifyNote } from "../src/task-detail/conversationNotes.ts";
import { conversationFeedRows } from "../src/task-detail/conversationReviewLanes.ts";

// —— 旁注：验证段的起止跟着审查者一个颜色，别的通告不受影响 ——
assert.equal(isVerifyNote("第 2 轮验证开始：就在这个任务的工作目录里跑。"), true);
assert.equal(isVerifyNote("第 3 轮验证未通过，意见已发回会话；修复完成后自动复验。"), true);
assert.equal(isVerifyNote("验证打回失败：会话不可用"), true);
assert.equal(isVerifyNote("已预约完成后审查：5.5审查 · 逻辑检查 · 自动复审 1 轮。"), false);
assert.equal(isVerifyNote("验收阶段更新：验收完成（accepted）"), false);

const session = {
  id: "s1",
  taskId: "t1",
  agentType: "codex",
  executor: "codex@cpa",
  role: "single",
  startedAt: "2026-08-10T03:23:00.000Z",
  endedAt: "2026-08-10T14:04:00.000Z",
  model: "gpt-5.6-sol",
  reasoningEffort: "xhigh",
};
// 回合哨兵行:落盘格式是 \x1e + 一行 JSON(见 shared 的 parseSessionOutput)。
const turn = (kind, text, at) => `\x1e${JSON.stringify({ t: kind, text, at })}`;
const run = (turnStartedAt, verifyRound) => ({
  at: turnStartedAt,
  turnStartedAt,
  event: {
    kind: "run",
    model: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
    ...(verifyRound ? { verifyRound } : {}),
  },
});

// 最难分的那种：一条会话、一个执行器，实现回合和验证回合中间只隔着一行旁注。
const output = [
  "实现回合说的话。",
  turn("system", "第 2 轮验证开始：就在这个任务的工作目录里跑。", "2026-08-10T03:40:00.000Z"),
  "验证回合说的话。",
  turn("system", "第 2 轮验证未通过，意见已发回会话；修复完成后自动复验。", "2026-08-10T04:10:00.000Z"),
  "修复回合说的话。",
].join("\n");

const trace = [
  run("2026-08-10T03:23:00.000Z"),
  run("2026-08-10T03:40:00.000Z", 2),
  run("2026-08-10T04:10:00.000Z"),
];

const items = buildConversationItems([{ session, output, trace }], [session], []);
assert.deepEqual(items.map((item) => item.kind), ["agent", "event", "agent", "event", "agent"]);

const [impl, startNote, verify, failNote, fix] = items;
assert.equal(impl.reviewer, undefined, "普通执行回合不该被标成审查者");
assert.deepEqual(verify.reviewer, { round: 2 }, "带 verifyRound 的回合是审查者，并报出第几轮");
assert.equal(fix.reviewer, undefined, "打回之后的修复回合又回到实现者身份");
assert.equal(startNote.verify, true, "验证段的起止旁注跟审查者同一套颜色");
assert.equal(failNote.verify, true);
assert.equal(failNote.tone, "error", "没通过仍要报红：结论的成败比「它属于验证段」更要紧");

// 换身份是断点：验证回合和它后面的修复回合都要重新报头像和执行器名，
// 否则读者只会看见「同一个人一口气说了三段」。
assert.equal(impl.continuation, false);
assert.equal(verify.continuation, false, "验证回合必须重新报身份，哪怕跟上一段同会话同执行器");
assert.equal(fix.continuation, false, "验证结束回到实现者，同样要重新报身份");
assert.equal(impl.sessionId, verify.sessionId, "这三段本来就跑在同一条会话上");

// —— D 折叠卡：就地验证的起止旁注和正文必须成为同一行结构，自由派审不进来 ——
const firstLane = conversationFeedRows(items).find((row) => row.kind === "review-lane");
assert.ok(firstLane, "第 2 轮就地验证应整理成验证卡");
assert.equal(firstLane.round, 2);
assert.deepEqual(firstLane.items.map((item) => item.id), [startNote.id, verify.id, failNote.id]);
assert.equal(firstLane.conclusion, "verify_failed");
assert.equal(firstLane.complete, true);
assert.equal(firstLane.reportAvailable, true, "跑完且审查者确实说过话，才有可看的 report.md");
assert.equal(firstLane.defaultCollapsed, false, "唯一一轮仍是最新轮，默认展开");

const twoRoundItems = buildConversationItems([{
  session,
  output: [
    "实现。",
    turn("system", "第 1 轮验证开始：就在这个任务的工作目录里跑。", "2026-08-10T03:30:00.000Z"),
    "第一轮审查。",
    turn("system", "第 1 轮验证未通过。", "2026-08-10T03:40:00.000Z"),
    "修复。",
    turn("system", "第 2 轮验证开始：就在这个任务的工作目录里跑。", "2026-08-10T04:00:00.000Z"),
    "第二轮审查仍在跑。",
  ].join("\n"),
  trace: [
    run("2026-08-10T03:23:00.000Z"),
    run("2026-08-10T03:30:00.000Z", 1),
    run("2026-08-10T03:40:00.000Z"),
    run("2026-08-10T04:00:00.000Z", 2),
  ],
}], [session], []);
const twoLanes = conversationFeedRows(twoRoundItems).filter((row) => row.kind === "review-lane");
assert.equal(twoLanes.length, 2);
assert.equal(twoLanes[0].defaultCollapsed, true, "有结论且后面已有新一轮的历史卡默认折叠");
assert.equal(twoLanes[1].defaultCollapsed, false, "正在跑的最新轮必须默认展开");
assert.equal(twoLanes[1].complete, false);
assert.equal(twoLanes[1].reportAvailable, false, "进行中的报告尚未必写完，不给死入口");

const abandonedItems = buildConversationItems([{
  session,
  output: [
    turn("system", "第 1 轮验证开始：就在这个任务的工作目录里跑。", "2026-08-10T03:30:00.000Z"),
    "第一轮审查中途停止。",
    turn("system", "第 2 轮验证开始：就在这个任务的工作目录里跑。", "2026-08-10T04:00:00.000Z"),
    "第二轮审查仍在跑。",
  ].join("\n"),
  trace: [run("2026-08-10T03:30:00.000Z", 1), run("2026-08-10T04:00:00.000Z", 2)],
}], [session], []);
const abandonedLanes = conversationFeedRows(abandonedItems).filter((row) => row.kind === "review-lane");
assert.equal(abandonedLanes[0].conclusion, "inconclusive", "被下一轮顶掉的旧轮不能继续显示进行中");
assert.equal(abandonedLanes[0].complete, true);
assert.equal(abandonedLanes[0].defaultCollapsed, true, "无结论旧轮同样是历史卡，应默认折叠");
assert.equal(abandonedLanes[1].conclusion, null);
assert.equal(abandonedLanes[1].defaultCollapsed, false);

// —— 自由派审的独立审查回合：身份写在会话的 role 上，没有轮次号 ——
const reviewSession = { ...session, id: "s2", role: "reviewer", startedAt: "2026-08-10T15:00:00.000Z" };
const reviewed = buildConversationItems(
  [{ session: reviewSession, output: "审查意见。", trace: [] }],
  [reviewSession],
  [],
);
assert.deepEqual(reviewed.at(-1).reviewer, { round: null }, "reviewer 会话是审查者，但没有验证轮次");
assert.equal(
  conversationFeedRows(reviewed).some((row) => row.kind === "review-lane"),
  false,
  "卡的边界只由起止旁注给：光有一条审查者会话，圈不出一轮的范围",
);

// —— 直播路径：SSE 的 agent.event 自带 verifyRound，跟落盘那份读出来必须一致 ——
const live = buildConversationItems([], [session], [
  {
    kind: "server",
    id: "live:text",
    event: {
      type: "agent.event",
      taskId: "t1",
      sessionId: "s1",
      role: "single",
      agentType: "codex",
      verifyRound: 3,
      event: { kind: "text", text: "验证中。" },
    },
  },
]);
assert.deepEqual(live.at(-1).reviewer, { round: 3 }, "直播态也要认出审查者身份");

// —— 换身份必须切气泡：同一条会话上，实现正文和审查正文不能被合成一条 ——
// 用户在验证回合中途打开任务页就是这个形状:「第 N 轮验证开始」在订阅之前就播完了,
// 手上只有落盘的上一段实现正文 + 本轮验证的后半段事件。合进去的话,正在进行的审查
// 既没有盾形头像也没有徽标,正文还挂在实现者名下 —— 正是本需求要解决的那种混淆。
const liveEvent = (verifyRound, text) => ({
  kind: "server",
  id: `live:${text}`,
  event: {
    type: "agent.event",
    taskId: "t1",
    sessionId: "s1",
    role: "single",
    agentType: "codex",
    ...(verifyRound ? { verifyRound } : {}),
    event: { kind: "text", text },
  },
});

const mixed = buildConversationItems(
  [{ session, output: "上一轮实现正文", trace: [run("2026-08-10T03:23:00.000Z")] }],
  [session],
  [liveEvent(2, "当前审查正文")],
);
assert.deepEqual(mixed.map((item) => item.markdown), ["上一轮实现正文", "当前审查正文"]);
assert.deepEqual(mixed.at(-1).reviewer, { round: 2 }, "落盘尾气泡之后来的审查事件要另起一条");
assert.equal(mixed.at(-1).continuation, false);

const liveOnly = buildConversationItems([], [session], [liveEvent(1, "审查输出"), liveEvent(null, "普通输出")]);
assert.deepEqual(liveOnly.map((item) => item.markdown), ["审查输出", "普通输出"]);
assert.deepEqual(liveOnly[0].reviewer, { round: 1 });
assert.equal(liveOnly[1].reviewer, undefined, "验证轮结束后回到实现者，不能续在审查气泡里");

// —— 自由派审的直播:reviewer 会话要等下一次拉取才进 sessions,身份得认 SSE 自带的 role ——
// 通用 textParser 那类执行器从不发 session 事件,只认 sessions 快照的话整轮都没有徽标。
const liveReviewer = buildConversationItems([], [], [
  {
    kind: "server",
    id: "live:reviewer",
    event: {
      type: "agent.event",
      taskId: "t1",
      sessionId: "s9",
      role: "reviewer",
      agentType: "claude",
      event: { kind: "text", text: "审查意见。" },
    },
  },
]);
assert.deepEqual(liveReviewer.at(-1).reviewer, { round: null }, "sessions 还没跟上时也要认出审查者");

// —— 自由派审:轮次号只写在时间线旁注里,从不进 run 事件,只能按区间补 ——
const freeSession = { ...session, id: "s3", role: "reviewer", startedAt: "2026-08-11T02:00:00.000Z" };
const freeNotes = [
  "自由工作流第 1 轮审查开始：5.5审查 · 逻辑检查。",
  "自由工作流第 1 轮审查未通过，意见已发回会话；修复确认完成后自动复审。",
];
assert.equal(isVerifyNote(freeNotes[0]), true, "自由派审的起止旁注同样跟审查者一个颜色");
assert.equal(isVerifyNote(freeNotes[1]), true);
assert.equal(isVerifyNote("已按自由工作流第 2 轮审查意见发起修复。"), true);

const freeItems = buildConversationItems(
  [
    {
      session: { ...session, endedAt: null },
      output: [
        "实现回合说的话。",
        turn("system", freeNotes[0], "2026-08-11T02:00:00.000Z"),
      ].join("\n"),
      trace: [],
    },
    { session: freeSession, output: "审查意见正文。", trace: [] },
  ],
  [{ ...session, endedAt: null }, freeSession],
  [],
);
assert.deepEqual(freeItems.at(-1).reviewer, { round: 1 }, "自由派审也要报出第几轮");
assert.equal(freeItems[0].reviewer, undefined, "区间前的实现回合不受影响");

// 自由派审的区间只补轮次、不改身份:它另开一条会话,主任务的发言也可能落在同一段时间里。
const freeMain = buildConversationItems(
  [
    {
      session: { ...session, endedAt: null },
      output: [
        turn("system", freeNotes[0], "2026-08-11T02:00:00.000Z"),
        "主任务在审查期间说的话。",
      ].join("\n"),
      trace: [],
    },
  ],
  [{ ...session, endedAt: null }],
  [],
);
assert.equal(freeMain.at(-1).reviewer, undefined, "自由派审区间不能把主任务的发言变成审查者");

// —— D 折叠卡：自由派审同样折成结论卡，但报告 URL 要靠 reviews 反查 runId ——
// 报告落在 data/runs/<task>/free-review/<runId>/round-<N>/，而旁注里从头到尾只有轮号。
const freeReviewer = { ...freeSession, startedAt: "2026-08-11T02:10:00.000Z" };
const buildFreeLane = (notes, extra = []) => buildConversationItems(
  [
    {
      session: { ...session, endedAt: null },
      output: notes.join("\n"),
      trace: [],
    },
    ...extra,
  ],
  [{ ...session, endedAt: null }, freeReviewer],
  [],
);
const freeLaneItems = buildFreeLane(
  [
    turn("system", freeNotes[0], "2026-08-11T02:00:00.000Z"),
    turn("system", freeNotes[1], "2026-08-11T02:40:00.000Z"),
  ],
  [{ session: freeReviewer, output: "审查意见正文。", trace: [] }],
);
const freeReviews = [{
  id: "fr1",
  reviewerName: "5.5审查",
  model: "claude-sonnet-5",
  target: { kind: "workspace" },
  rounds: [{ round: 1, startedAt: "2026-08-11T02:00:00.000Z", reportMarkdown: "# 审查报告" }],
}];
const freeLane = conversationFeedRows(freeLaneItems, { reviews: freeReviews })
  .find((row) => row.kind === "review-lane");
assert.ok(freeLane, "自由派审的一轮同样要折成结论卡");
assert.equal(freeLane.source, "free");
assert.equal(freeLane.round, 1);
assert.equal(freeLane.title, "第 1 轮审查", "标题不能沿用就地验证的「第 N 轮验证」");
assert.equal(freeLane.conclusion, "verify_failed");
assert.equal(freeLane.complete, true);
assert.deepEqual(freeLane.report, { kind: "free", runId: "fr1", round: 1 });
assert.equal(freeLane.reportAvailable, true);
assert.deepEqual(
  freeLane.items.map((item) => item.kind),
  ["event", "agent", "event"],
  "起旁注、审查正文、收尾旁注是同一张卡",
);

const freeLaneNoState = conversationFeedRows(freeLaneItems).find((row) => row.kind === "review-lane");
assert.equal(freeLaneNoState.report, null);
assert.equal(
  freeLaneNoState.reportAvailable,
  false,
  "拿不到 reviews 就没有 runId，宁可不给入口也不能拼一个打不开的 URL",
);

// 还没落盘报告的那一轮（正在跑 / 异常收场）不给死入口，但审查者名字可以先补上。
const freeLaneRunning = conversationFeedRows(freeLaneItems, {
  reviews: [{ ...freeReviews[0], rounds: [{ round: 1, startedAt: "2026-08-11T02:00:00.000Z", reportMarkdown: "" }] }],
}).find((row) => row.kind === "review-lane");
assert.equal(freeLaneRunning.reportAvailable, false);
assert.equal(freeLaneRunning.reviewerLabel, "codex@cpa", "会话里有气泡就用气泡上的执行器名");

// 主任务在审查期间的发言绝不能折进审查卡 —— 折进去就跟着默认收起，等于凭空消失。
const freeWithMain = buildFreeLane([
  turn("system", freeNotes[0], "2026-08-11T02:00:00.000Z"),
  "主任务在审查期间说的话。",
]);
const freeMainLane = conversationFeedRows(freeWithMain, { reviews: freeReviews })
  .find((row) => row.kind === "review-lane");
assert.equal(
  freeMainLane.items.some((item) => item.kind === "agent"),
  false,
  "自由派审另开会话，主任务的发言只是恰好同时发生，不属于这一轮",
);

// 复审次数用完时服务端只写不带轮号的收尾，认不出来的话最后一轮永远收不了口。
const freeTail = conversationFeedRows(buildFreeLane([
  turn("system", "自由工作流第 2 轮审查开始：5.5审查 · 逻辑检查。", "2026-08-11T05:00:00.000Z"),
  turn("system", "自由工作流审查仍未通过，自动复审次数已用完；现在由你决定验收通过、按意见修复或再开一轮审查。", "2026-08-11T05:40:00.000Z"),
  turn("system", "已合并到 feat/example。", "2026-08-11T06:00:00.000Z"),
])).find((row) => row.kind === "review-lane");
assert.equal(freeTail.conclusion, "verify_failed");
assert.equal(freeTail.complete, true);
assert.equal(
  freeTail.items.some((item) => item.kind === "event" && item.text.includes("已合并")),
  false,
  "不带轮号的收尾同样要收口，否则后续生命周期旁注全被吞进卡里",
);

// 「重跑上一回合」开的是同一轮的新回合：判成收口的话，重跑后的审查发言会整段掉出区间。
const rerunNote = "自由工作流第 3 轮审查重跑上一回合：5.5审查。";
assert.equal(isVerifyNote(rerunNote), true);
const rerunLanes = conversationFeedRows(buildFreeLane([
  turn("system", "自由工作流第 3 轮审查开始：5.5审查 · 逻辑检查。", "2026-08-11T07:00:00.000Z"),
  turn("system", "自由工作流第 3 轮审查启动失败：执行器起不来", "2026-08-11T07:01:00.000Z"),
  turn("system", rerunNote, "2026-08-11T07:10:00.000Z"),
  turn("system", "自由工作流第 3 轮审查通过（5.5审查）。", "2026-08-11T07:40:00.000Z"),
]), { reviews: [{ ...freeReviews[0], id: "fr3", rounds: [
  { round: 3, startedAt: "2026-08-11T07:00:00.000Z", reportMarkdown: "# 重跑报告" },
] }] }).filter((row) => row.kind === "review-lane");
assert.equal(rerunLanes.length, 2, "启动失败自成一张卡，重跑另起一张，不会互相顶掉");
assert.equal(rerunLanes[0].conclusion, "inconclusive", "启动失败收的是一个根本没跑起来的区间");
assert.equal(rerunLanes[1].conclusion, "verified");
assert.equal(rerunLanes[1].title, "第 3 轮审查");
assert.equal(rerunLanes[0].report, null, "失败旧卡不能占用后来重跑生成的报告");
assert.deepEqual(rerunLanes[1].report, { kind: "free", runId: "fr3", round: 3 });

// 多轮 + 重开的审查里轮号会重复，runId 只能按起始时间一一配对，配过的不复用。
const twoRunReviews = [
  { id: "fr1", reviewerName: "A", model: null, target: { kind: "workspace" }, rounds: [
    { round: 1, startedAt: "2026-08-11T02:00:00.000Z", reportMarkdown: "一" },
    { round: 2, startedAt: "2026-08-11T03:00:00.000Z", reportMarkdown: "二" },
  ] },
  { id: "fr2", reviewerName: "B", model: null, target: { kind: "workspace" }, rounds: [
    { round: 1, startedAt: "2026-08-11T04:00:00.000Z", reportMarkdown: "三" },
  ] },
];
const multiLanes = conversationFeedRows(buildFreeLane([
  turn("system", "自由工作流第 1 轮审查开始：A · 逻辑检查。", "2026-08-11T02:00:00.000Z"),
  turn("system", "自由工作流第 1 轮审查未通过，意见已发回会话；修复确认完成后自动复审。", "2026-08-11T02:40:00.000Z"),
  turn("system", "自由工作流第 2 轮审查开始：A · 逻辑检查。", "2026-08-11T03:00:00.000Z"),
  turn("system", "自由工作流第 2 轮审查通过（A）。", "2026-08-11T03:40:00.000Z"),
  turn("system", "自由工作流第 1 轮审查开始：B · 语法检查。", "2026-08-11T04:00:00.000Z"),
  turn("system", "自由工作流第 1 轮审查通过（B）。", "2026-08-11T04:40:00.000Z"),
]), { reviews: twoRunReviews }).filter((row) => row.kind === "review-lane");
assert.deepEqual(
  multiLanes.map((lane) => lane.report),
  [
    { kind: "free", runId: "fr1", round: 1 },
    { kind: "free", runId: "fr1", round: 2 },
    { kind: "free", runId: "fr2", round: 1 },
  ],
  "重开的审查从 1 轮重新数，配错的话点开是上一次审查的报告",
);
assert.deepEqual(multiLanes.map((lane) => lane.conclusion), ["verify_failed", "verified", "verified"]);
assert.deepEqual(
  multiLanes.map((lane) => lane.defaultCollapsed),
  [true, true, false],
  "只有最新一张展开",
);

// —— 合并结果审查：跑在验收后的只读快照上，一次就是一次，没有轮号 ——
assert.equal(isVerifyNote("合并结果审查开始：5.5审查 · feat/x@abc12345 · 逻辑检查。"), true);
assert.equal(isVerifyNote("合并结果审查通过（5.5审查）；原任务继续保持已验收。"), true);
assert.equal(
  isVerifyNote("合并结果审查临时工作区清理失败：目录被占用"),
  false,
  "同前缀的杂音不能被当成一轮的起止，否则审查段会被切碎",
);
assert.equal(isVerifyNote("已从合并结果审查创建独立修复任务：t2"), false);

const mergeLanes = conversationFeedRows(buildFreeLane([
  turn("system", "合并结果审查开始：5.5审查 · feat/x@abc12345 · 逻辑检查。", "2026-08-14T01:00:00.000Z"),
  turn("system", "合并结果审查启动失败：执行器起不来", "2026-08-14T01:01:00.000Z"),
  turn("system", "合并结果审查重跑上一回合：5.5审查。", "2026-08-14T01:10:00.000Z"),
  turn("system", "合并结果审查通过（5.5审查）；原任务继续保持已验收。", "2026-08-14T01:30:00.000Z"),
  turn("system", "合并结果审查临时工作区清理失败：目录被占用", "2026-08-14T01:31:00.000Z"),
]), {
  reviews: [
    ...freeReviews,
    { id: "fr9", reviewerName: "5.5审查", model: "claude-sonnet-5", startedAt: "2026-08-14T01:00:00.000Z",
      target: { kind: "accepted_merge", branch: "feat/x", baseCommit: "a", mergeCommit: "b", repairTaskId: null },
      rounds: [{ round: 1, startedAt: "2026-08-14T01:00:00.000Z", reportMarkdown: "# 合并后复核" }] },
  ],
}).filter((row) => row.kind === "review-lane" && row.source === "merge");
assert.equal(mergeLanes.length, 2);
assert.equal(mergeLanes[0].report, null, "合并审查的失败旧卡同样不能抢报告");
const mergeLane = mergeLanes[1];
assert.ok(mergeLane, "合并结果审查也要折成结论卡");
assert.equal(mergeLane.round, null, "它跑在验收后的只读快照上，没有轮号");
assert.equal(mergeLane.title, "合并结果审查");
assert.equal(mergeLane.conclusion, "verified");
assert.deepEqual(mergeLane.report, { kind: "free", runId: "fr9", round: 1 },
  "target 是 accepted_merge 的那条 run 才是它的报告，不能配到工作区审查上");
assert.equal(mergeLane.reviewerLabel, "5.5审查", "审查者会话还没落盘时，名字从 run 上补");
assert.equal(
  mergeLane.items.some((item) => item.kind === "event" && item.text.includes("清理失败")),
  false,
  "收尾之后的杂音留在卡外",
);

// —— 存量会话:trace 里一个 run marker 都没有(这次改动才开始写),身份只能按区间推 ——
// 用的是真实历史会话 data/runs/eFjv9houajxX/lFGPlOrSnqt-.md 的原样拷贝,它那条 trace
// 实测 34 行、0 个 run 事件。
const legacySession = {
  ...session,
  id: "legacy",
  startedAt: "2026-08-05T14:21:48.822Z",
  endedAt: "2026-08-06T04:05:45.485Z",
};
const legacy = buildConversationItems(
  [{
    session: legacySession,
    output: readFileSync(new URL("./fixtures/legacy-verify-session.md", import.meta.url), "utf8"),
    trace: [],
  }],
  [legacySession],
  [],
);
const legacyStart = legacy.findIndex((item) => item.kind === "event" && item.text.startsWith("第 2 轮验证开始"));
assert.ok(legacyStart > 0, "真实历史会话里就有这条「第 2 轮验证开始」");
const legacyAgents = legacy.slice(legacyStart).filter((item) => item.kind === "agent");
assert.ok(legacyAgents.length >= 2, "区间里有两段审查正文");
for (const agent of legacyAgents) {
  assert.deepEqual(agent.reviewer, { round: 2 }, "存量会话的验证正文也要认出审查者和轮次");
}
assert.equal(legacyAgents[0].continuation, false, "换身份要重新报头像和执行器名");
// 区间外的实现正文不能被顺手染成审查者。
for (const item of legacy.slice(0, legacyStart)) {
  if (item.kind === "agent") assert.equal(item.reviewer, undefined);
}
const legacyLane = conversationFeedRows(legacy).find((row) => row.kind === "review-lane" && row.round === 2);
assert.ok(legacyLane);
assert.equal(legacyLane.conclusion, "verified");
assert.equal(
  legacyLane.items.some((item) => item.kind === "event" && /合并完成|验收完成|开始验收/.test(item.text)),
  false,
  "历史通过轮不能把后续合并 / 验收生命周期吞进 D 卡",
);

// 通过的那条路收尾时不写「第 N 轮验证…」旁注(concludeRound 直接往下推线),而
// 「验收阶段更新：已验证」是审查者自己在回合中间调 report_stage 写的、还在它的回合里。
// 收口只能认「回合真的换了人」：审查者说完话之后的那条新回合标记。
const passed = buildConversationItems(
  [{
    session: { ...session, endedAt: null },
    output: [
      turn("system", "第 4 轮验证开始：就在这个任务的工作目录里跑。", "2026-08-12T01:00:00.000Z"),
      "验证正文。",
      turn("system", "验收阶段更新：已验证（verified）", "2026-08-12T01:20:00.000Z"),
      "第 4 轮验证通过。",
      turn("system", "〔系统〕继续（从中断处）", "2026-08-12T02:00:00.000Z"),
      "后续实现正文。",
    ].join("\n"),
    trace: [],
  }],
  [{ ...session, endedAt: null }],
  [],
);
const passedAgents = passed.filter((item) => item.kind === "agent");
assert.deepEqual(passedAgents[0].reviewer, { round: 4 });
assert.deepEqual(passedAgents[1].reviewer, { round: 4 }, "阶段通告是审查者自己回合里写的，不能拿它收口");
assert.equal(passedAgents[2].reviewer, undefined, "换回合之后的发言回到实现者");
const passedLane = conversationFeedRows(passed).find((row) => row.kind === "review-lane");
assert.ok(passedLane);
assert.equal(passedLane.conclusion, "verified", "通过路径没有收尾旁注，要从 verified 阶段通告得出结论");
assert.equal(passedLane.complete, true);
assert.equal(
  passedLane.items.some((item) => item.kind === "event" && item.text.includes("继续（从中断处）")),
  false,
  "验证通过后的实现续跑标记应留在卡片外",
);
assert.equal(
  passedLane.items.some((item) => item.kind === "agent" && item.reviewer === undefined),
  false,
  "后续实现正文不能被收进已通过的验证卡",
);

// 生产通过路径不会写「继续（从中断处）」或「第 N 轮验证通过」，而是阶段通告后直接
// 推进工作流，依次写验收 / 合并旁注。D 卡必须在第一条生命周期旁注前收口。
const productionPassed = buildConversationItems([{
  session,
  output: [
    turn("system", "第 5 轮验证开始：就在这个任务的工作目录里跑。", "2026-08-12T03:00:00.000Z"),
    "验证正文。",
    turn("system", "验收阶段更新：已验证（verified）", "2026-08-12T03:20:00.000Z"),
    "第 5 轮验证结论：通过。",
    turn("system", "这条线上没写等我点头，开始验收。", "2026-08-12T03:20:15.000Z"),
    turn("system", "已合并到 feat/example。", "2026-08-12T03:20:16.000Z"),
    turn("system", "验收完成：目标分支 feat/example；任务 status 保持 done。", "2026-08-12T03:20:17.000Z"),
  ].join("\n"),
  trace: [run("2026-08-12T03:00:00.000Z", 5)],
}], [session], []);
const productionLane = conversationFeedRows(productionPassed).find((row) => row.kind === "review-lane");
assert.ok(productionLane);
assert.equal(productionLane.conclusion, "verified");
assert.equal(productionLane.items.at(-1).kind, "agent", "审查者最终结论留在卡内");
assert.equal(
  productionLane.items.some((item) => item.kind === "event" && /开始验收|已合并|验收完成/.test(item.text)),
  false,
  "生产通过路径的生命周期旁注必须留在卡外",
);

const forcedPass = buildConversationItems([{
  session,
  output: [
    turn("system", "第 6 轮验证开始：就在这个任务的工作目录里跑。", "2026-08-12T04:00:00.000Z"),
    "验证没有给出结论。",
    turn("system", "第 6 轮验证没有给出结论就停了，人工强制通过时一并收尾。", "2026-08-12T04:20:00.000Z"),
  ].join("\n"),
  trace: [run("2026-08-12T04:00:00.000Z", 6)],
}], [session], []);
const forcedLane = conversationFeedRows(forcedPass).find((row) => row.kind === "review-lane");
assert.ok(forcedLane);
assert.equal(forcedLane.conclusion, "inconclusive", "人工强制通过不是验证器给出的通过结论");

// 通过的那一轮之后另起一条会话:inline 验证是搭在被验任务自己会话上的旁路回合,
// 时间线一旦走到别的 sessionId,说话的就不可能还是这一轮的审查者。少了这一条,
// 「通过」路径上没有收尾旁注,区间会一路开着,把次日新会话的普通执行正文也染成审查者。
const freshSession = { ...session, id: "s-fresh", startedAt: "2026-08-13T01:00:00.000Z", endedAt: null };
const acrossSessions = buildConversationItems(
  [
    {
      session: { ...session, endedAt: "2026-08-12T02:00:00.000Z" },
      output: [
        turn("system", "第 2 轮验证开始：就在这个任务的工作目录里跑。", "2026-08-12T01:00:00.000Z"),
        "验证正文。",
        turn("system", "验收阶段更新：已验证（verified）", "2026-08-12T01:20:00.000Z"),
        "第 2 轮验证通过。",
      ].join("\n"),
      trace: [],
    },
    { session: freshSession, output: "次日新会话的普通执行正文。", trace: [] },
  ],
  [{ ...session, endedAt: "2026-08-12T02:00:00.000Z" }, freshSession],
  [],
);
const acrossAgents = acrossSessions.filter((item) => item.kind === "agent");
assert.deepEqual(acrossAgents[0].reviewer, { round: 2 });
assert.deepEqual(acrossAgents[1].reviewer, { round: 2 }, "结论仍在审查者自己的回合里");
assert.equal(acrossAgents.at(-1).reviewer, undefined, "换了会话就不可能还是上一轮的审查者");
assert.equal(acrossAgents.at(-1).continuation, false);

// —— 一轮审查不是一个回合:提问等答复、checkpoint 等续跑,服务端都算在同一轮里 ——
// 收口要是认回合级信号(答复 / 回合结束 / 继续标记),用户答完问题后徽标就会从
// 「审查者 · 第 N 轮」退回「审查者」,存量 inline 甚至整个变回普通执行者。
const answered = buildConversationItems(
  [{
    session: { ...session, endedAt: null },
    output: [
      turn("system", "第 3 轮验证开始：就在这个任务的工作目录里跑。", "2026-08-12T03:00:00.000Z"),
      "验证前段：有个地方要确认。",
      turn("user", "【答复】你之前的提问:「…」\n\n直接通过就行。", "2026-08-12T03:30:00.000Z"),
      "验证后段：那就按你说的过。",
    ].join("\n"),
    trace: [],
  }],
  [{ ...session, endedAt: null }],
  [],
);
const answeredAgents = answered.filter((item) => item.kind === "agent");
assert.deepEqual(answeredAgents[0].reviewer, { round: 3 });
assert.deepEqual(answeredAgents[1].reviewer, { round: 3 }, "【答复】只是回答审查者的提问，还是同一轮");
// 真人另起话头才算接管。
const interjected = buildConversationItems(
  [{
    session: { ...session, endedAt: null },
    output: [
      turn("system", "第 3 轮验证开始：就在这个任务的工作目录里跑。", "2026-08-12T03:00:00.000Z"),
      "验证正文。",
      turn("user", "先别验了，改个别的。", "2026-08-12T03:30:00.000Z"),
      "好，改别的。",
    ].join("\n"),
    trace: [],
  }],
  [{ ...session, endedAt: null }],
  [],
);
assert.equal(interjected.filter((item) => item.kind === "agent").at(-1).reviewer, undefined);

// 自由派审的 checkpoint 续跑:reviewer 会话只有 role、没有轮次号,区间一关就补不回来了。
const resumedReview = buildConversationItems(
  [
    {
      session: { ...session, endedAt: null },
      output: turn("system", freeNotes[0], "2026-08-11T02:00:00.000Z"),
      trace: [],
    },
    {
      session: freeSession,
      output: [
        "审查前段。",
        turn("system", "〔系统〕继续（从中断处）", "2026-08-11T02:30:00.000Z"),
        "审查后段。",
      ].join("\n"),
      trace: [],
    },
  ],
  [{ ...session, endedAt: null }, freeSession],
  [],
);
const resumedAgents = resumedReview.filter((item) => item.kind === "agent");
assert.deepEqual(resumedAgents[0].reviewer, { round: 1 });
assert.deepEqual(resumedAgents[1].reviewer, { round: 1 }, "checkpoint 续跑回来还是同一轮审查");

// 同样的形状在真实历史会话里就有:data/runs/6xhkF69AgfIr/h03Yf-2Eezw_.md(原样拷贝,
// 只去掉行尾空白)——第 1 轮验证中途审查者提问、用户答复后接着验完,trace 实测 0 个
// run 事件,身份和轮次全靠这个区间。
const answerLegacySession = {
  ...session,
  id: "legacy-answer",
  startedAt: "2026-08-05T08:14:46.369Z",
  endedAt: "2026-08-08T06:52:40.113Z",
};
const answerLegacy = buildConversationItems(
  [{
    session: answerLegacySession,
    output: readFileSync(new URL("./fixtures/legacy-answer-verify-session.md", import.meta.url), "utf8"),
    trace: [],
  }],
  [answerLegacySession],
  [],
);
const answerStart = answerLegacy.findIndex((item) => item.kind === "event" && item.text.startsWith("第 1 轮验证开始"));
assert.ok(answerStart > 0, "真实历史会话里就有这条「第 1 轮验证开始」");
const answerAgents = answerLegacy.slice(answerStart).filter((item) => item.kind === "agent");
assert.ok(answerAgents.length >= 3, "答复前一段、答复后两段");
for (const agent of answerAgents) {
  assert.deepEqual(agent.reviewer, { round: 1 }, "同一轮审查里前后身份不能自相矛盾");
}


// —— 复制出去的会话同样要认得出审查者，否则界面上分得开、粘出去又混成一团 ——
const markdown = conversationToMarkdown(items, { title: "t", body: "" });
assert.match(markdown, /## codex@cpa（审查者 · 第 2 轮）/);
assert.match(markdown, /## codex@cpa · /, "实现回合的标题不带身份后缀");

console.log("reviewer-turn ok");

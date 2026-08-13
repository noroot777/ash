// 会话里的审查者身份：就地验证是搭在被验任务自己身上的旁路回合，常复用同一条会话，
// 同一个执行器自审时连名字都一样 —— 没有下面这三条，「在验我」和「在做需求」两种发言
// 在会话里完全分不开：
//   1) trace/直播的 run 事件带 verifyRound 时，这一回合归审查者，并报出第几轮
//   2) 自由派审的独立审查回合靠会话的 reviewer 身份认出来，没有轮次号
//   3) 换身份是 continuation 的断点 —— 否则验证回合会被当成「同一个人接着说」，
//      连头像和执行器名都不重报，比完全不区分更糟
import assert from "node:assert/strict";
import { buildConversationItems, conversationToMarkdown } from "../src/task-detail/conversationModel.ts";
import { isVerifyNote } from "../src/task-detail/conversationNotes.ts";

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

// —— 自由派审的独立审查回合：身份写在会话的 role 上，没有轮次号 ——
const reviewSession = { ...session, id: "s2", role: "reviewer", startedAt: "2026-08-10T15:00:00.000Z" };
const reviewed = buildConversationItems(
  [{ session: reviewSession, output: "审查意见。", trace: [] }],
  [reviewSession],
  [],
);
assert.deepEqual(reviewed.at(-1).reviewer, { round: null }, "reviewer 会话是审查者，但没有验证轮次");

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

// —— 复制出去的会话同样要认得出审查者，否则界面上分得开、粘出去又混成一团 ——
const markdown = conversationToMarkdown(items, { title: "t", body: "" });
assert.match(markdown, /## codex@cpa（审查者 · 第 2 轮）/);
assert.match(markdown, /## codex@cpa · /, "实现回合的标题不带身份后缀");

console.log("reviewer-turn ok");
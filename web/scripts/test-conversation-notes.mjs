// 会话流里的系统旁注：分类只管语气，结构由 continuation 决定。
//   1) 时间线通告一律是 note（不切段），只有回合边界才是 boundary（保留横线）
//   2) 旁注不打断同一会话的连续发言 —— 这正是「预约个审查就把会话劈成上下两段」的病根
//   3) 真人插话、回合边界、换会话，这三种才重新报身份
import assert from "node:assert/strict";
import { buildConversationItems } from "../src/task-detail/conversationModel.ts";
import { noteTone } from "../src/task-detail/conversationNotes.ts";

// —— 语气分类：办成了的事不报红，没办成的才报红 ——
assert.equal(noteTone("自由工作流第 2 轮审查通过（5.5审查）。"), "neutral");
assert.equal(noteTone("验收阶段更新：验收完成（accepted）"), "neutral");
assert.equal(noteTone("已预约完成后审查：5.5审查 · 逻辑检查 · 自动复审 1 轮。"), "neutral");
assert.equal(noteTone("自由工作流合并&清理完成：已安全合并 ash/x → main"), "neutral");
assert.equal(noteTone("第 3 轮验证开始：就在这个任务的工作目录里跑。"), "neutral");
assert.equal(noteTone("自由工作流第 1 轮审查未通过，意见已发回会话；修复完成后自动复审。"), "error");
assert.equal(noteTone("完成后审查启动失败：审查者不可用"), "error");
assert.equal(noteTone("已取消完成后审查预约。"), "error");
assert.equal(noteTone("合并清理警告：worktree 未能删除"), "error");

const session = {
  id: "s1",
  taskId: "t1",
  agentType: "codex",
  executor: "codex@cpa",
  role: "main",
  startedAt: "2026-08-10T03:23:00.000Z",
  endedAt: "2026-08-10T14:04:00.000Z",
  model: "gpt-5.6-sol",
  reasoningEffort: "xhigh",
};
const turn = (kind, text, at) => `${JSON.stringify({ t: kind, text, at })}`;

// 图二那一段：一轮说完话 → 预约了完成后审查 → 同一个会话接着说。
const output = [
  "第一回合说的话。",
  turn("system", "已预约完成后审查：5.5审查 · 逻辑检查 · 自动复审 1 轮。", "2026-08-10T03:27:00.000Z"),
  "第二回合说的话。",
].join("\n");

const items = buildConversationItems([{ session, output, trace: [] }], [session], []);
assert.deepEqual(items.map((item) => item.kind), ["agent", "event", "agent"]);

const [first, note, second] = items;
assert.equal(note.variant, "note", "时间线通告是旁注，不是回合边界");
assert.equal(note.tone, "neutral");
assert.equal(first.continuation, false, "会话第一段照常报身份");
assert.equal(second.continuation, true, "旁注隔开的下半截接着上一段排版，不重报头像和执行器名");
// 两截仍是各自独立的回合：用时和用量还挂在各自那条上，合并卡片会把这些抹平。
assert.equal(first.sessionId, second.sessionId);
assert.notEqual(first.id, second.id);

// —— 真人插话是真断点：后面那截要重新报身份 ——
const withReply = [
  "第一回合说的话。",
  turn("system", "验收阶段更新：验收完成（accepted）", "2026-08-10T03:27:00.000Z"),
  turn("user", "再改一处", "2026-08-10T03:28:00.000Z"),
  "第二回合说的话。",
].join("\n");
const replied = buildConversationItems([{ session, output: withReply, trace: [] }], [session], []);
assert.deepEqual(replied.map((item) => item.kind), ["agent", "event", "user", "agent"]);
assert.equal(replied.at(-1).continuation, false, "真人插话之后必须重新报身份");

// —— 回合边界事件（直播态的「本轮执行结束」）保留横线，并且打断续接 ——
const live = buildConversationItems([{ session, output: "第一回合说的话。", trace: [] }], [session], [
  {
    kind: "server",
    id: "live:done",
    event: { type: "agent.event", taskId: "t1", sessionId: "s1", role: "main", agentType: "codex", event: { kind: "done", exitStatus: 0 } },
  },
  {
    kind: "server",
    id: "live:text",
    event: { type: "agent.event", taskId: "t1", sessionId: "s1", role: "main", agentType: "codex", event: { kind: "text", text: "又被叫醒了。" } },
  },
]);
const boundary = live.find((item) => item.kind === "event");
assert.equal(boundary.variant, "boundary", "回合边界仍是整宽分隔线");
assert.equal(live.at(-1).continuation, false, "回合结束之后是新的一段，要重新报身份");

// —— 实时旁注跟落盘 sentinel 共用时间，且不能把当前回合的工具/统计拆到旁注后面 ——
const liveNoteAt = "2026-08-10T03:27:00.000Z";
const activeSession = {
  ...session,
  turnStartedAt: session.startedAt,
  endedAt: null,
  cliSessionId: "cli-s1",
};
const beforeNoteTrace = {
  at: "2026-08-10T03:24:00.000Z",
  turnStartedAt: session.startedAt,
  event: { kind: "text", text: "第一回合说的话。" },
};
const afterNoteTool = {
  at: "2026-08-10T03:28:00.000Z",
  turnStartedAt: session.startedAt,
  event: { kind: "tool", name: "exec", detail: "检查布局" },
};
const liveNote = buildConversationItems([{ session: activeSession, output: "第一回合说的话。", trace: [beforeNoteTrace] }], [activeSession], [
  {
    kind: "server",
    id: "live:note",
    event: { type: "agent.event", taskId: "t1", sessionId: "s1", role: "main", agentType: "codex", event: { kind: "system", text: "已预约完成后审查。", at: liveNoteAt } },
  },
  {
    kind: "server",
    id: "live:tool",
    event: { type: "agent.event", taskId: "t1", sessionId: "s1", role: "main", agentType: "codex", event: { kind: "tool", name: "exec", detail: "检查布局" } },
  },
]);
const persistedNote = buildConversationItems([{
  session: activeSession,
  output: ["第一回合说的话。", turn("system", "已预约完成后审查。", liveNoteAt)].join("\n"),
  trace: [beforeNoteTrace, afterNoteTool],
}], [activeSession], []);
const shape = (rows) => rows.map((item) => item.kind === "agent" ? {
  kind: item.kind,
  tools: item.segments.flatMap((segment) => segment.events.map((event) => event.label)),
  showSessionMeta: item.showSessionMeta,
  endedAt: item.endedAt,
} : { kind: item.kind, at: item.at });
assert.deepEqual(shape(liveNote), shape(persistedNote), "实时旁注前后的工具与统计条位置必须和刷新后同构");
assert.deepEqual(liveNote.map((item) => item.kind), ["agent", "event"]);
assert.equal(liveNote[0].showSessionMeta, true, "会话统计条应留在旁注之前的当前回合上");
assert.equal(liveNote[0].endedAt, null, "旁注不能把仍在运行的当前回合提前截断");
assert.equal(liveNote[1].at, liveNoteAt, "实时旁注应直接带落盘时的精确时间");

// —— 原生引导：同一个 turnStartedAt 横跨 user sentinel，刷新后仍须 agent → user → agent ——
const steerAt = "2026-08-10T03:30:00.000Z";
const steeredOutput = [
  "旧方向回复。",
  turn("user", "改按新方向", steerAt),
  "新方向回复。",
].join("\n");
const steeredTrace = [
  {
    at: "2026-08-10T03:24:00.000Z",
    turnStartedAt: session.startedAt,
    event: { kind: "tool", name: "exec", detail: "旧方向工具" },
  },
  {
    at: "2026-08-10T03:25:00.000Z",
    turnStartedAt: session.startedAt,
    event: { kind: "text", text: "旧方向回复。" },
  },
  {
    at: "2026-08-10T03:31:00.000Z",
    turnStartedAt: session.startedAt,
    event: { kind: "tool", name: "edit", detail: "新方向工具" },
  },
  {
    at: "2026-08-10T03:32:00.000Z",
    turnStartedAt: session.startedAt,
    event: { kind: "text", text: "新方向回复。" },
  },
];
const steered = buildConversationItems([{
  session: activeSession,
  output: steeredOutput,
  trace: steeredTrace,
}], [activeSession], []);
assert.deepEqual(steered.map((item) => item.kind), ["agent", "user", "agent"]);
assert.equal(steered.filter((item) => item.kind === "agent" && item.markdown.includes("新方向回复。")).length, 1,
  "引导后的回答只能出现一次");
assert.equal(steered.some((item) => item.id.startsWith("persisted:trace:")), false,
  "同回合引导后的执行 trace 不得掉进孤立兜底气泡");
assert.deepEqual(
  steered.filter((item) => item.kind === "agent").map((item) =>
    item.segments.flatMap((segment) => segment.events.map((event) => event.label))),
  [["exec"], ["edit"]],
  "用户消息前后的工具必须留在各自可见位置",
);

console.log("conversation-notes ok");

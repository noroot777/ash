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

console.log("conversation-notes ok");

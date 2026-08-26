// 会话流里的系统旁注：分类只管语气，结构由 continuation 决定。
//   1) 时间线通告一律是 note（不切段），只有回合边界才是 boundary（保留横线）
//   2) 旁注不打断同一会话的连续发言 —— 这正是「预约个审查就把会话劈成上下两段」的病根
//   3) 真人插话、回合边界、换会话，这三种才重新报身份
import assert from "node:assert/strict";
import {
  NEUTRAL_SESSION_NOTES,
  SESSION_DROP_PERSISTENCE_FAILED_NOTE,
  SESSION_LOST_NOTE,
  SESSION_POISONED_NOTE,
  normalizeSessionNoteText,
} from "@ash/shared/session-notes";
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

// —— 会话轮换旁注：中性事实，不是本回合失败 ——
// 这几句会出现在一个 exit 0 的成功回合、甚至用户自己点的「停止全组」上。判据不是「文案
// 里恰好没踩到关键词」（`SESSION_POISONED_NOTE` 讲的就是 Codex 报了问题），而是
// @ash/shared/session-notes 那份服务端也在用的同一源文本。
for (const note of NEUTRAL_SESSION_NOTES) {
  assert.equal(noteTone(note), "neutral", `会话轮换旁注被判成执行异常：${note.slice(0, 24)}…`);
  // 旁注是纯文本一行小字（ConversationFeed 的 <p>{item.text}</p>），Markdown 不会被解析：
  // 文案里写 `**全新会话**`，用户看到的就是两侧的星号。
  assert.doesNotMatch(note, /\*\*|`|^[-*] /m, `会话轮换旁注带了 Markdown 标记：${note.slice(0, 24)}…`);
}
// 「中性事实 + 真失败」拼起来的收尾句仍然要红 —— 摘掉中性部分再判，就是为了这个。
assert.equal(
  noteTone(`更正上面那条：CLI 会话接不回了。${SESSION_POISONED_NOTE}`),
  "neutral",
  "用户主动停止后的会话更正不该显示成执行异常",
);
assert.equal(
  noteTone("更正上面那条：CLI 会话接不回了。ash 已停止本次进程继续使用这条失效的 CLI 会话；但恢复字段写入数据库失败，下一次重新开台时可能再次尝试旧会话。"),
  "error",
  "拼在中性文案后面的真失败被一起洗白了",
);

// —— 升级前已经落盘的旧版文案：一字不改地照抄用户 .md 里的原文 ——
// 只改常量只对「以后写的数据」有效；用户抱怨的那条记录刷新后还在，必须一并归一。
const LEGACY_POISONED =
  "Codex 已在本轮 stderr 中报告这条 thread 的回合关联、world-state 或 rollout 落盘异常；"
  + "即使进程 exit 0 且发出 turn.completed，也不能再把它当作可恢复会话；"
  + "会话轮换不改变本回合真实的退出原因。"
  + "ash 已清掉这条会话的恢复字段：下一次运行会从任务正文自动开启一条**全新会话**，"
  + "旧对话与执行记录仍保留，但之前的上下文不会带过去。";
const LEGACY_LOST =
  "上一轮记下的 CLI 会话 id 在 CLI 那边已经不存在了（多半是第一次起跑就失败、"
  + "会话压根没建起来，也可能是 CLI 的会话记录被清过或换了机器/目录）。"
  + "ash 已经把这个失效的 id 清掉：再点一次运行会开一条**全新会话**，"
  + "之前的上下文不会带过来，任务正文和历史记录都还在。";
for (const legacy of [LEGACY_POISONED, LEGACY_LOST]) {
  assert.equal(noteTone(legacy), "neutral", "升级前落盘的轮换旁注刷新后仍是红的");
  assert.doesNotMatch(
    normalizeSessionNoteText(legacy),
    /\*\*/,
    "升级前落盘的轮换旁注刷新后仍把 Markdown 星号露给用户",
  );
}
assert.equal(
  normalizeSessionNoteText("前言。" + LEGACY_POISONED + "后话。"),
  "前言。" + SESSION_POISONED_NOTE + "后话。",
  "旧文案要就地换成当前文案，前后文原样保留",
);
assert.equal(normalizeSessionNoteText("跟轮换无关的一句话"), "跟轮换无关的一句话", "认不出来的文本必须原样返回");

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

// —— 会话轮换（Codex thread 被判 poisoned）是旁注，不是这一轮的失败 ——
// 服务端把 `scope:"session"` 转成持久 system 注记（server/src/session-notice.ts），
// 所以落盘路和直播路都得渲染成 note；一个 exit 0、正文完整的回合不许出现红色「异常」。
const rotationSession = { ...session, agentType: "codex", endedAt: null, turnStartedAt: session.startedAt };
const diagnosis = "Codex 会话诊断：session=poisoned_session";
const rotationNote = SESSION_POISONED_NOTE;
// 轮换说明自己带着「异常」二字(它在转述 Codex 报的 rollout 异常),不专门认出来就会被
// FAILED_HINTS 染红 —— 只断言 variant 会漏掉这一整层(自由工作流第 2 轮审查)。
assert.equal(noteTone(SESSION_POISONED_NOTE), "neutral", "poisoned 轮换说明不许被关键词染红");
assert.equal(noteTone(SESSION_LOST_NOTE), "neutral", "会话失效轮换说明不许被关键词染红");
assert.equal(noteTone(`更正上面那条:CLI 会话接不回了。${SESSION_POISONED_NOTE}`), "neutral", "收尾更正说的是同一件事");
// 这条不是轮换而是真出了问题:恢复字段没写进库,下一次可能再撞旧会话。该红就红。
assert.equal(noteTone(SESSION_DROP_PERSISTENCE_FAILED_NOTE), "error", "清理写库失败仍必须报红");
// 旁注三处渲染点(ConversationFeed、team/TeamFeed、duet 的 duet-turn-notice)都是纯文本,
// 措辞里带 `**` 用户就会看到字面量的星号(自由工作流第 1 轮审查)。哪天真上了受控的
// inline Markdown 渲染,记得三处一起上,再来改这条断言。
for (const [name, text] of Object.entries({ SESSION_LOST_NOTE, SESSION_POISONED_NOTE, SESSION_DROP_PERSISTENCE_FAILED_NOTE })) {
  assert.doesNotMatch(text, /\*\*|`|^#|\[.+\]\(/m, `${name} 是纯文本旁注，不能带 Markdown 标记`);
}
const rotationLive = buildConversationItems(
  [{ session: rotationSession, output: "这一轮正文已经完整产出。", trace: [] }],
  [rotationSession],
  [diagnosis, rotationNote].map((text, index) => ({
    kind: "server",
    id: `live:rotation:${index}`,
    event: {
      type: "agent.event", taskId: "t1", sessionId: "s1", role: "main", agentType: "codex",
      event: { kind: "system", text, at: `2026-08-10T03:2${5 + index}:00.000Z` },
    },
  })).concat([{
    kind: "server",
    id: "live:rotation:done",
    event: {
      type: "agent.event", taskId: "t1", sessionId: "s1", role: "main", agentType: "codex",
      event: { kind: "done", exitStatus: 0 },
    },
  }]),
);
const rotationAux = rotationLive.flatMap((item) => item.kind === "agent"
  ? item.segments.flatMap((segment) => segment.events.filter((e) => e.kind === "error"))
  : []);
assert.deepEqual(rotationAux, [], "会话轮换不该在气泡里留下红色「异常」");
const rotationNotes = rotationLive.filter((item) => item.kind === "event" && item.variant === "note");
assert.deepEqual(
  rotationNotes.map((item) => [item.tone, item.text]),
  [["neutral", diagnosis], ["neutral", rotationNote]],
  "轮换诊断与说明都渲染成中性旁注（只判 variant 会漏掉颜色）",
);
assert.equal(rotationLive.at(-1).text, "本轮执行结束", "exit 0 仍是正常收尾");

// 落盘后同构：.md 里的 system 回合行走 persisted 那条路，措辞与结构必须一致。
const rotationPersisted = buildConversationItems([{
  session: rotationSession,
  output: [
    "这一轮正文已经完整产出。",
    turn("system", diagnosis, "2026-08-10T03:25:00.000Z"),
    turn("system", rotationNote, "2026-08-10T03:26:00.000Z"),
  ].join("\n"),
  trace: [],
}], [rotationSession], []);
assert.deepEqual(
  rotationPersisted.filter((item) => item.kind === "event").map((item) => [item.variant, item.tone, item.text]),
  [["note", "neutral", diagnosis], ["note", "neutral", rotationNote]],
  "刷新之后轮换说明仍是中性旁注",
);

// 团队「停止全组」的收尾更正：轮换不该在这条路上又变回红色（第 2 轮审查 P1 第二层）。
const haltCorrection = `更正上面那条:CLI 会话接不回了。${SESSION_POISONED_NOTE}`;
const halted = buildConversationItems([{
  session: rotationSession,
  output: [
    "这一轮正文已经完整产出。",
    turn("system", "〔系统〕你按了「停止全组」:调度台进程与所有在跑的执行者都已停止,执行者可从中断处恢复。调度者这条 CLI 会话已经作废,再说一句话会开一条全新会话(之前的上下文不带过去)。", "2026-08-10T03:27:00.000Z"),
    turn("system", haltCorrection, "2026-08-10T03:28:00.000Z"),
  ].join("\n"),
  trace: [],
}], [rotationSession], []);
assert.deepEqual(
  halted.filter((item) => item.kind === "event").map((item) => [item.variant, item.tone]),
  [["note", "neutral"], ["note", "neutral"]],
  "停止全组之后的轮换说明不许报红",
);
assert.deepEqual(
  halted.flatMap((item) => item.kind === "agent"
    ? item.segments.flatMap((segment) => segment.events.filter((e) => e.kind === "error"))
    : []),
  [],
  "停止全组不该给健康回合挂上「执行过程 · 1 异常」",
);

// 兜底：万一还有哪条直播路径漏转，模型自己也不许把 session-scope error 渲染成异常。
const rawScoped = buildConversationItems(
  [{ session: rotationSession, output: "这一轮正文已经完整产出。", trace: [] }],
  [rotationSession],
  [{
    kind: "server",
    id: "live:scoped-error",
    event: {
      type: "agent.event", taskId: "t1", sessionId: "s1", role: "main", agentType: "codex",
      event: { kind: "error", message: diagnosis, scope: "session" },
    },
  }],
);
assert.deepEqual(
  rawScoped.flatMap((item) => item.kind === "agent"
    ? item.segments.flatMap((segment) => segment.events.filter((e) => e.kind === "error"))
    : []),
  [],
  "带 scope:\"session\" 的 error 不能落进气泡的异常折叠块",
);
assert.equal(rawScoped.find((item) => item.kind === "event")?.variant, "note");
assert.equal(rawScoped.find((item) => item.kind === "event")?.tone, "neutral");

console.log("conversation-notes ok");

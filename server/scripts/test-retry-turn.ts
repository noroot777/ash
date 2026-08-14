// 「重跑上一回合」认输入的判据（纯函数，不碰 DB 也不摸盘）。
// 认错了界面上看不出来：会静默退回「从中断处续跑」，而崩在 CLI 起来之前的那一回合根本
// 没把指令交给 CLI —— 用户点了重试，agent 却什么都没收到。所以在这里钉住。
// 跑:npm -w server run test:retry-turn
import assert from "node:assert/strict";
import type { RetryTurnFacts, RetryTurnSession, RetryTurnTask } from "../src/task-retry-turn.js";
import { lastInputOf, latestSessionOf, retryTurnKindOf, retryTurnRejection } from "../src/task-retry-turn.js";

const turn = (t: string, text: string, extra: Record<string, unknown> = {}) =>
  `\x1e${JSON.stringify({ t, agent: "claude", text, at: "2026-08-13T01:00:00.000Z", ...extra })}`;

// ── 续聊回合崩了：最后一段是我打的字 → 原样重投 ────────────────────────────
{
  const seg = lastInputOf([
    turn("user", "第一句"),
    "agent 干完了第一件事",
    turn("user", "把标题也改一下"),
    "agent 刚开口就崩了",
    "> 续聊回合异常结束(退出码 1),任务状态保持「已完成」不变。",
  ].join("\n"));
  assert.equal(seg?.kind, "user", "最后一段是真人回合");
  assert.equal(seg?.text, "把标题也改一下", "取的是最后那句，不是第一句");
  assert.equal(seg?.kind === "user" ? seg.bySystem : undefined, undefined, "真人发的不带代写标记");
}

// ── 自由工作流自动修复回合崩了：最后一段是后端代写的 user 回合 → 重投并保留标记 ──
{
  const seg = lastInputOf([
    turn("user", "【自由工作流审查未通过 · 第 1 轮】\n请按报告修复", { by: "system" }),
    "agent 起来就吃了 503",
  ].join("\n"));
  assert.equal(seg?.kind, "user", "代写消息仍占真人回合");
  assert.equal(seg?.kind === "user" ? seg.bySystem : undefined, true, "重投时要原样带回 by:system，别把机器的话记成用户说的");
}

// ── 上一回合本来就是系统续跑 → 不重投，退回 resume ──────────────────────────
{
  const seg = lastInputOf([
    turn("user", "开工"),
    "agent 干了一半",
    turn("system", "继续（从中断处）"),
    "agent 又崩了",
  ].join("\n"));
  assert.equal(seg?.kind, "system", "最后一段是系统提示，重投它没有意义");
}

// ── 首跑（会话里一个非 agent 段都没有）→ 退回 resume ────────────────────────
assert.equal(lastInputOf("agent 从头到尾自己说话"), null, "没有输入段就没有可重投的东西");
assert.equal(lastInputOf(""), null, "空正文");

console.log("✓ retry-turn input predicate");

// ── 「最新会话」的排序口径 ────────────────────────────────────────────────────
// 会话行跨回合复用，恢复旧会话只更新 turnStartedAt。按 startedAt 排会把「先建后用」的
// 那条永远判成旧的，于是前端提交的正确 sessionId 被判成「不是最新一次」，按钮永久 409。
const sess = (over: Partial<RetryTurnSession> & { id: string }): RetryTurnSession => ({
  role: "single",
  turnStartedAt: null,
  startedAt: "2026-08-13T01:00:00.000Z",
  exitStatus: 1,
  ...over,
});
{
  // A 先建（01:00），B 后建并跑完（02:00），03:00 切回 A 续聊 —— 最新的是 A。
  const a = sess({ id: "a", startedAt: "2026-08-13T01:00:00.000Z", turnStartedAt: "2026-08-13T03:00:00.000Z" });
  const b = sess({ id: "b", startedAt: "2026-08-13T02:00:00.000Z", exitStatus: 0 });
  assert.equal(latestSessionOf([a, b])?.id, "a", "按最近一次回合排，不是按会话创建时间");
  assert.equal(latestSessionOf([b, a])?.id, "a", "与入参顺序无关");
  assert.equal(latestSessionOf([])?.id, undefined, "没有会话就没有最新会话");
}

// ── 能不能重跑 ──────────────────────────────────────────────────────────────
const task = (over: Partial<RetryTurnTask> = {}): RetryTurnTask => ({
  archived: false,
  mode: "single",
  status: "done",
  verifyRound: null,
  ...over,
});
const why = (t: RetryTurnTask, s: RetryTurnSession | null, extra: Partial<RetryTurnFacts> = {}) =>
  retryTurnRejection({ task: t, latest: s, ...extra })?.error ?? null;

assert.equal(why(task(), sess({ id: "a" })), null, "停在 done、上一回合非零退出 → 放行");
// 主动停止/暂停的真实形状:CLI 吃 SIGTERM 按 signal 写 exit 1,任务正常落 canceled/paused。
// 这不是崩溃,给了按钮就是把「我停的」冒充成「它崩了」。
assert.ok(why(task({ status: "canceled" }), sess({ id: "a" })), "主动停止不是异常结束");
assert.ok(why(task({ status: "paused" }), sess({ id: "a" })), "暂停不是异常结束");
assert.ok(why(task({ status: "backlog" }), sess({ id: "a" })), "手工改回 backlog 也不给");
assert.ok(why(task({ status: "failed" }), sess({ id: "a" })), "failed 归头部那颗重试");
assert.ok(why(task({ status: "running" }), sess({ id: "a" })), "正在跑的不给重投");
assert.ok(why(task({ status: "queued" }), sess({ id: "a" })), "排队中的不给重投");
assert.ok(why(task({ archived: true }), sess({ id: "a" })), "归档任务不跑");
assert.ok(why(task({ mode: "team" }), sess({ id: "a" })), "只接单飞");
assert.ok(why(task({ verifyRound: 2 }), sess({ id: "a" })), "验证轮还挂着号,那是旁路回合");
assert.ok(why(task({ question: "选 A 还是 B?" }), sess({ id: "a" })), "还在等答复,先答复");
assert.ok(why(task({ resumePrompt: "继续做第二步" }), sess({ id: "a" })), "挂着续跑指令,该继续而不是重投");
assert.ok(why(task(), sess({ id: "a", exitStatus: 0 })), "正常结束不用重跑");
assert.ok(why(task(), sess({ id: "a", exitStatus: null })), "没结算的回合不算崩溃");
assert.ok(why(task(), null), "没跑过就没有上一回合");
assert.ok(why(task(), sess({ id: "a" }), { wantedSessionId: "b" }), "页面上那条不是最新会话 → 拒绝而不是照跑");
assert.equal(why(task(), sess({ id: "a" }), { wantedSessionId: "a" }), null, "页面上那条就是最新会话 → 放行");
// 手动停止:CLI 按 signal 写非零退出码,跟崩溃在 exitStatus 上完全一样,只有 stoppedAs 分得开。
// 认不出来 = 用户刚亲手停下的那句话被按钮又跑了一遍。
assert.ok(why(task(), sess({ id: "a", stoppedAs: "canceled" })), "手动停止的回合不是崩溃");
assert.ok(why(task(), sess({ id: "a", stoppedAs: "paused" })), "手动暂停的回合不是崩溃");
// 旁路回合(就地验证、/compact):重投会按任务当前配置跑普通回合,跑的不是那一轮的验证者。
assert.ok(why(task(), sess({ id: "a", sideTurn: true })), "旁路回合有自己的入口");
assert.ok(why(task(), sess({ id: "a" }), { groupPaused: true }), "分组暂停时不许从这里插队开跑");
assert.ok(why(task(), sess({ id: "a" }), { blockedBy: ["前面那个"] }), "队列前面没跑完就不许抢跑");
// profile 可编辑可删:改一次 target 就换了台机器,改一次供应商就换了套账号。「原样再跑一遍」
// 的前提是那套执行环境还在,对不上就得让用户明确决定,不能拿新环境冒充原样重放。
assert.ok(why(task(), sess({ id: "a" }), { profileDrift: "missing" }), "执行器被删了,重跑不了");
assert.ok(why(task(), sess({ id: "a" }), { profileDrift: "changed" }), "执行器配置被改过,不是原样重放");
assert.equal(why(task(), sess({ id: "a" }), { profileDrift: null }), null, "环境没变(或老会话行无从核对)→ 放行");
assert.ok(
  why(task({ workflowMode: "free" }), sess({ id: "a", role: "reviewer" }), { reviewBlocker: null, profileDrift: "changed" }),
  "审查档同吃这一条:它重跑引的是同一条可变 profile",
);

// ── 审查会话崩了：走审查那条路重跑，而不是拒绝，也不是拿实现 agent 顶上 ──────
const reviewer = sess({ id: "a", role: "reviewer" });
assert.equal(retryTurnKindOf(reviewer), "review", "reviewer 会话走审查档");
assert.equal(retryTurnKindOf(sess({ id: "a" })), "turn", "普通会话走重投档");
assert.equal(
  why(task({ workflowMode: "free", status: "done" }), reviewer, { reviewBlocker: null }),
  null,
  "自由工作流里崩掉的审查回合 → 放行(交给审查链重跑这一轮)",
);
assert.ok(why(task(), reviewer, { reviewBlocker: null }), "不是自由工作流的审查会话没有可重跑的链");
assert.ok(
  why(task({ workflowMode: "free" }), reviewer, { reviewBlocker: "最近一轮审查没有停在异常结束状态" }),
  "审查链本身不可重跑时,原样把理由抛给前端",
);
// 审查档不看 done：审查回合是旁路回合,任务停在哪个终态都可能(paused 上派审也合法)。
assert.equal(
  why(task({ workflowMode: "free", status: "canceled" }), reviewer, { reviewBlocker: null }),
  null,
  "审查档不要求任务停在 done",
);
// 其余身份(团队调度台、duet 双声道)连「上一回合」的形状都不一样。
assert.ok(why(task(), sess({ id: "a", role: "lead" })), "调度台会话不归这颗按钮");
assert.ok(why(task(), sess({ id: "a", role: "voiceA" })), "duet 会话不归这颗按钮");

console.log("✓ retry-turn gate");

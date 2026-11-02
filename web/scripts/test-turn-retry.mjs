// 会话尾栏那颗「重跑上一回合」在前端的判据。它必须跟服务端
// `server/src/task-retry-turn.ts` 的 retryTurnRejection 说同一套话：前端松了 = 按钮点下去
// 永远 409，前端紧了 = 崩掉的回合没有任何入口（这颗按钮本来就是为了补这个洞才有的）。
// 跑:npm -w web run test:turn-retry
import assert from "node:assert/strict";
import { freeReviewRetryable, turnRetryTarget } from "../src/task-detail/turnRetry.ts";

const task = (over = {}) => ({
  id: "t1", mode: "single", status: "done", archived: false, verifyRound: null, ...over,
});
const agentItem = (session) => ({ kind: "agent", id: "bubble-1", session });
const sess = (over = {}) => ({ id: "s1", role: "single", exitStatus: 1, ...over });
const target = (t, items, opts) => turnRetryTarget(t, items, opts);

// ── 普通回合 ────────────────────────────────────────────────────────────────
assert.deepEqual(
  target(task(), [agentItem(sess())]),
  { sessionId: "s1", kind: "turn", exitStatus: 1 },
  "停在 done、上一回合非零退出 → 出按钮",
);
assert.equal(target(task(), [agentItem(sess({ exitStatus: 0 }))]), null, "正常结束不出");
assert.equal(target(task(), [agentItem(sess({ exitStatus: null }))]), null, "没结算的回合不算崩溃");
// ── 权威结局优先于退出码(审查 F2,已实测) ──────────────────────────────────────
// 回合级停滞看门狗终止掉的那一轮:ash 已经判它失败,而被终止的进程多半以 exit 0 收流
// (claude 走信号退出时是 `code ?? 0`)。照退出码判,页面明写「本次续聊因上游连不上被自动
// 终止」的同时却一个重跑入口都没有 —— 这颗按钮本来就是为了补这种洞才存在的。
assert.deepEqual(
  target(task(), [agentItem(sess({ exitStatus: 0, turnOutcome: "failed" }))]),
  { sessionId: "s1", kind: "turn", exitStatus: 0 },
  "被看门狗终止的那一轮(exit 0 + 区间 failed)必须给重跑入口",
);
assert.deepEqual(
  target(task(), [agentItem(sess({ exitStatus: null, turnOutcome: "failed" }))]),
  { sessionId: "s1", kind: "turn", exitStatus: null },
  "退出码没来得及写、但 ash 已判这一轮失败,同样要给入口",
);
// 反方向不许放水:权威结局说这一轮好着呢,就别因为退出码非零冒出按钮之外的新口子。
assert.equal(
  target(task(), [agentItem(sess({ exitStatus: 0, turnOutcome: "completed" }))]),
  null,
  "正常完成的回合不该出按钮",
);
assert.equal(
  target(task(), [agentItem(sess({ exitStatus: 0, turnOutcome: "stopped" }))]),
  null,
  "受控停止的回合不是异常结束",
);
assert.equal(target(task({ status: "failed" }), [agentItem(sess())]), null, "failed 归头部那颗重试");
assert.equal(target(task({ status: "running" }), [agentItem(sess())]), null, "跑着的不出");
assert.equal(target(task({ status: "queued" }), [agentItem(sess())]), null, "排队的不出");
assert.equal(target(task({ archived: true }), [agentItem(sess())]), null, "归档任务不出");
assert.equal(target(task({ mode: "team" }), [agentItem(sess())]), null, "只做单飞");
assert.equal(target(task({ verifyRound: 3 }), [agentItem(sess())]), null, "验证轮还挂着号");
assert.equal(target(task({ question: "选哪个?" }), [agentItem(sess())]), null, "等答复时不出");
assert.equal(target(task({ resumePrompt: "继续第二步" }), [agentItem(sess())]), null, "挂着续跑指令时不出");
assert.equal(target(task(), []), null, "没跑过就没有上一回合");
// 手动停止:CLI 吃 SIGTERM 后按 signal 写非零退出码,跟崩溃在 exitStatus 上一模一样。
assert.equal(target(task(), [agentItem(sess({ stoppedAs: "canceled" }))]), null, "手动停止的不是崩溃");
assert.equal(target(task(), [agentItem(sess({ stoppedAs: "paused" }))]), null, "手动暂停的不是崩溃");
// 旁路回合(就地验证、/compact)重投跑的是任务当前配置的普通回合,不是那一轮的验证者。
assert.equal(target(task(), [agentItem(sess({ sideTurn: true }))]), null, "旁路回合有自己的入口");
assert.equal(target(task(), [agentItem(sess({ role: "lead" }))]), null, "调度台会话不归这颗按钮");
// 按钮只挂在**最后一条** agent 气泡上:中间崩过的回合后面早跑过别的了。
assert.equal(
  target(task(), [agentItem(sess({ id: "old" })), { kind: "user", id: "u1" }, agentItem(sess({ id: "last" }))])
    ?.sessionId,
  "last",
  "取最后一条 agent 气泡的会话",
);

// ── 审查回合 ────────────────────────────────────────────────────────────────
const reviewer = [agentItem(sess({ id: "r1", role: "reviewer" }))];
assert.deepEqual(
  target(task({ workflowMode: "free" }), reviewer, { reviewRetryable: true }),
  { sessionId: "r1", kind: "review", exitStatus: 1 },
  "自由工作流里崩掉的审查回合 → 出「重跑本轮审查」",
);
assert.equal(target(task({ workflowMode: "free" }), reviewer), null, "审查链不在异常结束状态就不出");
assert.equal(target(task(), reviewer, { reviewRetryable: true }), null, "不是自由工作流就没有可重跑的链");
// 审查回合是旁路回合,任务停在哪个终态都可能(paused 上派审也合法)。
assert.equal(
  target(task({ workflowMode: "free", status: "canceled" }), reviewer, { reviewRetryable: true })?.kind,
  "review",
  "审查档不要求任务停在 done",
);

// ── 审查链能不能重跑（镜像 freeReviewRetryBlocker）────────────────────────────
const run = (over = {}) => ({ status: "failed", currentRound: 2, rounds: [
  { round: 1, status: "failed" }, { round: 2, status: "error" },
], ...over });
assert.equal(freeReviewRetryable([run()]), true, "run failed + 当前轮 error = 异常结束");
assert.equal(freeReviewRetryable(undefined), false, "没有审查记录");
assert.equal(freeReviewRetryable([]), false, "空列表");
assert.equal(freeReviewRetryable([run({ status: "stopped" })]), false, "已停止但不是异常结束");
assert.equal(freeReviewRetryable([run({ status: "passed" })]), false, "已通过的轮次不重跑");
assert.equal(
  freeReviewRetryable([run({ rounds: [{ round: 1, status: "error" }, { round: 2, status: "failed" }] })]),
  false,
  "error 的不是当前轮 → 不重跑",
);
// 还挂在 reviewing、但任务书送没送到说不清:系统不替用户结、不替他重投,入口交给这颗按钮。
const awaiting = (over = {}) => run({ status: "reviewing", rounds: [
  { round: 1, status: "failed" }, { round: 2, status: "reviewing", awaitsInputDecision: true },
], ...over });
assert.equal(freeReviewRetryable([awaiting()]), true, "送达说不清、等用户拿主意 → 给「继续本轮审查」");
assert.equal(freeReviewRetryable([run({ status: "reviewing", rounds: [{ round: 2, status: "reviewing" }] })]), false,
  "正常在审的那一轮不给按钮");
assert.equal(freeReviewRetryable([awaiting({ rounds: [{ round: 1, status: "reviewing", awaitsInputDecision: true },
  { round: 2, status: "reviewing" }] })]), false, "标记不在当前轮 → 不给");

// ── 审查档认会话，不认气泡(自由审查第 2 轮 R1)──────────────────────────────────
// 一句正文都没吐就断掉的审查回合不产生 agent 气泡:按「最后一条气泡」找,要么找不到,要么找到
// 前面实现者那一条 —— 服务端标了「等你拿主意」、retry-turn 也收,页面上却一颗按钮都没有。
const at = (id, role, t, over = {}) => sess({ id, role, startedAt: t, turnStartedAt: t, ...over });
const sessions = [at("impl", "single", "2026-11-01T00:00:00Z", { exitStatus: 0 }),
  at("rev", "reviewer", "2026-11-01T01:00:00Z", { exitStatus: null })];
const free = task({ workflowMode: "free" });
assert.deepEqual(target(free, [], { reviewRetryable: true, sessions }),
  { sessionId: "rev", kind: "review", exitStatus: null }, "审查会话一个气泡都没有 → 照样给入口,绑在审查会话上");
assert.deepEqual(target(free, [agentItem(sessions[0])], { reviewRetryable: true, sessions }),
  { sessionId: "rev", kind: "review", exitStatus: null }, "最后一条气泡是实现者的 → 入口仍绑最新的审查会话");
assert.equal(target(free, [agentItem(sessions[0])], { reviewRetryable: false, sessions }), null,
  "审查链不等人拿主意 → 不出(不拿「有会话」推「能继续」)");
assert.equal(target(free, [], { reviewRetryable: true, sessions: [...sessions,
  at("impl2", "single", "2026-11-01T02:00:00Z", { exitStatus: 0 })] }), null,
"审查之后又跑过实现者回合 → 上一回合不是审查,服务端会 409,前端不出");
assert.equal(target(free, [], { reviewRetryable: true, sessions: [sessions[0],
  at("rev", "reviewer", "2026-11-01T01:00:00Z", { stoppedAs: "canceled" })] }), null, "手动停掉的审查回合不出");
// 排序按回合起点(续聊复用老会话):老审查会话刚续过一回合,它才是「上一回合」。
assert.equal(target(free, [], { reviewRetryable: true, sessions: [
  at("rev", "reviewer", "2026-11-01T00:00:00Z", { turnStartedAt: "2026-11-01T03:00:00Z" }),
  at("impl", "single", "2026-11-01T02:00:00Z", { exitStatus: 0 })] })?.sessionId, "rev",
"上一回合按 turnStartedAt 认,与服务端 latestSessionOf 同口径");

console.log("✓ turn-retry gate (web)");

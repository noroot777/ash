// 会话尾栏那颗「重跑上一回合」在前端的判据。它必须跟服务端
// `server/src/task-retry-turn.ts` 的 retryTurnRejection 说同一套话：前端松了 = 按钮点下去
// 永远 409，前端紧了 = 崩掉的回合没有任何入口（这颗按钮本来就是为了补这个洞才有的）。
// 跑:npm -w web run test:turn-retry
import assert from "node:assert/strict";
import { freeReviewRetryIdentity, turnRetryTarget } from "../src/task-detail/turnRetry.ts";

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

// ── 审查回合：认那一轮审查的身份，不认气泡、也不认「最新会话」 ─────────────────────────
// 服务端把「这一轮能继续」连同代次发在当前轮的 `retry` 上(free-review-retry-identity.ts);
// 前端原样带回。下一次自由审查第 1 轮 R1:审查等着用户拿主意时跑一条 `/compact`,最新会话成了
// 那条旁路回合,按「最新会话是不是审查者」认人的入口当场消失、刷新也回不来。
const identity = { runId: "run-1", round: 2, generation: "g-2", sessionId: "rev" };
const at = (id, role, t, over = {}) => sess({ id, role, startedAt: t, turnStartedAt: t, ...over });
const free = task({ workflowMode: "free" });
const reviewTarget = (sessionId, exitStatus = null, review = identity) => ({ kind: "review", sessionId, exitStatus, review });
const impl = at("impl", "single", "2026-11-01T00:00:00Z", { exitStatus: 0 });
const rev = at("rev", "reviewer", "2026-11-01T01:00:00Z", { exitStatus: null });
const compact = at("compact", "single", "2026-11-01T02:00:00Z", { exitStatus: 0, sideTurn: true });

assert.deepEqual(target(free, [], { reviewRetry: identity, sessions: [impl, rev] }), reviewTarget("rev"),
  "审查会话一个气泡都没有 → 照样给入口,续的是这一轮输入进过的那条会话");
assert.deepEqual(target(free, [agentItem(impl)], { reviewRetry: identity, sessions: [impl, rev] }), reviewTarget("rev"),
  "最后一条气泡是实现者的 → 入口仍是那一轮审查");
assert.deepEqual(target(free, [agentItem(compact)], { reviewRetry: identity, sessions: [impl, rev, compact] }),
  reviewTarget("rev"), "审查等人时插进一条 /compact 旁路回合,入口不许被挤掉");
assert.deepEqual(target(free, [agentItem(sess({ id: "r1", role: "reviewer" }))], { reviewRetry: identity }),
  reviewTarget("rev"), "不给会话行时照样按审查身份出(停止记录无从核对,交给服务端)");
assert.equal(target(free, [agentItem(rev)], { sessions: [impl, rev] }), null,
  "审查链不能继续(没有 retry)→ 不出:不拿「有审查会话」推「能继续」");
assert.equal(target(task(), [agentItem(rev)], { reviewRetry: identity, sessions: [impl, rev] }), null,
  "不是自由工作流就没有可继续的链");
assert.equal(target(free, [], { reviewRetry: identity, sessions: [impl, { ...rev, stoppedAs: "canceled" }] }), null,
  "这一轮自己那条会话是手动停掉的 → 不出(服务端同样 409)");
assert.equal(
  target(task({ workflowMode: "free", status: "canceled" }), [agentItem(rev)], { reviewRetry: identity, sessions: [rev] })?.kind,
  "review", "审查档不要求任务停在 done(paused 上派审也合法)");
// 下一次自由审查第 2 轮 R1:新派的审查在起跑前就失败,这一轮一条会话都没有;任务里最近的
// reviewer 会话属于**上一条链**。借它的停止记录会把入口挡掉,借它的正文会把新审查当成「已经
// 做过」从中断处续跑 —— 这一轮的会话只认服务端按交付凭据给的那一条。
const fresh = { ...identity, runId: "run-2", round: 1, sessionId: null };
const oldStopped = at("rev-old", "reviewer", "2026-11-01T05:00:00Z", { stoppedAs: "canceled" });
assert.deepEqual(target(free, [agentItem(oldStopped)], { reviewRetry: fresh, sessions: [impl, oldStopped] }),
  reviewTarget(null, null, fresh), "上一条链的审查会话被手动停过,也挡不住新这一轮的入口");
const oldWorked = at("rev-old", "reviewer", "2026-11-01T05:00:00Z", { exitStatus: 0 });
assert.equal(target(free, [agentItem(oldWorked)], { reviewRetry: fresh, sessions: [impl, oldWorked] })?.sessionId, null,
  "新这一轮没有会话 → 不借上一条链的(服务端从头交代任务书)");
// 普通回合那颗「重试」排在审查档前面:上一回合是崩掉的普通回合时,那才是用户眼前那件事。
const crashed = at("crash", "single", "2026-11-01T03:00:00Z", { exitStatus: 1 });
assert.deepEqual(target(free, [agentItem(crashed)], { reviewRetry: identity, sessions: [rev, crashed] }),
  { kind: "turn", sessionId: "crash", exitStatus: 1 }, "最近一次是崩掉的普通回合 → 出的是「重试」");
// 反过来:崩掉的普通回合之后又起过一轮(没出声的审查),那条气泡就不是「上一回合」了。
assert.deepEqual(target(free, [agentItem({ ...crashed, startedAt: "2026-11-01T00:30:00Z", turnStartedAt: "2026-11-01T00:30:00Z" })],
  { reviewRetry: identity, sessions: [{ ...crashed, startedAt: "2026-11-01T00:30:00Z", turnStartedAt: "2026-11-01T00:30:00Z" }, rev] }),
reviewTarget("rev"), "气泡那条会话不是最近一次回合 → 不给它「重试」(服务端会 409),给审查档");
assert.equal(target(task(), [agentItem(sess({ id: "a" }))], { sessions: [sess({ id: "a", startedAt: "1" }), sess({ id: "b", startedAt: "2", exitStatus: 0 })] }),
  null, "普通回合:气泡后面还有更近的回合 → 不出");

// ── 审查链身份：只读服务端发下来的 retry,不在前端再镜像一份判据 ─────────────────────
const run = (rounds, over = {}) => ({ id: "run-1", status: "reviewing", currentRound: 2, rounds, ...over });
assert.deepEqual(freeReviewRetryIdentity([run([{ round: 1 }, { round: 2, retry: { generation: "g-2", sessionId: "rev" } }])]),
  identity, "当前轮带着 retry → 给出 run/轮次/代次/这一轮的会话");
assert.deepEqual(freeReviewRetryIdentity([run([{ round: 2, retry: { generation: null, sessionId: null } }])]),
  { ...identity, generation: null, sessionId: null }, "老数据取不到代次、这一轮还没有会话,都原样带回");
assert.equal(freeReviewRetryIdentity(undefined), null, "没有审查记录");
assert.equal(freeReviewRetryIdentity([]), null, "空列表");
assert.equal(freeReviewRetryIdentity([run([{ round: 2 }])]), null, "当前轮没有 retry → 不能继续");
assert.equal(freeReviewRetryIdentity([run([{ round: 1, retry: { generation: "g" } }, { round: 2 }])]), null,
  "retry 不在当前轮 → 不认");
assert.equal(freeReviewRetryIdentity([run([{ round: 2 }]), run([{ round: 2, retry: { generation: "g" } }], { id: "old" })]),
  null, "只认最近那条链");

console.log("✓ turn-retry gate (web)");

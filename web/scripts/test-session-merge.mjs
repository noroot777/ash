import assert from "node:assert/strict";
import { mergeSessions } from "../src/lib/sessionMerge.ts";

// 请求层已经把同任务的 sessions 排成一条串行链，incoming 一定读得更晚 ——
// 为什么这样就能整行采用 incoming，写在 src/lib/sessionMerge.ts，这里只钉行为。

const usageOf = (turns, input) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: null, turns });
const s1 = {
  id: "s1", taskId: "t", startedAt: "2026-07-30T01:00:00.000Z", endedAt: null, turnStartedAt: null,
  executor: "claude@old", cliSessionId: null, resumeCommand: null,
  usage: usageOf(1, 10), context: { used: 100, window: null, windowEstimated: false },
};
const s1Ended = { ...s1, endedAt: "2026-07-30T01:05:00.000Z" };
const s2 = { ...s1, id: "s2", startedAt: "2026-07-30T01:06:00.000Z" };
assert.deepEqual(mergeSessions([s1], [s1, s2]).map((s) => s.id), ["s1", "s2"], "新起的会话要补进来");
assert.deepEqual(mergeSessions([s1, s2], [s1]).map((s) => s.id), ["s1"], "会话行没了就跟着没（接力导入会作废整行）");
assert.deepEqual(mergeSessions([s1], [s1Ended])[0], s1Ended, "收口了就跟着更新");
assert.deepEqual(mergeSessions([s1Ended], [s1])[0], s1, "服务端说它又在跑了就是又在跑了，不替它保留收口时间");

// **这一组是重点。** CLI 凭据会在跑的过程中原地轮换（server/src/single-run.ts:396-404
// 收到新 session 事件就改 cliSessionId 和 resume 字段），也会在会话失效时被明确清空
// （server/src/handoff.ts、handoff-import.ts）。两笔都不动时间戳和用量。凭据和它的
// resume 命令是一个单元，必须整块跟着最新那一发走 —— 否则屏幕上留着、用户复制走的，
// 是服务端已经作废的恢复命令。
const rotOld = { ...s1, cliSessionId: "z-old", resumeCommand: "claude --resume z-old" };
const rotNew = { ...s1, cliSessionId: "a-new", resumeCommand: "claude --resume a-new" };
const rotated = mergeSessions([rotOld], [rotNew])[0];
assert.equal(rotated.cliSessionId, "a-new", "凭据轮换要采用较晚那一发，不能比字典序");
assert.equal(rotated.resumeCommand, "claude --resume a-new", "resume 命令跟凭据是一个单元，一起换");
const revoked = mergeSessions([rotOld], [{ ...s1, cliSessionId: null, resumeCommand: null }])[0];
assert.equal(revoked.cliSessionId, null, "服务端明确清空凭据后，别再拿旧 ID 冒充当前值");
assert.equal(revoked.resumeCommand, null, "作废的 resume 命令也不许留在页面上");
assert.equal(mergeSessions(mergeSessions([rotOld], [rotNew]), [rotNew])[0].cliSessionId, "a-new", "连刷两次不回弹");

// 其余字段同理：服务端的 toSession() 每次都从会话行整行现算，没有「这一发缺个字段」
// 的补全语义，所以不做逐字段保底。
const live = {
  ...s1, executor: "codex@new", cliSessionId: "cli-new",
  usage: usageOf(3, 200), context: { used: 50000, window: 200000, windowEstimated: false },
};
assert.equal(mergeSessions([s1], [live])[0].usage.input, 200, "用量跟随这一发");
assert.equal(mergeSessions([s1], [live])[0].executor, "codex@new", "执行器元数据跟随这一发");
const enriched = { ...s1, usage: { ...usageOf(1, 10), reasoning: 25, costUsd: 1.25 } };
assert.equal(mergeSessions([s1], [enriched])[0].usage.reasoning, 25);
assert.equal(mergeSessions([enriched], [s1])[0].usage.costUsd, null, "费用也是覆盖值，服务端说没有就是没有");

// 上下文水位：服务端会合法地调低甚至清空（见 server/src/usage.ts 的 setSessionContext），
// 早先客户端做只增并集，结果永远收敛不到真值。
const high = { ...s1, context: { used: 180000, window: 200000, windowEstimated: false } };
const compacted = { ...s1, context: { used: 40000, window: 200000, windowEstimated: false } };
const cleared = { ...s1, context: null };
assert.equal(mergeSessions([high], [compacted])[0].context.used, 40000, "压缩后的低水位不能被旧高水位顶回去");
assert.equal(mergeSessions(mergeSessions([high], [compacted]), [compacted])[0].context.used, 40000, "连着刷两次也不该回弹");
assert.equal(mergeSessions([high], [cleared])[0].context, null, "服务端明确清空后就别再拿旧水位冒充当前值");
assert.equal(mergeSessions([cleared], [high])[0].context.used, 180000, "反过来采到了就显示出来");
// 窗口这个分母也跟着整份 context 走，不另做「谁有取谁」的补齐。
const reported = { ...s1, context: { used: 100, window: 200000, windowEstimated: false } };
const estimated = { ...s1, context: { used: 100, window: 200000, windowEstimated: true } };
assert.equal(mergeSessions([reported], [estimated])[0].context.windowEstimated, true);
assert.equal(mergeSessions([estimated], [reported])[0].context.windowEstimated, false);

// 引用稳定：sessions 是下游一长串 useMemo 的依赖，值没变就别换对象。
assert.equal(mergeSessions([reported], [reported])[0].context, reported.context, "值没变就别换对象");
assert.equal(mergeSessions([s1], [{ ...s1 }])[0], s1, "逐字段等值的新对象也不该顶掉旧引用");
const both = [s1, s2];
assert.equal(mergeSessions(both, [s1, s2]), both, "没有实际变化就把原数组还回去，别让下游整条会话白重算");
assert.notEqual(mergeSessions(both, [s1]), both, "少了一条就得换数组，否则下游看不见");
// 顺序按开始时间排，不跟着服务端那条没写 ORDER BY 的查询走。
assert.deepEqual(mergeSessions([], [s2, s1]).map((s) => s.id), ["s1", "s2"], "乱序到达也按开始时间排");

console.log("session 合并回归验证通过");

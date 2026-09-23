import assert from "node:assert/strict";
import { mergeSessions } from "../src/lib/sessionMerge.ts";

// sessions 的两个写者（全量重读 / 直播补刷）谁的快照更新，客户端判不出来 ——
// 合并规则和它为什么是这样都在 src/lib/sessionMerge.ts，这里只钉行为。

const usageOf = (turns, input) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: null, turns });
const s1 = {
  id: "s1", taskId: "t", startedAt: "2026-07-30T01:00:00.000Z", endedAt: null, turnStartedAt: null,
  executor: "claude@old", cliSessionId: null, usage: usageOf(1, 10), context: { used: 100, window: null, windowEstimated: false },
};
const s1Ended = { ...s1, endedAt: "2026-07-30T01:05:00.000Z" };
const s2 = { ...s1, id: "s2", startedAt: "2026-07-30T01:06:00.000Z" };
assert.deepEqual(mergeSessions([s1], [s1, s2]).map((s) => s.id), ["s1", "s2"], "新起的会话要补进来");
assert.deepEqual(mergeSessions([s1, s2], [s1]).map((s) => s.id), ["s1", "s2"], "更旧的快照不能把新会话抹掉");
assert.deepEqual(mergeSessions([s1Ended], [s1])[0], s1Ended, "已经收口的那份不被未收口的旧快照盖回去");
assert.deepEqual(mergeSessions([s1], [s1Ended])[0], s1Ended, "收口了就跟着更新");

// 真实的更新路径多数**不动那三个时间戳**：CLI 首次报上 session id、用量累加、上下文
// 水位刷新，stamp 全程不变。旧快照后到时不许把这些字段抹回去。
const s1Live = {
  ...s1, executor: "codex@new", cliSessionId: "cli-new",
  usage: usageOf(3, 200), context: { used: 50000, window: 200000, windowEstimated: false },
};
const newThenOld = mergeSessions([s1Live], [s1])[0];
const oldThenNew = mergeSessions([s1], [s1Live])[0];
assert.deepEqual(newThenOld, oldThenNew, "同样两份快照，换个到达顺序结果必须一样");
assert.equal(newThenOld.cliSessionId, "cli-new", "已经拿到的 CLI 会话凭据不许被旧快照抹成 null");
assert.equal(newThenOld.usage.input, 200, "累计用量只增不减");
assert.equal(newThenOld.context.used, 50000, "上下文水位跟着更新的那份走");
assert.equal(newThenOld.executor, "codex@new", "执行器元数据不回退");

// 版本分不出高下（同一时刻的两份快照，用量也一样）时也要收敛到同一个结果。
const sameA = { ...s1, cliSessionId: "cli-1", branch: null };
const sameB = { ...s1, cliSessionId: null, branch: "ash/x" };
assert.deepEqual(mergeSessions([sameA], [sameB])[0], mergeSessions([sameB], [sameA])[0], "版本判不出时也要与顺序无关");
assert.equal(mergeSessions([sameA], [sameB])[0].cliSessionId, "cli-1", "各自非空的字段都保住");
assert.equal(mergeSessions([sameA], [sameB])[0].branch, "ash/x");

// 版本比不到的那几项（reasoning / costUsd 不参与版本）也不能整对象取一边就丢掉，
// 否则缺字段的那一发后到就把它们抹回 0/null。
const enriched = { ...s1, usage: { ...usageOf(1, 10), reasoning: 25, costUsd: 1.25 } };
const baseThenEnriched = mergeSessions([s1], [enriched])[0];
const enrichedThenBase = mergeSessions([enriched], [s1])[0];
assert.deepEqual(baseThenEnriched.usage, enrichedThenBase.usage, "同版本平局时，换个到达顺序用量也必须一样");
assert.equal(baseThenEnriched.usage.reasoning, 25, "reasoning token 不被没带它的那一发抹成 0");
assert.equal(baseThenEnriched.usage.costUsd, 1.25, "费用不被抹回 null");

// 上下文水位反过来：它是覆盖值，服务端会合法地调低甚至清空（见 server/src/usage.ts
// 的 setSessionContext）。合并必须跟随这一发响应，否则客户端永远收敛不到真值。
const high = { ...s1, context: { used: 180000, window: 200000, windowEstimated: false } };
const compacted = { ...s1, context: { used: 40000, window: 200000, windowEstimated: false } };
const cleared = { ...s1, context: null };
assert.equal(mergeSessions([high], [compacted])[0].context.used, 40000, "压缩后的低水位不能被旧高水位顶回去");
assert.equal(
  mergeSessions(mergeSessions([high], [compacted]), [compacted])[0].context.used,
  40000,
  "连着刷两次也不该回弹",
);
assert.equal(mergeSessions([high], [cleared])[0].context, null, "服务端明确清空后就别再拿旧水位冒充当前值");
assert.equal(mergeSessions(mergeSessions([high], [cleared]), [cleared])[0].context, null, "清空同样要稳住");
assert.equal(mergeSessions([cleared], [high])[0].context.used, 180000, "反过来采到了就显示出来");
// 窗口这个分母也跟着整份 context 走，不另做「谁有取谁」的补齐。
const reported = { ...s1, context: { used: 100, window: 200000, windowEstimated: false } };
const estimated = { ...s1, context: { used: 100, window: 200000, windowEstimated: true } };
assert.equal(mergeSessions([reported], [estimated])[0].context.windowEstimated, true);
assert.equal(mergeSessions([estimated], [reported])[0].context.windowEstimated, false);
assert.equal(mergeSessions([reported], [reported])[0].context, reported.context, "值没变就别换对象");

assert.deepEqual(
  mergeSessions(mergeSessions([], [s1, s2]), [s1Ended]).map((s) => [s.id, s.endedAt]),
  mergeSessions(mergeSessions([], [s1Ended]), [s1, s2]).map((s) => [s.id, s.endedAt]),
  "两份快照换个顺序合并，结果必须一样",
);
const both = [s1, s2];
assert.equal(mergeSessions(both, [s1, s2]), both, "没有实际变化就把原数组还回去，别让下游整条会话白重算");

console.log("session 合并回归验证通过");

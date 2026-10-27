// 气泡上那个「本轮 N token」读的是落盘 trace 里这一回合的 usage 事件 —— 而 claude 的旧
// trace 存的是**线程累计快照**，于是第 N 个气泡显示的是开场到此刻的总和（实测一例：真实
// 63 万被显示成 70.13M，跟那一回合的 result 行分毫不差）。
//
// 读侧判「这串是累计还是增量」不能看 accounting 标记：claude 的旧 trace 一条不缺地都标着
// incremental（当时服务端认为它本来就是增量）。所以改看两个数据自身的特征，而第二个是
// 决定性的 —— **最后一条正好等于会话行汇总**，这是累计口径下「各轮增量之和 = 最后一份
// 累计值」的恒等式。这个文件钉的就是「什么时候敢动、什么时候必须不动」。
import assert from "node:assert/strict";
import { normalizedPersistedTrace } from "../src/task-detail/conversationTraceGroups.ts";

/** 实测会话 wkfsPOl_xgRe 的连续 result 行（modelUsage 四项求和）。 */
const REAL = [
  { input: 9339, output: 394520, cacheRead: 63298503, cacheWrite: 5805417, reasoning: 0, costUsd: 155.68560549999995, turns: 1 },
  { input: 9345, output: 400265, cacheRead: 63711360, cacheWrite: 6013905, reasoning: 0, costUsd: 158.99187249999994, turns: 1 },
  { input: 9359, output: 408827, cacheRead: 65221499, cacheWrite: 6027226, reasoning: 0, costUsd: 161.09676399999995, turns: 1 },
  { input: 9373, output: 417632, cacheRead: 66824793, cacheWrite: 6040299, reasoning: 0, costUsd: 163.30386049999996, turns: 1 },
];
const KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"];
const total = (usage) => KEYS.reduce((sum, key) => sum + usage[key], 0);

const entry = (usage, accounting = "incremental") => ({
  at: "2026-10-27T12:18:00.838Z",
  turnStartedAt: "2026-10-27T12:18:00.000Z",
  event: accounting ? { kind: "usage", usage, accounting } : { kind: "usage", usage },
});
const traceOf = (series, accounting = "incremental") => [
  { at: "2026-10-27T12:00:00.000Z", turnStartedAt: "2026-10-27T12:00:00.000Z", event: { kind: "text", text: "干完了。" } },
  ...series.map((usage) => entry(usage, accounting)),
];
const session = (agentType, usage) => ({ agentType, usage });
/** 把一串 usage 加起来当会话汇总 —— 「回填还没跑」时库里就是这个数。 */
const summed = (series) => series.reduce((sum, usage) => ({
  ...Object.fromEntries(KEYS.map((key) => [key, sum[key] + usage[key]])),
  costUsd: (sum.costUsd ?? 0) + (usage.costUsd ?? 0),
  turns: sum.turns + 1,
}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, turns: 0 });
const usages = (trace) => trace.flatMap((item) => (item.event.kind === "usage" ? [item.event.usage] : []));

// 1. 回填跑完的 claude 旧会话：汇总 == 最后一条累计值 → 读侧求差，气泡回到真实用量。
{
  const trace = traceOf(REAL);
  const out = normalizedPersistedTrace(trace, session("claude", { ...REAL.at(-1), turns: REAL.length }));
  const deltas = usages(out);
  assert.equal(deltas.length, REAL.length);
  assert.equal(total(deltas[0]), 69_507_779, "第一轮没有前一份快照，整份就是它自己的用量");
  assert.deepEqual(
    { ...deltas[1], costUsd: null },
    { input: 6, output: 5745, cacheRead: 412857, cacheWrite: 208488, reasoning: 0, costUsd: null, turns: 1 },
    "任务书点名那个气泡：真实 627,096，不是 result 行上的 70,134,875",
  );
  assert.equal(
    deltas.reduce((sum, usage) => sum + total(usage), 0),
    total(REAL.at(-1)),
    "各轮之和必须收敛到会话汇总，否则气泡加起来跟总额对不上",
  );
  assert.equal(out[0], trace[0], "非 usage 事件必须原样透传（同一个对象引用）");
}

// 2. 回填还没跑：汇总仍是「各份累计值之和」→ 一个字节都不许动。宁可气泡上还是旧数字，
//    也不能在库里那半边还没修好时自作主张，否则气泡与总额两头都不对。
{
  const trace = traceOf(REAL);
  assert.equal(
    normalizedPersistedTrace(trace, session("claude", summed(REAL))),
    trace,
    "会话汇总对不上最后一条 → 判不出是累计口径 → 原样返回",
  );
}

// 3. 改口径之后写下的真增量序列：汇总 == 全部之和，最后一条远小于它 → 不许再求一次差。
{
  const deltas = [REAL[0], { ...REAL[1], input: 6, output: 5745, cacheRead: 412857, cacheWrite: 208488, costUsd: 3.3 }];
  const trace = traceOf(deltas);
  assert.equal(normalizedPersistedTrace(trace, session("claude", summed(deltas))), trace);
}

// 4. 只有一条 usage：两种口径同值，没有可求的差。
{
  const trace = traceOf([REAL[0]]);
  assert.equal(normalizedPersistedTrace(trace, session("claude", { ...REAL[0], turns: 1 })), trace);
}

// 5. 会话行不报账（历史会话 / 不报账的 CLI）：没有汇总可比，判不出口径。
{
  const trace = traceOf(REAL);
  assert.equal(normalizedPersistedTrace(trace, session("claude", null)), trace);
}

// 6. codex 那条老路不许在重构里走丢：没有 accounting 标记的旧 trace 照旧求差，
//    有标记的照旧不动。
{
  const out = usages(normalizedPersistedTrace(traceOf(REAL, null), session("codex", null)));
  assert.equal(total(out[1]), 627_096, "codex 旧 trace 仍按标记缺失判定，与会话汇总无关");
  assert.equal(out[1].costUsd, null, "codex 不报价，求差后也不许垫一个数出来");
  const marked = traceOf(REAL, "incremental");
  // codex 那一路是逐条按标记判的，所以这里只能比内容：它仍会原样 map 一遍整条 trace。
  assert.deepEqual(
    normalizedPersistedTrace(marked, session("codex", null)),
    marked,
    "标过的新 trace 不许再求一次差",
  );
}

// 7. 其它执行器一律不碰。
{
  const trace = traceOf(REAL);
  for (const agentType of ["opencode", "grok", "gemini"]) {
    assert.equal(normalizedPersistedTrace(trace, session(agentType, { ...REAL.at(-1), turns: REAL.length })), trace);
  }
}

console.log("claude 旧 trace 的读侧换算通过：恒等式判据、回填前后两档、codex 老路未动");

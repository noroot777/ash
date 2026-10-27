// 气泡上那个「本轮 N token」读的是落盘 trace 里这一回合的 usage 事件 —— 而 claude 的旧
// trace 存的是**线程累计快照**，于是第 N 个气泡显示的是开场到此刻的总和（实测一例：真实
// 63 万被显示成 70.13M，跟那一回合的 result 行分毫不差）。
//
// **这个文件钉的是「读侧不许猜口径」。** 判据只能是逐条的 accounting 标记：
// - 旧 codex trace 没有标记，存的是累计快照 → 只有这一类在读侧求差（这条老路不许走丢）；
// - 有标记的（incremental / delta / snapshot）都是服务端结算过的本轮值 → 原样显示；
// - claude 旧 trace 全都标着 incremental，标记在这里没有分辨力 → 那批数据由历史回填
//   (server/scripts/repair-claude-usage.ts) 逐条改写成真实增量并补上 delta 标记，**不在
//   读侧猜**。
//
// 为什么不能猜：上一版按数据形状判（整串不降 + 末条等于会话汇总），被第 1 轮审查当场
// 证伪 —— 那个恒等式只对「已回填且此后没再续聊」的会话成立，随便续一轮新回合，汇总就
// 不再等于末条，**整条历史的气泡会集体弹回累计值**（实测第 2 个气泡从正确的 81.9 万弹回
// 1726 万，页面底部合计 81.09M 与右侧库里的 24.91M 自相矛盾）；跨 ash 会话行的线程更是
// 永远凑不出这个恒等式。一条旧记录的含义不能随「以后会不会续聊」改变。
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
/** 把一串 usage 加起来当会话汇总。 */
const summed = (series) => series.reduce((sum, usage) => ({
  ...Object.fromEntries(KEYS.map((key) => [key, sum[key] + usage[key]])),
  costUsd: (sum.costUsd ?? 0) + (usage.costUsd ?? 0),
  turns: sum.turns + 1,
}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, turns: 0 });
const usages = (trace) => trace.flatMap((item) => (item.event.kind === "usage" ? [item.event.usage] : []));

// 1. 回填改写过的 claude trace：每条本来就是真实增量 + delta 标记 → 原样显示。
{
  const deltas = [
    REAL[0],
    { input: 6, output: 5745, cacheRead: 412857, cacheWrite: 208488, reasoning: 0, costUsd: 3.306267, turns: 1 },
  ];
  const trace = traceOf(deltas, "delta");
  const out = normalizedPersistedTrace(trace, session("claude", summed(deltas)));
  assert.equal(out, trace, "已经是真实增量，读侧一个字节都不许动");
  assert.equal(total(usages(out)[1]), 627_096, "任务书点名那个气泡：真实 627,096");
}

// 2. **F4 的根治点**：同一批历史气泡，后面续聊一轮之后含义不许改变。
//    上一版靠「末条 == 会话汇总」判口径，续一轮就不成立，整条历史集体弹回累计值。
{
  const deltas = [
    REAL[0],
    { input: 6, output: 5745, cacheRead: 412857, cacheWrite: 208488, reasoning: 0, costUsd: 3.306267, turns: 1 },
  ];
  const before = normalizedPersistedTrace(traceOf(deltas, "delta"), session("claude", summed(deltas)));
  const resumed = [...deltas, { input: 10, output: 900, cacheRead: 5000, cacheWrite: 400, reasoning: 0, costUsd: 0.4, turns: 1 }];
  const after = normalizedPersistedTrace(traceOf(resumed, "delta"), session("claude", summed(resumed)));
  assert.equal(total(usages(before)[1]), total(usages(after)[1]), "续聊之后，第 2 个气泡显示的数字必须一字不变");
  assert.equal(
    usages(after).reduce((sum, usage) => sum + total(usage), 0),
    total(summed(resumed)),
    "各气泡之和 = 会话汇总：页面底部合计与右侧库里的数不许互相矛盾",
  );
}

// 3. 回填还没跑的 claude 旧 trace：全都标着 incremental，读侧判不出 → 原样返回（就是修
//    这个功能之前的样子）。气泡上那个数由回填去修，不在这里猜。
{
  const trace = traceOf(REAL);
  assert.equal(normalizedPersistedTrace(trace, session("claude", summed(REAL))), trace);
  assert.equal(
    normalizedPersistedTrace(trace, session("claude", { ...REAL.at(-1), turns: REAL.length })),
    trace,
    "**哪怕末条恰好等于会话汇总**也不许动：那个恒等式不是口径证据（F4）",
  );
}

// 4. 跨 ash 会话行续聊的那一半 trace：它永远凑不出任何恒等式，照样原样返回。
{
  const trace = traceOf(REAL.slice(2), "delta");
  assert.equal(normalizedPersistedTrace(trace, session("claude", summed(REAL))), trace);
}

// 5. 会话行不报账（历史会话 / 不报账的 CLI）：没有汇总可比，照样不影响逐条判定。
{
  const trace = traceOf(REAL, "delta");
  assert.equal(normalizedPersistedTrace(trace, session("claude", null)), trace);
}

// 6. codex 那条老路不许在重构里走丢：没有 accounting 标记的旧 trace 照旧求差，
//    有标记的（含新加的 delta / snapshot）照旧不动。
{
  const out = usages(normalizedPersistedTrace(traceOf(REAL, null), session("codex", null)));
  assert.equal(total(out[1]), 627_096, "codex 旧 trace 仍按标记缺失判定，与会话汇总无关");
  assert.equal(out[1].costUsd, null, "codex 不报价，求差后也不许垫一个数出来");
  for (const mark of ["incremental", "delta", "snapshot"]) {
    const marked = traceOf(REAL, mark);
    // codex 那一路是逐条按标记判的，所以这里只能比内容：它仍会原样 map 一遍整条 trace。
    assert.deepEqual(
      normalizedPersistedTrace(marked, session("codex", null)),
      marked,
      `标过 ${mark} 的 trace 不许再求一次差`,
    );
  }
}

// 7. 其它执行器一律不碰。
{
  const trace = traceOf(REAL);
  for (const agentType of ["opencode", "grok", "gemini"]) {
    assert.equal(normalizedPersistedTrace(trace, session(agentType, { ...REAL.at(-1), turns: REAL.length })), trace);
  }
}

console.log("trace 读侧换算通过：只认逐条标记、续聊不改变历史气泡、codex 老路未动");

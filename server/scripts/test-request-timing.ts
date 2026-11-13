// 输出速度的计时样本(TokenUsage.timed)从执行器一路走到界面,钉住三段:
//
// ① 请求边界。codex 从 rollout 算:起点 = 上一次收完与这期间写进来的输入里最晚的那个,
//    终点 = 这一次的 token_usage_record;app-server 通知里看不见的调用在 rollout 里照样有,
//    工具跑的时间一律不算成模型的时间;认不出的、缺时间戳的、压缩过的请求不计,坏行整回合
//    不计。claude 子智能体的请求跟主线程交错着到,要按线程分开配对;缺 ttft_ms 的整次不计。
// ② 服务端记账。累计口径求差之后的那份用量是新对象,计时样本得原样带回来,否则界面永远
//    见不到它;它也不进会话累计的库表。
// ③ shared 的累加与校验:两份相加时样本也相加;只有一边有时照样留着;坏形状的样本按坏行算。
//
// Run: npm -w server run test:usage
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-request-timing-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

const { ClaudeRequestTimer } = await import("../src/executors/request-timing.js");
const { codexTurnTiming, readCodexTurnTiming } = await import("../src/executors/codex-rollout-timing.js");
const { addUsage, isTokenUsage, outputRate } = await import("@ash/shared/usage");

try {
  // ── ① codex:rollout 行(形状取自 2026-11-13 的真实 rollout,时间换成从 0 起的秒数)
  const T0 = Date.parse("2026-11-13T04:24:46.000Z");
  const ts = (sec: number) => new Date(T0 + sec * 1_000).toISOString();
  const rec = (sec: number | null, type: string, payload: Record<string, unknown> = {}) =>
    JSON.stringify({ ...(sec === null ? {} : { timestamp: ts(sec) }), type, payload });
  const started = (sec: number, turn: string) => rec(sec, "event_msg", { type: "task_started", turn_id: turn });
  const item = (sec: number | null, type: string, extra: Record<string, unknown> = {}) => rec(sec, "response_item", { type, ...extra });
  const usage = (sec: number | null, out: number, turn = "turn-1") =>
    rec(sec, "token_usage_record", { thread_id: "thread-1", turn_id: turn, usage: { output_tokens: out } });
  const ui = (sec: number) => rec(sec, "event_msg", { type: "item_completed" });
  const turn1 = [
    started(0, "turn-1"),
    item(1, "message", { role: "developer" }),
    item(1, "message", { role: "user" }),
    rec(1.05, "world_state"),
    rec(1.05, "turn_context"),
    item(1.1, "message", { role: "user" }), // 输入齐了:第 1 次请求从这里发出
    ui(6),
    item(6, "message", { role: "assistant" }),
    item(9, "function_call", { name: "exec_command" }),
    usage(9.1, 173), // 第 1 次:1.1 → 9.1
    ui(9.15),
    item(9.2, "function_call_output"), // 第 2 次从这里发出
    item(16, "function_call", { name: "exec_command" }),
    usage(16.6, 135), // 第 2 次:9.2 → 16.6
    item(23, "function_call_output"), // 命令跑了 6 秒多,这段不算模型的
    item(25, "reasoning"),
    // app-server 通知里看不见的那种调用(往还在跑的命令里写输入):rollout 里照样有调用和结果。
    item(26, "function_call", { name: "write_stdin" }),
    usage(26.2, 37), // 第 3 次:23 → 26.2
    item(26.3, "function_call_output"),
    item(30, "message", { role: "assistant" }),
    usage(30.5, 50), // 第 4 次:26.3 → 30.5
  ];
  {
    const timing = codexTurnTiming(turn1, { turnId: "turn-1" });
    assert.deepEqual(timing, { timed: { output: 395, ms: 8_000 + 7_400 + 3_200 + 4_200 }, requests: 4 }, "起点 = 输入齐的时刻,终点 = 这一次记账;工具耗时一律不算");
  }

  // 工具在回复收尾之前就跑完了:它的结果归下一次请求,下一次最早也得等这一次收完才发。
  {
    const timing = codexTurnTiming([
      started(0, "turn-1"),
      item(1, "message", { role: "user" }),
      item(2, "function_call"),
      item(2.05, "function_call_output"),
      usage(3, 100), // 1 → 3
      item(5, "message", { role: "assistant" }),
      usage(6, 60), // 3 → 6
    ], { turnId: "turn-1" });
    assert.deepEqual(timing?.timed, { output: 160, ms: 2_000 + 3_000 });
  }

  // 请求窗口里有说不清的东西:只丢那一次,前后照常。
  for (const [name, odd] of [
    ["压缩过", rec(12, "compacted")],
    ["认不出的条目", item(12, "something_new")],
    ["认不出的消息角色", item(12, "message", { role: "narrator" })],
    ["输入缺时间戳", item(null, "function_call_output")],
    ["输出缺时间戳", item(null, "reasoning")],
  ] as const) {
    const timing = codexTurnTiming([
      started(0, "turn-1"),
      item(1, "message", { role: "user" }),
      item(2, "message", { role: "assistant" }),
      usage(3, 100), // 1 → 3,计
      item(11, "function_call_output"),
      odd,
      item(13, "reasoning"),
      usage(14, 999), // 这一次不计
      item(15, "function_call_output"),
      item(16, "message", { role: "assistant" }),
      usage(17, 50), // 15 → 17,计
    ], { turnId: "turn-1" });
    assert.deepEqual(timing?.timed, { output: 150, ms: 2_000 + 2_000 }, `${name}:只丢那一次`);
  }

  // 记账缺时间戳:这一次的终点、下一次的起点都没凭据,两次都不计。
  {
    const timing = codexTurnTiming([
      started(0, "turn-1"),
      item(1, "message", { role: "user" }),
      item(2, "message", { role: "assistant" }),
      usage(null, 100),
      item(4, "function_call_output"),
      item(5, "message", { role: "assistant" }),
      usage(6, 50),
      item(7, "function_call_output"),
      item(8, "message", { role: "assistant" }),
      usage(9, 30), // 7 → 9,计
    ], { turnId: "turn-1" });
    assert.deepEqual(timing, { timed: { output: 30, ms: 2_000 }, requests: 3 });
  }

  // 回合里有读不出来的行:整回合不计。
  assert.equal(codexTurnTiming([...turn1.slice(0, 5), "{not json", ...turn1.slice(5)], { turnId: "turn-1" }), null);

  // 选回合:按回合 id 只取那一回合;exec 拿不到 id,取起跑之后开始的最后一回合;都没有就是 null。
  {
    const turn2 = [started(40, "turn-2"), item(41, "message", { role: "user" }), item(42, "message", { role: "assistant" }), usage(44, 10, "turn-2")];
    const lines = [...turn1, ...turn2];
    assert.equal(codexTurnTiming(lines, { turnId: "turn-1" })?.timed?.output, 395);
    assert.deepEqual(codexTurnTiming(lines, { turnId: "turn-2" })?.timed, { output: 10, ms: 3_000 });
    assert.deepEqual(codexTurnTiming(lines, { latestSince: T0 + 30_000 })?.timed, { output: 10, ms: 3_000 });
    assert.equal(codexTurnTiming(lines, { latestSince: T0 + 50_000 }), null, "起跑之后没开过回合");
    assert.equal(codexTurnTiming(lines, { turnId: "turn-9" }), null);
    // 记账上写的回合不是这一回合:不认。
    assert.equal(codexTurnTiming([started(0, "turn-1"), item(1, "message", { role: "user" }), item(2, "reasoning"), usage(3, 10, "turn-x")], { turnId: "turn-1" })?.timed, undefined);
  }

  // 读盘:按 thread id 在这一回合的 CODEX_HOME 里找到 rollout。
  {
    const home = join(root, "codex-home");
    const dir = join(home, "sessions", "2026", "11", "13");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rollout-2026-11-13T12-24-45-thread-1.jsonl"), `${turn1.join("\n")}\n`);
    assert.deepEqual(await readCodexTurnTiming("thread-1", { turnId: "turn-1" }, home, 4), { output: 395, ms: 22_800 });
    assert.equal(await readCodexTurnTiming("thread-2", { turnId: "turn-1" }, home), undefined, "找不到 rollout 就是没有速度");
  }

  // ── ① claude:message_start(带 ttft_ms)/ message_delta / message_stop,子智能体交错
  {
    const t = new ClaudeRequestTimer();
    const se = (type: string, at: number, opts: { ttft?: number; output?: number; parent?: string } = {}) => t.event({
      type: "stream_event",
      parent_tool_use_id: opts.parent ?? null,
      ...(opts.ttft !== undefined ? { ttft_ms: opts.ttft } : {}),
      event: { type, ...(opts.output !== undefined ? { usage: { output_tokens: opts.output } } : {}) },
    }, at);

    se("message_start", 3_000, { ttft: 2_000 });
    se("message_start", 3_500, { ttft: 500, parent: "toolu_sub" });
    se("message_delta", 6_000, { output: 300 });
    se("message_delta", 6_500, { output: 90, parent: "toolu_sub" });
    se("message_stop", 6_100);
    se("message_stop", 6_600, { parent: "toolu_sub" });
    // 起点不明(fork 不报 ttft_ms)的请求不计。
    se("message_start", 10_000);
    se("message_delta", 12_000, { output: 999 });
    se("message_stop", 12_000);
    // 非 stream_event 一概不理。
    t.event({ type: "assistant", message: { usage: { output_tokens: 5 } } }, 13_000);

    assert.deepEqual(t.take(), { output: 390, ms: (6_100 - 1_000) + (6_600 - 3_000) }, "起点 = 首字到达倒推 ttft_ms,主线程与子智能体各配各的");
  }

  // ── ③ shared:累加、速度、校验
  {
    const base = { input: 1, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: null, turns: 1 };
    const timed = { ...base, timed: { output: 80, ms: 2_000 } };
    assert.equal("timed" in addUsage(base, base), false, "两边都没计上时,累加结果也不长出这个字段");
    assert.deepEqual(addUsage(base, timed).timed, { output: 80, ms: 2_000 });
    assert.deepEqual(addUsage(timed, timed).timed, { output: 160, ms: 4_000 });
    assert.equal(outputRate(timed), 40);
    assert.equal(outputRate(base), null);
    assert.equal(outputRate({ ...base, timed: { output: 0, ms: 0 } }), null);
    assert.equal(isTokenUsage(timed), true);
    assert.equal(isTokenUsage({ ...base, timed: { output: -1, ms: 10 } }), false);
    assert.equal(isTokenUsage({ ...base, timed: { output: 1 } }), false);
  }

  // ── ② 服务端记账:累计口径求差之后,计时样本原样带回;库表不记它
  {
    const { db, ensureSchema } = await import("../src/db/index.js");
    const { sessions } = await import("../src/db/schema.js");
    const { recordSessionUsageEvent } = await import("../src/usage.js");
    await ensureSchema();
    await db.insert(sessions).values({
      id: "timing-sess", taskId: "timing-task", role: "single", agentType: "codex", executor: "codex", startedAt: new Date().toISOString(),
    });
    const first = { input: 1_000, output: 300, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: null, turns: 1 };
    await recordSessionUsageEvent("timing-sess", { kind: "usage", usage: first }, "codex", "timing-thread", null);
    const second = await recordSessionUsageEvent(
      "timing-sess",
      { kind: "usage", usage: { ...first, input: 1_500, output: 420, timed: { output: 120, ms: 3_000 } } },
      "codex",
      "timing-thread",
      null,
    );
    assert.equal(second.usage.output, 120, "累计快照照常求差");
    assert.deepEqual(second.usage.timed, { output: 120, ms: 3_000 }, "求差之后计时样本还在");
    const plain = await recordSessionUsageEvent("timing-sess", { kind: "usage", usage: { ...first, input: 1_600, output: 500 } }, "codex", "timing-thread", null);
    assert.equal("timed" in plain.usage, false, "没计上时的回合不凭空长出样本");
  }

  console.log("test-request-timing: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

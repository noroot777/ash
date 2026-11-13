// 输出速度的计时样本(TokenUsage.timed)从执行器一路走到界面,钉住三段:
//
// ① 请求边界。codex 的工具结果可能落在用量通知之前,也可能之后(长命令跑着时用量就到了);
//    两种顺序下,工具跑的时间都不能算成模型的时间。claude 子智能体的请求跟主线程交错着到,
//    要按线程分开配对;缺 ttft_ms 的请求起点不明,整次不计。
// ② 服务端记账。累计口径求差之后的那份用量是新对象,计时样本得原样带回来,否则界面永远
//    见不到它;它也不进会话累计的库表。
// ③ shared 的累加与校验:两份相加时样本也相加;只有一边有时照样留着;坏形状的样本按坏行算。
//
// Run: npm -w server run test:usage
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-request-timing-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

const { ClaudeRequestTimer, CodexRequestTimer } = await import("../src/executors/request-timing.js");
const { addUsage, isTokenUsage, outputRate } = await import("@ash/shared/usage");

try {
  // ── ① codex:真实通知顺序(取自 2026-11-13 的 app-server 原始输出,时间戳换成小整数)
  {
    const t = new CodexRequestTimer();
    const item = (method: string, type: string, at: number) =>
      t.notification(method, { item: { type }, [method === "item/started" ? "startedAtMs" : "completedAtMs"]: at });
    const usage = (outputTokens: number) => t.notification("thread/tokenUsage/updated", { tokenUsage: { last: { outputTokens } } });

    item("item/started", "userMessage", 0);
    item("item/completed", "userMessage", 0);
    // 第 1 次请求:先说一句话再调命令,命令瞬间跑完,用量随后到。
    item("item/started", "agentMessage", 5_000);
    item("item/completed", "agentMessage", 5_100);
    item("item/started", "commandExecution", 8_000); // 模型写完调用 = 这次请求的终点
    item("item/completed", "commandExecution", 8_010); // 结果回来 = 下次请求的起点
    usage(160);
    // 第 2 次请求:命令跑了 6 秒,用量在命令跑着时就到了。
    item("item/started", "reasoning", 15_010);
    item("item/completed", "reasoning", 17_000);
    item("item/started", "commandExecution", 18_010);
    usage(200);
    item("item/completed", "commandExecution", 24_010);
    // 第 3 次请求:只有一个工具调用,没有思考也没有正文。
    item("item/started", "commandExecution", 29_010);
    item("item/completed", "commandExecution", 29_020);
    usage(40);

    assert.deepEqual(t.take(), { output: 400, ms: 8_000 + 10_000 + 5_000 }, "起点 = 输入齐的时刻,终点 = 模型最后写出的东西;工具耗时一律不算");
    assert.equal(t.take(), undefined, "take 之后清零");

    // 新回合:上一回合残留的「输入齐了」时刻不能当成这一回合第一次请求的起点。
    item("item/started", "agentMessage", 40_000);
    usage(50);
    assert.equal(t.take(), undefined, "看不见起点(接管、缺用户消息)的请求整次不计");
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

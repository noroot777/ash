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
  const codexTimer = () => {
    const t = new CodexRequestTimer();
    // at 传 null = 这条通知没带时间戳。
    const item = (method: "item/started" | "item/completed", type: string, id: string | null, at: number | null) =>
      t.notification(method, {
        item: { type, ...(id ? { id } : {}) },
        ...(at === null ? {} : { [method === "item/started" ? "startedAtMs" : "completedAtMs"]: at }),
      });
    const usage = (outputTokens: number) => t.notification("thread/tokenUsage/updated", { tokenUsage: { last: { outputTokens } } });
    return { t, start: (type: string, id: string | null, at: number | null) => item("item/started", type, id, at),
      done: (type: string, id: string | null, at: number | null) => item("item/completed", type, id, at), usage };
  };
  {
    const { t, start, done, usage } = codexTimer();
    start("userMessage", "u", 0);
    done("userMessage", "u", 0);
    // 第 1 次请求:先说一句话再调命令,命令瞬间跑完,用量随后到。
    start("agentMessage", "m1", 5_000);
    done("agentMessage", "m1", 5_100);
    start("commandExecution", "c1", 8_000); // 模型写完调用 = 这次请求的终点
    done("commandExecution", "c1", 8_010); // 结果回来 = 下次请求的起点
    usage(160);
    // 第 2 次请求:命令跑了 6 秒,用量在命令跑着时就到了。
    start("reasoning", "r2", 15_010);
    done("reasoning", "r2", 17_000);
    start("commandExecution", "c2", 18_010);
    usage(200);
    done("commandExecution", "c2", 24_010);
    // 第 3 次请求:只有一个工具调用,没有思考也没有正文。
    start("commandExecution", "c3", 29_010);
    done("commandExecution", "c3", 29_020);
    usage(40);

    assert.deepEqual(t.take(), { output: 400, ms: 8_000 + 10_000 + 5_000 }, "起点 = 输入齐的时刻,终点 = 模型最后写出的东西;工具耗时一律不算");
    assert.equal(t.take(), undefined, "take 之后清零");

    // 新回合:上一回合残留的「输入齐了」时刻不能当成这一回合第一次请求的起点。
    start("agentMessage", "m4", 40_000);
    done("agentMessage", "m4", 41_000);
    usage(50);
    assert.equal(t.take(), undefined, "看不见起点(接管、缺用户消息)的请求整次不计");
  }

  // 同一次回复里两个工具串行:后一个等前一个跑完才开始,它的开始不是「模型刚写完」的凭据。
  for (const firstToolMs of [0, 10_000]) {
    const { t, start, done, usage } = codexTimer();
    done("userMessage", "u", 0);
    start("reasoning", "r", 1_000);
    done("reasoning", "r", 2_000);
    start("commandExecution", "a", 2_000);
    done("commandExecution", "a", 2_000 + firstToolMs);
    start("commandExecution", "b", 2_000 + firstToolMs);
    done("commandExecution", "b", 2_000 + firstToolMs);
    usage(100);
    assert.equal(t.take(), undefined, `工具已经跑完之后才冒出来的东西分不清是在写还是在排队,整次不计(前一个工具 ${firstToolMs}ms)`);
  }

  // 同一次回复里并行开出去的两个工具:都在任何一个跑完之前开始,最后那个开始就是终点。
  {
    const { t, start, done, usage } = codexTimer();
    done("userMessage", "u", 0);
    start("commandExecution", "a", 1_000);
    start("commandExecution", "b", 1_500);
    done("commandExecution", "a", 9_000);
    done("commandExecution", "b", 9_000);
    usage(60);
    assert.deepEqual(t.take(), { output: 60, ms: 1_500 });
  }

  // 模型条目缺终点:收尾通知没带时间戳 / 收尾通知压根没来。
  for (const ending of ["untimed", "missing"] as const) {
    const { t, start, done, usage } = codexTimer();
    done("userMessage", "u", 0);
    start("agentMessage", "m", 1_000);
    if (ending === "untimed") done("agentMessage", "m", null);
    usage(100);
    assert.equal(t.take(), undefined, `模型条目结束时间未知(${ending}),整次不计`);
  }

  // 起点缺凭据:工具结果没带时间戳,下一次请求不能捡上上次的「输入齐了」当起点;用过的起点作废。
  {
    const { t, start, done, usage } = codexTimer();
    done("userMessage", "u", 0);
    start("reasoning", "r1", 1_000);
    done("reasoning", "r1", 1_500);
    start("commandExecution", "a", 2_000);
    usage(100);
    done("commandExecution", "a", null);
    start("reasoning", "r2", 12_000);
    done("reasoning", "r2", 13_000);
    usage(100);
    assert.deepEqual(t.take(), { output: 100, ms: 2_000 }, "只留起止完整的第一次请求");
  }
  {
    const { t, start, done, usage } = codexTimer();
    done("userMessage", "u", 0);
    start("agentMessage", "m1", 1_000);
    done("agentMessage", "m1", 2_000);
    usage(100);
    // 上一次请求没开工具,这一次之前也没有新的输入时刻。
    start("agentMessage", "m2", 5_000);
    done("agentMessage", "m2", 6_000);
    usage(100);
    assert.deepEqual(t.take(), { output: 100, ms: 2_000 }, "起点用过一次就作废");
  }
  {
    const { t, start, done, usage } = codexTimer();
    done("userMessage", "u", 0);
    start("agentMessage", "m1", 1_000);
    done("agentMessage", "m1", 2_000);
    usage(100);
    done("userMessage", "u2", null); // 中途插话没带时间戳:不能退回去用更早的时刻
    start("agentMessage", "m2", 5_000);
    done("agentMessage", "m2", 6_000);
    usage(100);
    assert.deepEqual(t.take(), { output: 100, ms: 2_000 }, "输入时刻缺凭据的那次请求不计");
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

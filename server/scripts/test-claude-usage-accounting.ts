// claude 的 result 是**线程累计快照**，不是本轮增量 —— 这个文件钉住这件事的三面。
//
// 为什么要单独一个文件而不是塞进 test-usage-accounting.ts：那一份的立论就是「Claude 的
// result 是本轮增量」，这次是把那条前提推翻。两件事分开钉，下一个人改坏哪一边都看得出
// 是哪一边。
//
// ① **口径**：claude 和 codex 都按 CLI 线程求差；拿不到线程 id 退回逐轮相加；claude 的
//    那些 fork（走同一套 stream-json 的 opencode/grok…）刻意**不**跟着改。
// ② **换算**：数字不是编的，用的是实测会话 wkfsPOl_xgRe 连续回合的真 `result` 行
//    （data/runs/r3Ef3onEym4s/*.agent-out.jsonl）。任务书点名那一对的差值是 627,096 —— 那
//    一回合只有 2 次工具调用，63 万才是真实用量，而账本原先记的是 70,134,875。
// ③ **回填**：历史重算只动 claude、只动能证明是累计口径的那些；证据不足就不动并留一条
//    待建基线，免得下一次续聊把整条线程再加一遍。
//
// Run: npm -w server run test:usage
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TokenUsage } from "@ash/shared";

const root = mkdtempSync(join(tmpdir(), "ash-claude-usage-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

const { db, ensureSchema } = await import("../src/db/index.js");
const { sessions, usageCumulativeSnapshots } = await import("../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { recordSessionUsageEvent, sessionUsage, usageAccountingFor } = await import("../src/usage.js");
const { planClaudeUsageRepair, applyClaudeUsageRepair } = await import("../src/claude-usage-repair.js");
const { appendSessionTrace } = await import("../src/transcript.js");
const { usageTotal } = await import("@ash/shared/usage");

/** 实测 wkfsPOl_xgRe 的连续 `result` 行（modelUsage 四项求和，cost 是 total_cost_usd）。 */
const REAL: TokenUsage[] = [
  { input: 9339, output: 394_520, cacheRead: 63_298_503, cacheWrite: 5_805_417, reasoning: 0, costUsd: 155.68560549999995, turns: 1 },
  { input: 9345, output: 400_265, cacheRead: 63_711_360, cacheWrite: 6_013_905, reasoning: 0, costUsd: 158.99187249999994, turns: 1 },
  { input: 9359, output: 408_827, cacheRead: 65_221_499, cacheWrite: 6_027_226, reasoning: 0, costUsd: 161.09676399999995, turns: 1 },
  { input: 9373, output: 417_632, cacheRead: 66_824_793, cacheWrite: 6_040_299, reasoning: 0, costUsd: 163.30386049999996, turns: 1 },
  { input: 9385, output: 422_699, cacheRead: 68_299_267, cacheWrite: 6_064_329, reasoning: 0, costUsd: 165.33217949999994, turns: 1 },
];
const at = (index: number) => `2026-10-27T1${index}:00:00.000Z`;

const insertSession = async (over: Partial<typeof sessions.$inferInsert> & { id: string; taskId: string }) =>
  db.insert(sessions).values({
    role: "single",
    agentType: "claude",
    executor: "claude",
    startedAt: "2026-10-26T10:23:22.331Z",
    ...over,
  });

const readUsage = async (id: string) =>
  sessionUsage((await db.select().from(sessions).where(eq(sessions.id, id)).get())!);

try {
  await ensureSchema();

  // ── ① 口径表 ─────────────────────────────────────────────────────────────
  assert.deepEqual(
    usageAccountingFor("claude", "24d01034-c942-4921-a30f-740a368f6578"),
    { kind: "cumulative", sourceId: "claude:24d01034-c942-4921-a30f-740a368f6578" },
    "claude 也必须走线程累计求差 —— 这条就是本次修复的全部内容",
  );
  assert.deepEqual(
    usageAccountingFor("codex", "019fd0fd-432e-7fd3-969e-5efbb747ad30"),
    { kind: "cumulative", sourceId: "codex:019fd0fd-432e-7fd3-969e-5efbb747ad30" },
    "codex 的 sourceId 前缀不许在重构中漂移：历史快照行是按它存的",
  );
  assert.deepEqual(usageAccountingFor("claude", null), { kind: "incremental" });
  assert.deepEqual(usageAccountingFor("claude", ""), { kind: "incremental" }, "空串不是线程身份");
  assert.deepEqual(usageAccountingFor("codex", undefined), { kind: "incremental" });
  for (const fork of ["opencode", "grok", "cursor", "gemini", "qwen"] as const) {
    assert.deepEqual(
      usageAccountingFor(fork, "thread-1"),
      { kind: "incremental" },
      `${fork} 继承的是 claude 的输出 schema，不等于继承这版累计语义；没实测过就不改它的账`,
    );
  }

  // ── ② 换算：真实连续回合 ─────────────────────────────────────────────────
  const thread = "24d01034-c942-4921-a30f-740a368f6578";
  await insertSession({ id: "live-1", taskId: "task-live", cliSessionId: thread });

  const first = await recordSessionUsageEvent("live-1", { kind: "usage", usage: REAL[0]! }, "claude", thread);
  assert.equal(
    usageTotal(first.usage),
    69_507_779,
    "线程还没有快照（fresh run 首轮）时整份就是增量，两种口径在这一轮本来相同",
  );
  assert.equal(first.usage.costUsd, 155.68560549999995);

  const second = await recordSessionUsageEvent("live-1", { kind: "usage", usage: REAL[1]! }, "claude", thread);
  assert.deepEqual(
    { ...second.usage, costUsd: null },
    { input: 6, output: 5_745, cacheRead: 412_857, cacheWrite: 208_488, reasoning: 0, costUsd: null, turns: 1 },
    "任务书点名那一回合：真实用量 627,096，而不是 result 行上的 70,134,875",
  );
  assert.equal(usageTotal(second.usage), 627_096);
  assert.ok(
    Math.abs(second.usage.costUsd! - (158.99187249999994 - 155.68560549999995)) < 1e-9,
    "费用同样是累计值，要跟着求差（$158.99 - $155.69 ≈ $3.31，不是 $158.99）",
  );
  assert.equal(second.accounting, "incremental", "落 trace 的必须是已归一的增量，读侧不能再求一次差");

  const third = await recordSessionUsageEvent("live-1", { kind: "usage", usage: REAL[2]! }, "claude", thread);
  assert.equal(usageTotal(third.usage), 71_666_911 - 70_134_875);
  assert.equal(
    usageTotal((await readUsage("live-1"))!),
    71_666_911,
    "三轮之后会话账面 = 最后一份累计快照。按旧口径相加会是 2.1 亿",
  );
  assert.ok(
    Math.abs((await readUsage("live-1"))!.costUsd! - 161.09676399999995) < 1e-6,
    "费用也应收敛到最后那份 total_cost_usd",
  );

  // 同一条 CLI 线程被第二条 ash 会话续聊（审查旁路回合 / duet 各声部）：差值要接着算。
  await insertSession({ id: "live-2", taskId: "task-live", cliSessionId: thread, role: "reviewer", sideTurn: true });
  const handover = await recordSessionUsageEvent("live-2", { kind: "usage", usage: REAL[3]! }, "claude", thread);
  assert.equal(
    usageTotal(handover.usage),
    73_292_097 - 71_666_911,
    "快照按 CLI 线程存，所以换到另一条 ash 会话接着跑时差值仍然对",
  );
  assert.equal(usageTotal((await readUsage("live-1"))!), 71_666_911, "上一条会话的账不许被续聊的回合改动");

  // CLI 换线程（压缩/续聊拿到新 session_id）→ 新 sourceId 没有快照 → 整份入账。
  const rotated = await recordSessionUsageEvent(
    "live-2", { kind: "usage", usage: { ...REAL[0]!, costUsd: 1.5 } }, "claude", "new-thread-after-compact",
  );
  assert.equal(usageTotal(rotated.usage), 69_507_779, "换了线程 id 就是新线程第一轮，整份是增量");

  // 同一个 id 上计数器回退（CLI 重置账本）→ reset 分支整份入账。
  await insertSession({ id: "live-3", taskId: "task-live", cliSessionId: "reset-thread" });
  await recordSessionUsageEvent("live-3", { kind: "usage", usage: REAL[2]! }, "claude", "reset-thread");
  const afterReset = await recordSessionUsageEvent("live-3", { kind: "usage", usage: REAL[0]! }, "claude", "reset-thread");
  assert.equal(usageTotal(afterReset.usage), 69_507_779, "值比上一份小 = 账本被重置，整份入账而不是算出负数");

  // 没有线程 id 的 claude 回合仍按逐轮相加（没有「上一份快照」可言）。
  await insertSession({ id: "live-4", taskId: "task-live", cliSessionId: null });
  await recordSessionUsageEvent("live-4", { kind: "usage", usage: REAL[0]! }, "claude", null);
  await recordSessionUsageEvent("live-4", { kind: "usage", usage: REAL[1]! }, "claude", null);
  assert.equal(
    usageTotal((await readUsage("live-4"))!),
    69_507_779 + 70_134_875,
    "拿不到线程身份只能逐轮加，求差会把别人的账算进来",
  );

  // ── ③ 回填 ───────────────────────────────────────────────────────────────
  // 四类历史会话 + 一条 codex 对照，各自落一份真形状的 trace。
  const seed = async (
    id: string,
    taskId: string,
    cli: string | null,
    series: TokenUsage[],
    over: Partial<typeof sessions.$inferInsert> = {},
    traceCount = series.length,
  ) => {
    const booked = series.reduce((sum, usage) => ({
      input: sum.input + usage.input,
      output: sum.output + usage.output,
      cacheRead: sum.cacheRead + usage.cacheRead,
      cacheWrite: sum.cacheWrite + usage.cacheWrite,
      reasoning: sum.reasoning + usage.reasoning,
      costUsd: (sum.costUsd ?? 0) + (usage.costUsd ?? 0),
      turns: sum.turns + 1,
    }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, turns: 0 } as TokenUsage);
    await insertSession({
      id,
      taskId,
      cliSessionId: cli,
      startedAt: at(0),
      usageInput: booked.input,
      usageOutput: booked.output,
      usageCacheRead: booked.cacheRead,
      usageCacheWrite: booked.cacheWrite,
      usageReasoning: booked.reasoning,
      usageCostUsd: booked.costUsd,
      usageTurns: series.length,
      ...over,
    });
    series.slice(0, traceCount).forEach((usage, index) => {
      appendSessionTrace(taskId, id, at(index), { kind: "usage", usage, accounting: "incremental" }, at(index));
    });
    return booked;
  };

  // 时间顺序照着真实历史摆：旧 CLI 的逐轮增量在前，升级后的线程累计在后。
  // (a) 逐轮增量口径（旧 CLI，序列上下起伏）→ 强证据。
  const bumpy = [REAL[2]!, REAL[0]!, REAL[3]!, REAL[1]!, REAL[4]!];
  const bumpyBooked = await seed("hist-incremental", "hist-a", "thread-incremental", bumpy, { startedAt: at(0) });
  // (b) 只有两轮、恰好递增：单调性在这里没有分辨力（实测 45 条两轮会话里 6 条会误判），
  //     要靠日期落到分界线之前 → 仍按逐轮增量，不许动它的账。
  const weakOld = await seed("hist-weak-old", "hist-b", "thread-weak-old", [REAL[0]!, REAL[1]!], { startedAt: at(1) });
  // (c) 累计口径、强证据（5 轮全不降）→ 它的起始时刻就是分界线。
  const inflated = await seed("hist-cumulative", "hist-c", "thread-cumulative", REAL, { startedAt: at(2) });
  // (d) 同样两轮递增，但落在分界线之后 → 按累计口径重算。
  await seed("hist-weak-new", "hist-d", "thread-weak-new", [REAL[0]!, REAL[1]!], { startedAt: at(3) });
  // (e) 只有一轮：两种口径数值相同，不该被改。
  const single = await seed("hist-single", "hist-e", "thread-single", [REAL[0]!], { startedAt: at(4) });
  // (f) trace 条数与库里轮数对不上：重算不了。
  await seed("hist-broken", "hist-f", "thread-broken", REAL, { startedAt: at(5) }, 3);
  // (g) codex 对照：这个脚本一行都不许碰它。
  const codexBooked = await seed("hist-codex", "hist-g", "thread-codex", REAL, {
    agentType: "codex", executor: "codex", startedAt: at(6),
  });

  const plan = await planClaudeUsageRepair({ cutoff: null });
  assert.equal(
    plan.boundary.lastIncremental,
    at(0),
    "分界线的下沿 = 最后一条「强证据是逐轮增量」的会话",
  );
  assert.equal(
    plan.boundary.firstCumulative,
    at(2),
    "分界线的上沿 = 最早一条「强证据是线程累计」的会话；证据不足的会话靠它分档",
  );
  assert.equal(plan.boundary.clean, true);
  assert.deepEqual(plan.warnings, []);

  const planOf = (id: string) => plan.sessions.find((item) => item.sessionId === id)!;
  assert.equal(planOf("hist-cumulative").regime, "cumulative");
  assert.equal(planOf("hist-cumulative").evidence, "strong");
  assert.equal(
    usageTotal(planOf("hist-cumulative").after!),
    usageTotal(REAL[4]!),
    "累计口径的会话重算后 = 最后一份累计快照（各轮增量之和的恒等式）",
  );
  assert.ok(
    usageTotal(inflated) / usageTotal(planOf("hist-cumulative").after!) > 4,
    "原账面确实是几倍虚高，不然这个用例就什么都没在测",
  );
  assert.equal(planOf("hist-incremental").regime, "incremental");
  assert.equal(planOf("hist-incremental").after, null, "逐轮增量口径的历史账本来就是对的，不许动");
  assert.equal(planOf("hist-weak-old").regime, "incremental");
  assert.equal(planOf("hist-weak-old").evidence, "weak-date");
  assert.equal(
    planOf("hist-weak-old").after,
    null,
    "两轮递增不足以证明是累计口径：它落在分界线之前，按日期判成逐轮增量，账不动",
  );
  assert.equal(planOf("hist-weak-new").regime, "cumulative");
  assert.equal(planOf("hist-weak-new").evidence, "weak-date");
  assert.equal(usageTotal(planOf("hist-weak-new").after!), usageTotal(REAL[1]!));
  assert.equal(planOf("hist-single").regime, "cumulative");
  assert.equal(planOf("hist-single").evidence, "single-turn");
  assert.equal(planOf("hist-single").after, null, "一轮的会话两种口径同值，也不该写一遍");
  assert.match(planOf("hist-broken").skipped!, /对不上/);
  assert.equal(planOf("hist-broken").after, null);
  assert.equal(plan.sessions.some((item) => item.sessionId === "hist-codex"), false, "codex 会话不该进 claude 的计划");

  const snapshotOf = (sourceId: string) => plan.snapshots.find((item) => item.sourceId === sourceId)!;
  assert.deepEqual(snapshotOf("claude:thread-cumulative").usage, REAL[4]!, "续聊这条线程要靠这份累计基线求差");
  assert.equal(snapshotOf("claude:thread-cumulative").baselineReady, true);
  assert.equal(snapshotOf("claude:thread-incremental").baselineReady, false,
    "旧口径的数字拼不出累计基线，只能留待建基线，不许猜一个");
  assert.equal(snapshotOf("claude:thread-broken").baselineReady, false);
  assert.equal(plan.snapshots.some((item) => item.sourceId.startsWith("codex:")), false);
  // 运行期已经维护着快照的线程（上面 live-1 那条）不许被计划覆盖。
  assert.equal(plan.snapshots.some((item) => item.sourceId === `claude:${thread}`), false);

  const applied = await applyClaudeUsageRepair(plan);
  assert.equal(applied.sessions, 2, "该改的只有 hist-cumulative 与 hist-weak-new 两条");
  assert.equal(usageTotal((await readUsage("hist-cumulative"))!), usageTotal(REAL[4]!));
  assert.equal(usageTotal((await readUsage("hist-incremental"))!), usageTotal(bumpyBooked));
  assert.equal(usageTotal((await readUsage("hist-weak-old"))!), usageTotal(weakOld));
  assert.equal(usageTotal((await readUsage("hist-single"))!), usageTotal(single));
  assert.equal(usageTotal((await readUsage("hist-codex"))!), usageTotal(codexBooked), "codex 的账一个字节都不许动");
  assert.equal(
    (await db.select().from(usageCumulativeSnapshots).where(eq(usageCumulativeSnapshots.sourceId, `claude:${thread}`)).get())!.input,
    REAL[3]!.input,
    "运行期那条快照必须还是运行期写的那一份",
  );

  // 再跑一次：历史已经对了，计划应该是空的（手工脚本没有一次性闸，必须自身幂等）。
  const again = await planClaudeUsageRepair({ cutoff: null });
  assert.equal(again.sessions.filter((item) => item.after).length, 0, "回填必须幂等");
  assert.equal(again.snapshots.length, 0, "快照已经建好，第二遍不该再建");

  // 跨 cutoff：前四条还是累计快照，第五条已经是修好的代码写下的真增量。
  const liveDelta = { ...REAL[0]!, input: 7, output: 11, cacheRead: 13, cacheWrite: 17, costUsd: 0.5 };
  const straddleSeries = [REAL[0]!, REAL[1]!, REAL[2]!, REAL[3]!, liveDelta];
  await seed("hist-straddle", "hist-h", "thread-straddle", straddleSeries, { startedAt: at(2) });
  const straddlePlan = await planClaudeUsageRepair({ cutoff: at(4) });
  const straddle = straddlePlan.sessions.find((item) => item.sessionId === "hist-straddle")!;
  assert.equal(straddle.straddlesCutoff, true);
  assert.equal(straddle.evidence, "strong", "cutoff 之前仍有 4 条，够强证据");
  assert.equal(
    usageTotal(straddle.after!),
    usageTotal(REAL[3]!) + 7 + 11 + 13 + 17,
    "cutoff 之前按累计求差（之和 = 最后一份累计），之后原样计入",
  );
  assert.equal(straddle.rebasedFirstTurnAfterCutoff, false, "后半截是真增量，不该被当成累计快照再求一次差");
  assert.equal(
    straddlePlan.snapshots.some((item) => item.sourceId === "claude:thread-straddle"),
    false,
    "这条线程改口径之后已经跑过回合，快照归运行期维护",
  );

  // 「先重启、后回填」留下的那一轮：改口径之后这条线程的第一回合没有快照可比，修好的代码
  // 也会把整份累计值记一次。它在 trace 里就是一份完整累计快照，必须认出来并补掉。
  const rebaseSeries = [REAL[0]!, REAL[1]!, REAL[2]!, REAL[3]!, REAL[4]!];
  await seed("hist-rebase", "hist-i", "thread-rebase", rebaseSeries, { startedAt: at(2) });
  const rebasePlan = await planClaudeUsageRepair({ cutoff: at(4) });
  const rebase = rebasePlan.sessions.find((item) => item.sessionId === "hist-rebase")!;
  assert.equal(rebase.rebasedFirstTurnAfterCutoff, true);
  assert.equal(
    usageTotal(rebase.after!),
    usageTotal(REAL[4]!),
    "补掉那一轮之后，整条会话仍收敛到最后一份累计值",
  );

  console.log("claude 账本验证通过：线程累计求差、真实连续回合换算、历史回填与幂等、cutoff 分段");
} finally {
  rmSync(root, { recursive: true, force: true });
}

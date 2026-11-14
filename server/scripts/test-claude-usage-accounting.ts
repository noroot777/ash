// claude 的 result 是**线程累计快照**，不是本轮增量 —— 这个文件钉住这件事的两面。
//
// 为什么要单独一个文件而不是塞进 test-usage-accounting.ts：那一份的立论就是「Claude 的
// result 是本轮增量」，这次是把那条前提推翻。两件事分开钉，下一个人改坏哪一边都看得出
// 是哪一边。
//
// ① **口径**：claude 和 codex 都按 CLI 线程求差；拿不到线程 id 退回逐轮相加；claude 的
//    那些 fork（走同一套 stream-json 的 opencode/grok…）刻意**不**跟着改。落盘要带上
//    「这一份怎么来的」那个标记（delta / snapshot / incremental）。
// ② **换算**：数字不是编的，用的是实测会话 wkfsPOl_xgRe 连续回合的真 `result` 行
//    （data/runs/r3Ef3onEym4s/*.agent-out.jsonl）。任务书点名那一对的差值是 627,096 —— 那
//    一回合只有 2 次工具调用，63 万才是真实用量，而账本原先记的是 70,134,875。
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
const { sessions } = await import("../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { recordSessionUsageEvent, sessionUsage, usageAccountingFor } = await import("../src/usage.js");
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
    first.accounting,
    "snapshot",
    "没有基线时整份入账，标记必须说出这件事",
  );
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
  assert.equal(second.accounting, "delta", "有基线、求过差 → 标记必须是 delta，读侧认它");

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

  // 没有线程身份的 claude 回合，标记也得如实说「这是执行器报的单轮值」。
  const orphan = await recordSessionUsageEvent("live-4", { kind: "usage", usage: REAL[2]! }, "claude", null);
  assert.equal(orphan.accounting, "incremental");

  console.log("claude 账本验证通过：线程累计求差、真实连续回合换算、逐条口径标记");
} finally {
  rmSync(root, { recursive: true, force: true });
}

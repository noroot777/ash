// claude 的 result 是**线程累计快照**，不是本轮增量 —— 这个文件钉住这件事的三面。
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
// ③ **回填**：历史重算只动 claude、只动能证明是累计口径的那些；判不出就明确跳过并留一条
//    待建基线，免得下一次续聊把整条线程再加一遍。
//
// ③ 下面这几条是第 1 轮审查打回的那几个洞，各自一条用例，别删：
//    - **分界不看时间戳**：线程的快照 `updated_at` 每回合都被覆盖，拿它当分界会随续聊
//      往后漂，已归一的新记录被塞回旧账堆里，整条线程被判成「本来就是增量」而原样留着
//      虚高的账。现在分界是逐条的落盘标记（hist-drift）。
//    - **不凭数值大小改首轮**：只有标记是 `snapshot`（累计口径 + 当时没有基线）才补求差；
//      一个已归一的大增量哪怕「五项全不降」也不许再减一次（hist-settled / hist-rebase）。
//    - **形状判不出就跳过**：累计序列中途重置（A,B,A,B）既不是「全不降」也不是「隔轮下降」，
//      不许当成铁证判成增量；真·增量序列碰巧全升同理（hist-reset / hist-rising-old）。
//
// Run: npm -w server run test:usage
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
const { planClaudeUsageRepair, applyClaudeUsageRepair, CLI_CUMULATIVE_SINCE, shapeRegime } = await import("../src/claude-usage-repair.js");
const { readUsageTrace, TRACE_BACKUP_SUFFIX } = await import("../src/claude-usage-trace.js");
const { sessionTracePath } = await import("../src/transcript.js");
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
    first.accounting,
    "snapshot",
    "没有基线时整份入账，标记必须说出这件事 —— 历史回填凭它(而不是凭数值大小)判要不要补求差",
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
  assert.equal(second.accounting, "delta", "有基线、求过差 → 标记必须是 delta，读侧和回填都认它");

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

  // ── ③ 回填 ───────────────────────────────────────────────────────────────
  // 另一条真实序列：同一条 CLI 线程连续 7 个回合的 `result`（审查复现用的就是这 7 个数，
  // 合计 16,444,888 → 28,486,599）。累计口径下「各轮增量之和 = 最后一份累计值」。
  const SERIES: TokenUsage[] = [
    { input: 3311, output: 119_470, cacheRead: 14_987_796, cacheWrite: 1_334_311, reasoning: 0, costUsd: 37.67329350000002, turns: 1 },
    { input: 3325, output: 127_198, cacheRead: 15_769_197, cacheWrite: 1_364_737, reasoning: 0, costUsd: 39.22155950000002, turns: 1 },
    { input: 3386, output: 169_744, cacheRead: 20_858_547, cacheWrite: 1_439_542, reasoning: 0, costUsd: 47.373882, turns: 1 },
    { input: 3400, output: 180_410, cacheRead: 22_133_472, cacheWrite: 1_664_239, reasoning: 0, costUsd: 51.990959499999995, turns: 1 },
    { input: 3408, output: 184_785, cacheRead: 23_048_420, cacheWrite: 1_671_956, reasoning: 0, costUsd: 53.221199999999996, turns: 1 },
    { input: 3424, output: 195_334, cacheRead: 24_780_277, cacheWrite: 1_929_225, reasoning: 0, costUsd: 58.6965295, turns: 1 },
    { input: 3436, output: 200_163, cacheRead: 26_088_990, cacheWrite: 2_194_010, reasoning: 0, costUsd: 63.556625, turns: 1 },
  ];
  assert.equal(usageTotal(SERIES[0]!), 16_444_888);
  assert.equal(usageTotal(SERIES[6]!), 28_486_599);

  /** 口径日期界之前（旧 CLI，`result` 是本次进程内的用量）。 */
  const OLD = (day: number) => `2026-09-${String(10 + day).padStart(2, "0")}T10:00:00.000Z`;
  /** 之后（新 CLI，`result` 是整条线程的累计）。 */
  const NEW = (day: number) => `2026-10-${String(10 + day).padStart(2, "0")}T10:00:00.000Z`;
  assert.ok(OLD(9) < CLI_CUMULATIVE_SINCE && NEW(0) > CLI_CUMULATIVE_SINCE, "测试用的两组日期要落在界的两侧");

  type SeedEntry = { usage: TokenUsage; mark: "incremental" | "delta" | "snapshot" };
  const legacyOf = (series: TokenUsage[]): SeedEntry[] =>
    series.map((usage) => ({ usage, mark: "incremental" as const }));

  /** 按「账面 = 各条目逐轮相加」(也就是改口径之前 v1 的行为)建一条历史会话。 */
  const seed = async (
    id: string,
    taskId: string,
    cli: string | null,
    entries: SeedEntry[],
    over: Partial<typeof sessions.$inferInsert> = {},
    traceCount = entries.length,
    /** 同一条线程的第二条 ash 会话要排在后面，否则两截 trace 按时间交错，形状就乱了。 */
    turnOffset = 0,
  ) => {
    const booked = entries.reduce((sum, { usage }) => ({
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
      usageInput: booked.input,
      usageOutput: booked.output,
      usageCacheRead: booked.cacheRead,
      usageCacheWrite: booked.cacheWrite,
      usageReasoning: booked.reasoning,
      usageCostUsd: booked.costUsd,
      usageTurns: entries.length,
      ...over,
    });
    entries.slice(0, traceCount).forEach(({ usage, mark }, index) => {
      const when = at(index + turnOffset);
      appendSessionTrace(taskId, id, when, { kind: "usage", usage, accounting: mark }, when);
    });
    return booked;
  };

  // (a) 旧 CLI 的逐轮增量：序列隔轮下降 + 日期在界之前，两个信号一致 → 强证据，账不动。
  const bumpy = legacyOf([SERIES[2]!, SERIES[0]!, SERIES[3]!, SERIES[1]!, SERIES[4]!]);
  const bumpyBooked = await seed("hist-incremental", "hist-a", "thread-incremental", bumpy, { startedAt: OLD(1) });
  // (b) **F3 的一支**：4 轮真·增量碰巧一路上升。形状说「累计」、日期说「增量」—— 不一致，
  //     必须判不出并原样留着，绝不能照形状把一笔对的账减掉。
  const risingOld = await seed("hist-rising-old", "hist-b", "thread-rising-old",
    legacyOf(SERIES.slice(0, 4)), { startedAt: OLD(2) });
  // (c) 累计口径、7 轮全不降、日期在界之后 → 强证据，重算成最后一份累计值。
  const inflated = await seed("hist-cumulative", "hist-c", "thread-cumulative",
    legacyOf(SERIES), { startedAt: NEW(1) });
  // (d) 只有两轮递增，但两个信号一致 → 弱一档的证据，照样重算。
  await seed("hist-weak-new", "hist-d", "thread-weak-new", legacyOf(SERIES.slice(0, 2)), { startedAt: NEW(2) });
  // (e) 同样两轮递增，日期落在界之前 → 信号不一致，判不出，账不动。
  const weakOld = await seed("hist-weak-old", "hist-e", "thread-weak-old",
    legacyOf(SERIES.slice(0, 2)), { startedAt: OLD(3) });
  // (f) 只有一轮：两种口径数值相同，不该被改。
  const single = await seed("hist-single", "hist-f", "thread-single", legacyOf([SERIES[0]!]), { startedAt: NEW(3) });
  // (g) trace 条数与库里轮数对不上：重算不了。
  await seed("hist-broken", "hist-g", "thread-broken", legacyOf(SERIES), { startedAt: NEW(4) }, 3);
  // (h) codex 对照：这个脚本一行都不许碰它。
  const codexBooked = await seed("hist-codex", "hist-h", "thread-codex", legacyOf(SERIES), {
    agentType: "codex", executor: "codex", startedAt: NEW(5),
  });
  // (i) **F3 的主支**：累计线程中途重置了计数器(A,B,A,B)。4 轮里只降了 1 次 —— 既不是
  //     「全不降」也不是「隔轮下降」，形状说不出，必须判不出并原样留着。
  const resetHistory = await seed("hist-reset", "hist-i", "thread-reset",
    legacyOf([SERIES[0]!, SERIES[1]!, SERIES[0]!, SERIES[1]!]), { startedAt: NEW(6) });
  // (j) **F2**：前 4 条是旧账的累计快照，第 5 条是修好的代码已经结算过的 delta，而且它
  //     恰好五项全不降(真·大增量就长这样)。只认标记 → 原样计入，绝不再减一次。
  const settledDelta = { ...SERIES[5]!, costUsd: 5.5 };
  await seed("hist-settled", "hist-j", "thread-settled",
    [...legacyOf(SERIES.slice(0, 4)), { usage: settledDelta, mark: "delta" }], { startedAt: NEW(7) });
  // (k) 「先重启、后回填」留下的那一轮：标记是 snapshot(累计口径 + 当时没有基线)，
  //     整份累计值被记成了增量，这次凭标记补掉。
  await seed("hist-rebase", "hist-k", "thread-rebase",
    [...legacyOf(SERIES.slice(0, 4)), { usage: SERIES[4]!, mark: "snapshot" }], { startedAt: NEW(8) });

  // (l) **F1**：这条线程在改口径之后真的又跑了 3 个回合，于是它的累计快照 `updated_at`
  //     是「刚刚」。上一版拿 claude 快照的最早 updated_at 当分界，于是这 4 条旧账被塞进
  //     「已归一」那一侧，整条线程被判成 incremental 并原样留着虚高的账。现在分界逐条看
  //     标记，跟任何时间戳无关。
  const driftLegacy = legacyOf(SERIES.slice(0, 4));
  await seed("hist-drift", "hist-l", "thread-drift", driftLegacy, { startedAt: NEW(0) });
  for (const usage of SERIES.slice(4)) {
    const event = await recordSessionUsageEvent("hist-drift", { kind: "usage", usage }, "claude", "thread-drift");
    appendSessionTrace("hist-l", "hist-drift", at(9), event, new Date().toISOString());
  }
  const driftSnapshot = await db.select().from(usageCumulativeSnapshots)
    .where(eq(usageCumulativeSnapshots.sourceId, "claude:thread-drift")).get();
  assert.ok(driftSnapshot && driftSnapshot.updatedAt > NEW(9), "这条线程的快照刚被运行期写过（分界绝不能看它）");

  const plan = await planClaudeUsageRepair();
  assert.equal(plan.boundary, CLI_CUMULATIVE_SINCE);
  assert.deepEqual(plan.warnings, [], "强证据的两侧都落在界的正确一侧，不该报分歧");
  assert.equal(plan.observed.lastIncremental, OLD(1), "库里观察到的最后一条强证据增量线程");
  assert.equal(plan.observed.firstCumulative, NEW(0), "最早一条强证据累计线程（hist-drift 的 4 条旧账）");

  const planOf = (id: string) => plan.sessions.find((item) => item.sessionId === id)!;
  assert.equal(planOf("hist-cumulative").regime, "cumulative");
  assert.equal(planOf("hist-cumulative").evidence, "strong");
  assert.equal(
    usageTotal(planOf("hist-cumulative").after!),
    usageTotal(SERIES[6]!),
    "累计口径的会话重算后 = 最后一份累计快照（各轮增量之和的恒等式）",
  );
  assert.ok(
    usageTotal(inflated) / usageTotal(planOf("hist-cumulative").after!) > 4,
    "原账面确实是几倍虚高，不然这个用例就什么都没在测",
  );
  assert.equal(planOf("hist-incremental").regime, "incremental");
  assert.equal(planOf("hist-incremental").evidence, "strong");
  assert.equal(planOf("hist-incremental").after, null, "逐轮增量口径的历史账本来就是对的，不许动");
  assert.equal(planOf("hist-weak-new").regime, "cumulative");
  assert.equal(planOf("hist-weak-new").evidence, "weak-agreed");
  assert.equal(usageTotal(planOf("hist-weak-new").after!), usageTotal(SERIES[1]!));
  assert.equal(planOf("hist-single").evidence, "single-turn");
  assert.equal(planOf("hist-single").after, null, "一轮的会话两种口径同值，也不该写一遍");
  assert.equal(planOf("hist-broken").regime, "unreadable");
  assert.match(planOf("hist-broken").skipped!, /对不上/);
  assert.equal(planOf("hist-broken").after, null);
  assert.equal(plan.sessions.some((item) => item.sessionId === "hist-codex"), false, "codex 会话不该进 claude 的计划");

  // ── 判不出的那三条：一律不动账，而且必须明说判不出 ──────────────────────────
  for (const [id, note] of [["hist-reset", "中途重置的累计"], ["hist-rising-old", "碰巧全升的增量"],
    ["hist-weak-old", "两轮递增但日期在界之前"]] as const) {
    assert.equal(planOf(id).regime, "uncertain", `${note}(${id}) 必须判不出`);
    assert.equal(planOf(id).evidence, "none");
    assert.equal(planOf(id).after, null, `${note} 不许改账`);
    assert.ok(planOf(id).skipped, `${note} 必须留下「判不出」的说明，不能静默不动`);
  }
  assert.match(planOf("hist-reset").skipped!, /不到一半/);
  assert.match(planOf("hist-rising-old").skipped!, /两个信号不一致/);
  assert.equal(
    snapshotPlanOf(plan, "claude:thread-reset").baselineReady,
    false,
    "口径判不出就拼不出可信基线：留待建基线，免得续聊时整条线程再加一遍",
  );

  // ── F2：已结算的大增量不许被再减一次 ────────────────────────────────────────
  const settled = planOf("hist-settled");
  assert.equal(settled.straddlesCutoff, true);
  assert.equal(settled.rebasedFirstTurnAfterCutoff, false, "标记是 delta 就是已结算，哪怕五项全不降也不许动");
  assert.equal(
    usageTotal(settled.after!),
    usageTotal(SERIES[3]!) + usageTotal(settledDelta),
    "旧账那 4 条求差(之和 = 第 4 份累计) + 已结算那条原样计入",
  );
  assert.ok(
    usageTotal(settledDelta) > usageTotal(SERIES[3]!) / 2,
    "这条用例要有意义，那个已结算的增量就得大到「看着像累计快照」",
  );

  // ── 补首轮：只有 snapshot 标记才补 ──────────────────────────────────────────
  const rebase = planOf("hist-rebase");
  assert.equal(rebase.rebasedFirstTurnAfterCutoff, true);
  assert.equal(usageTotal(rebase.after!), usageTotal(SERIES[4]!), "补掉那一轮之后整条会话收敛到最后一份累计值");

  // ── F1：分界不随续聊漂移 ────────────────────────────────────────────────────
  const drift = planOf("hist-drift");
  assert.equal(drift.regime, "cumulative", "4 条旧账 + 日期在界之后 → 强证据判成累计");
  assert.equal(drift.evidence, "strong");
  assert.equal(drift.straddlesCutoff, true);
  assert.equal(drift.rebasedFirstTurnAfterCutoff, true, "改口径后那条线程的第一回合是 snapshot，要补求差");
  assert.equal(
    usageTotal(drift.after!),
    usageTotal(SERIES[6]!),
    "整条线程(4 条旧账 + 3 个真实新回合)收敛到最后一份累计值 28,486,599；"
    + "上一版在这里会判成 incremental 并留着 1 亿多的虚高账面",
  );
  assert.ok(usageTotal(drift.after!) < usageTotal((await readUsage("hist-drift"))!) / 3, "原账面确实虚高 3 倍以上");

  // ── 落地 + trace 改写 ───────────────────────────────────────────────────────
  const applied = await applyClaudeUsageRepair(plan);
  const rewritten = applied.traces;
  assert.equal(applied.sessions, 5,
    "该改的 5 条：hist-cumulative / hist-weak-new / hist-settled / hist-rebase / hist-drift");
  assert.equal(usageTotal((await readUsage("hist-cumulative"))!), usageTotal(SERIES[6]!));
  assert.equal(usageTotal((await readUsage("hist-drift"))!), usageTotal(SERIES[6]!));
  assert.equal(usageTotal((await readUsage("hist-incremental"))!), usageTotal(bumpyBooked), "判成增量的账不动");
  assert.equal(usageTotal((await readUsage("hist-rising-old"))!), usageTotal(risingOld), "判不出的账不动");
  assert.equal(usageTotal((await readUsage("hist-weak-old"))!), usageTotal(weakOld));
  assert.equal(usageTotal((await readUsage("hist-reset"))!), usageTotal(resetHistory));
  assert.equal(usageTotal((await readUsage("hist-single"))!), usageTotal(single));
  assert.equal(usageTotal((await readUsage("hist-codex"))!), usageTotal(codexBooked), "codex 的账一个字节都不许动");
  assert.equal(
    (await db.select().from(usageCumulativeSnapshots).where(eq(usageCumulativeSnapshots.sourceId, `claude:${thread}`)).get())!.input,
    REAL[3]!.input,
    "运行期那条快照必须还是运行期写的那一份",
  );

  assert.deepEqual(rewritten.failures, [], "改写 trace 不该有失败项");
  assert.equal(rewritten.failedThreads.size, 0);
  assert.ok(rewritten.files >= 5, "每条重算过的会话都要把 trace 里的累计值改成真实增量");
  assert.ok(
    existsSync(`${sessionTracePath("hist-c", "hist-cumulative")}${TRACE_BACKUP_SUFFIX}`),
    "改写前必须留一份原文件备份",
  );
  // 这才是 F4 的根治：气泡读的那条事件本身已经是真实增量，而且逐条带着 delta 标记，
  // 含义不再随「以后会不会续聊」改变。
  const rewrittenTrace = readUsageTrace("hist-c", "hist-cumulative")!;
  assert.equal(rewrittenTrace.length, SERIES.length);
  assert.ok(rewrittenTrace.every((entry) => entry.mark === "delta"), "改写后每条都带 delta 标记");
  assert.equal(usageTotal(rewrittenTrace[0]!.usage), usageTotal(SERIES[0]!), "首轮没有上一份快照，整份就是增量");
  assert.equal(
    usageTotal(rewrittenTrace[1]!.usage),
    usageTotal(SERIES[1]!) - usageTotal(SERIES[0]!),
    "第 2 个气泡显示的是真实增量，不再是从开场到此刻的累计",
  );
  assert.equal(
    rewrittenTrace.reduce((sum, entry) => sum + usageTotal(entry.usage), 0),
    usageTotal((await readUsage("hist-cumulative"))!),
    "各气泡之和 = 会话汇总(页面底部与右侧不再互相矛盾)",
  );
  // 不该改的那几份 trace 一个字节都没动。
  assert.ok(
    readUsageTrace("hist-i", "hist-reset")!.every((entry) => entry.mark === "incremental"),
    "判不出的会话，trace 也不许动",
  );
  assert.ok(!existsSync(`${sessionTracePath("hist-i", "hist-reset")}${TRACE_BACKUP_SUFFIX}`));

  // ── 幂等：再跑一次什么都不该变（手工脚本没有一次性闸，必须自身幂等）────────────
  const again = await planClaudeUsageRepair();
  assert.equal(again.sessions.filter((item) => item.after).length, 0, "回填必须幂等");
  assert.equal(again.snapshots.length, 0, "快照已经建好，第二遍不该再建");
  assert.equal(again.traces.length, 0, "trace 已经是真实增量，第二遍不该再改");
  assert.equal(
    again.sessions.find((item) => item.sessionId === "hist-cumulative")!.evidence,
    "settled",
    "改写之后这条线程一条旧账都没有了，口径无须再判",
  );

  // ── --boundary 覆盖：别的机器上升级时刻不同 ─────────────────────────────────
  const shifted = await planClaudeUsageRepair({ boundary: OLD(0) });
  const shiftedBumpy = shifted.sessions.find((item) => item.sessionId === "hist-incremental")!;
  assert.equal(shiftedBumpy.regime, "uncertain",
    "把界挪到所有会话之前，形状(增量)就跟日期(累计)对不上了 —— 该判不出，而不是照日期改账");
  assert.ok(shifted.warnings.length === 0 || shifted.warnings.every((text) => text.includes("日期界")));

  // ── trace 当闸：一条线程里有一份 trace 改不了，这条线程的账也不许改 ──────────
  // 「账已经是真实增量、trace 里还是累计值」是最坏的半成品：那半截的上一份基线已经没了，
  // 下一次回填再也算不回真实增量，v3 那条老分支还会按累计值把账吹回去。
  const gateSeries = legacyOf(SERIES.slice(0, 3));
  const gateA = await seed("hist-gate-a", "hist-m", "thread-gate", gateSeries, { startedAt: NEW(9) });
  const gateB = await seed("hist-gate-b", "hist-m", "thread-gate",
    legacyOf(SERIES.slice(3, 6)), { startedAt: NEW(9), role: "reviewer", sideTurn: true }, 3, 3);
  const gatePlan = await planClaudeUsageRepair();
  assert.equal(gatePlan.sessions.find((item) => item.sessionId === "hist-gate-a")!.regime, "cumulative");
  assert.ok(gatePlan.sessions.find((item) => item.sessionId === "hist-gate-a")!.after, "本来是要改账的");
  assert.ok(gatePlan.sessions.find((item) => item.sessionId === "hist-gate-b")!.after);
  rmSync(sessionTracePath("hist-m", "hist-gate-b"));
  const gated = await applyClaudeUsageRepair(gatePlan);
  assert.equal(gated.traces.failedThreads.has("thread-gate"), true);
  assert.match(gated.traces.failures.join("\n"), /读不到 trace/);
  assert.match(gated.traces.failures.join("\n"), /同一条 CLI 线程里有别的 trace 验不过/);
  assert.equal(usageTotal((await readUsage("hist-gate-a"))!), usageTotal(gateA), "整条线程的账都不许动");
  assert.equal(usageTotal((await readUsage("hist-gate-b"))!), usageTotal(gateB));
  assert.ok(
    readUsageTrace("hist-m", "hist-gate-a")!.every((entry) => entry.mark === "incremental"),
    "同组里另一份 trace 也必须保持原样（验过了也不写）",
  );
  assert.equal(gated.sessions, 0, "这一轮一条账都没落");

  // ── 形状判据本身 ───────────────────────────────────────────────────────────
  assert.equal(shapeRegime([]), null);
  assert.equal(shapeRegime([SERIES[0]!]), null, "一条谈不上形状");
  assert.equal(shapeRegime(SERIES), "cumulative");
  assert.equal(shapeRegime([SERIES[2]!, SERIES[0]!, SERIES[3]!, SERIES[1]!, SERIES[4]!]), "incremental");
  assert.equal(shapeRegime([SERIES[0]!, SERIES[1]!, SERIES[0]!, SERIES[1]!]), null, "中途重置：形状说不出");
  assert.equal(shapeRegime([SERIES[1]!, SERIES[0]!]), "incremental", "两条里降了一次 = 一半");

  console.log("claude 账本验证通过：线程累计求差、真实连续回合换算、逐条口径标记、"
    + "判不出就跳过、trace 改写与幂等");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function snapshotPlanOf(plan: { snapshots: { sourceId: string }[] }, sourceId: string) {
  return plan.snapshots.find((item) => item.sourceId === sourceId) as
    { sourceId: string; baselineReady: boolean };
}

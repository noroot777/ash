// Token 账本的三处要害，在**真数据库**上钉住。
//
// ① 口径要能跨执行器相加：codex 的 `input_tokens` **已含**命中缓存的那部分，
//    claude 的没有。采集处不减出来的话，同样的花费在两家 CLI 上算出来的合计
//    不一样，任务级的「所有会话之和」就是一笔糊涂账。
// ② 「没报账」≠「花了 0」：不报账的 CLI / 本功能之前建的会话行必须读回 null，
//    界面才能区分「这家不报」和「真没花」。费用同理——codex 不报价，它的回合
//    不能被算成 $0 摊进总额。
// ③ Claude 的 result 是本轮增量；Codex 的 turn.completed 是线程累计快照。前者
//    逐轮加，后者先求差再加，不能拿同一种 SQL 对付两家。
// ④ **但上下文水位恰恰相反，是覆盖**：它是「此刻装了多少」，累加会得出一个没有
//    物理意义的数（流水 18M 的会话水位可能才 12 万）。同一个文件里两种账并存，
//    所以这条必须在测试里钉死。
//
// Run: npm -w server run test:usage
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "harness-usage-"));
process.env.HARNESS_DB = join(root, "harness.db");
process.env.HARNESS_RUNS_DIR = join(root, "runs");

const { db, ensureSchema } = await import("../src/db/index.js");
const { appSettings, sessions } = await import("../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const {
  addSessionUsage,
  recordSessionUsageEvent,
  sessionUsage,
  setSessionContext,
  sessionContext,
} = await import("../src/usage.js");
const { repairLegacyUsageAccounting } = await import("../src/usage-repair.js");
const { claudeUsage, claudeContextUsed, claudeContextWindow, parseClaudeStream } = await import("../src/executors/claude.js");
const { codexUsage, parseCodexStream } = await import("../src/executors/codex.js");
const { parseCodexContextLines, readCodexContext } = await import("../src/executors/codex-rollout.js");
const { appendSessionTrace, parseSessionTrace, sessionTracePath } = await import("../src/transcript.js");
const { addUsage, sumUsage, usageTotal, hasUsage, formatTokens, formatCost, contextRatio, hasContext, guessContextWindow } = await import("@harness/shared/usage");

/** 拿假 CLI stdout 真跑一遍解析器,把它吐出的 context 事件取回来(同 test-claude-stream-errors 的套路)。 */
async function parseFakeClaude(lines: unknown[]) {
  const script = join(root, `stub-${lines.length}-${Math.random().toString(36).slice(2, 8)}.mjs`);
  writeFileSync(script, lines.map((l) => `process.stdout.write(${JSON.stringify(JSON.stringify(l) + "\n")});`).join("\n"));
  const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin?.end();
  let context: unknown = null;
  for await (const event of parseClaudeStream(child as any, undefined)) {
    if ((event as any).kind === "context") context = (event as any).context;
  }
  return context;
}

/** 同样用假 stdout 跑 Codex 解析器，验证 rollout 水位真的接在 done 之前。 */
async function parseFakeCodex(
  lines: unknown[],
  contextOptions: { initialThreadId: string; contextNotBeforeMs: number },
) {
  const script = join(root, `codex-stub-${lines.length}-${Math.random().toString(36).slice(2, 8)}.mjs`);
  writeFileSync(script, lines.map((line) => `process.stdout.write(${JSON.stringify(JSON.stringify(line) + "\n")});`).join("\n"));
  const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin?.end();
  const events: any[] = [];
  for await (const event of parseCodexStream(child as any, undefined, { stopRequested: false }, contextOptions)) {
    events.push(event);
  }
  return events;
}

try {
  await ensureSchema();

  // ── ① 口径 ───────────────────────────────────────────────────────────────
  // claude：modelUsage 优先（小模型跑标题/压缩的账也在里面，且跟 total_cost_usd 同源）。
  const claude = claudeUsage({
    type: "result",
    usage: { input_tokens: 66, output_tokens: 900, cache_read_input_tokens: 20_000 },
    modelUsage: {
      "claude-opus-5": { inputTokens: 3_000, outputTokens: 1_000, cacheReadInputTokens: 20_000, cacheCreationInputTokens: 500, costUSD: 3.9 },
      "claude-haiku-4-5": { inputTokens: 404, outputTokens: 120, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.18 },
    },
    total_cost_usd: 4.08,
  });
  assert.ok(claude);
  assert.equal(claude.input, 3_404, "modelUsage 要按模型求和，不能只取主模型那份");
  assert.equal(claude.output, 1_120);
  assert.equal(claude.cacheRead, 20_000);
  assert.equal(claude.cacheWrite, 500);
  assert.equal(claude.costUsd, 4.08);
  assert.equal(claude.turns, 1);
  assert.equal(usageTotal(claude), 25_024);

  // 没有 modelUsage 的旧版 CLI 退到顶层 usage；两样都没有就是「不报账」→ null。
  const claudeFallback = claudeUsage({ type: "result", usage: { input_tokens: 66, output_tokens: 900, cache_read_input_tokens: 20_000 } });
  assert.equal(claudeFallback?.input, 66);
  assert.equal(claudeFallback?.costUsd, null, "没报价就是 null，不能垫成 0");
  assert.equal(claudeUsage({ type: "result" }), null, "不报账必须是 null，不能退化成全 0");

  // codex：input_tokens 含 cached_input_tokens，要减出来，否则缓存读算两遍。
  const codex = codexUsage({ input_tokens: 23_404, cached_input_tokens: 20_000, output_tokens: 1_120, reasoning_output_tokens: 640 });
  assert.ok(codex);
  assert.equal(codex.input, 3_404, "codex 的 input 要扣掉命中缓存的那部分");
  assert.equal(codex.cacheRead, 20_000);
  assert.equal(codex.reasoning, 640);
  assert.equal(codex.costUsd, null, "codex 不报价 → null（不是 0）");
  // 同样的花费，两家算出来的合计必须一样 —— 这才敢把它们相加。
  assert.equal(usageTotal(codex), usageTotal({ ...claude, cacheWrite: 0 }));
  assert.equal(codexUsage(undefined), null);

  // ── ② Claude 增量 + Codex 累计快照 ───────────────────────────────────────
  const sessId = "usage-session-1";
  await db.insert(sessions).values({
    id: sessId,
    taskId: "usage-task",
    role: "single",
    agentType: "claude",
    executor: "claude",
    target: "claude",
    startedAt: new Date().toISOString(),
  });

  const blank = await db.select().from(sessions).where(eq(sessions.id, sessId)).get();
  assert.equal(sessionUsage(blank!), null, "还没记过账的会话行读回来必须是 null");

  await addSessionUsage(sessId, claude, { kind: "incremental" });
  await addSessionUsage(sessId, codex, { kind: "cumulative", sourceId: "codex:test-thread" });
  const codexNext = { ...codex, input: 4_404, output: 1_500, cacheRead: 23_000, reasoning: 800 };
  const normalizedCodexEvent = await recordSessionUsageEvent(
    sessId,
    { kind: "usage", usage: codexNext },
    "codex",
    "test-thread",
  );
  assert.deepEqual(
    normalizedCodexEvent.usage,
    { input: 1_000, output: 380, cacheRead: 3_000, cacheWrite: 0, reasoning: 160, costUsd: null, turns: 1 },
    "Codex 第二轮只能把累计快照的差值写进 trace/UI",
  );
  assert.equal(normalizedCodexEvent.accounting, "incremental", "新 trace 必须标明已经归一，读侧不能再求一次差");
  const after = await db.select().from(sessions).where(eq(sessions.id, sessId)).get();
  const total = sessionUsage(after!);
  assert.ok(total);
  assert.equal(total.input, 7_808, "Claude 增量 + Codex 最新累计值，不能叠两份 Codex 快照");
  assert.equal(total.output, 2_620);
  assert.equal(total.cacheRead, 43_000);
  assert.equal(total.cacheWrite, 500);
  assert.equal(total.reasoning, 800);
  assert.equal(total.turns, 3);
  assert.equal(total.costUsd, 4.08, "codex 那轮没报价，不能把总额摊薄或算成 0");

  // ── 展示侧的合并口径 ─────────────────────────────────────────────────────
  assert.deepEqual(sumUsage([null, undefined]), null, "一条都没报账 → null，界面别显示 0");
  assert.equal(sumUsage([claude, codex])!.costUsd, 4.08);
  assert.equal(addUsage(claude, codex).turns, 2);
  assert.equal(hasUsage(null), false);
  assert.equal(hasUsage(total), true);
  assert.equal(formatTokens(1_234), "1,234");
  assert.equal(formatTokens(49_024), "49.0k");
  assert.equal(formatCost(null), null);
  assert.equal(formatCost(0.004), "<$0.01");
  assert.equal(formatCost(4.08), "$4.08");

  // ── ③ 旧账自动纠偏 ───────────────────────────────────────────────────────
  const legacyCodexId = "legacy-codex-session";
  const incompleteCodexId = "incomplete-codex-session";
  const legacyClaudeId = "legacy-claude-session";
  await db.insert(sessions).values([
    {
      id: legacyCodexId,
      taskId: "legacy-codex-task",
      role: "single",
      agentType: "codex",
      executor: "codex",
      target: "local",
      cliSessionId: "legacy-thread",
      startedAt: "2026-08-07T01:00:00.000Z",
      usageInput: 9_000,
      usageOutput: 9_000,
      usageCacheRead: 9_000,
      usageCacheWrite: 0,
      usageReasoning: 9_000,
      usageTurns: 2,
    },
    {
      id: incompleteCodexId,
      taskId: "incomplete-codex-task",
      role: "single",
      agentType: "codex",
      executor: "codex",
      target: "local",
      cliSessionId: "incomplete-thread",
      startedAt: "2026-08-07T01:00:00.000Z",
      usageInput: 20,
      usageOutput: 10,
      usageCacheRead: 180,
      usageCacheWrite: 0,
      usageReasoning: 6,
      usageTurns: 2,
    },
    {
      id: legacyClaudeId,
      taskId: "legacy-claude-task",
      role: "single",
      agentType: "claude",
      executor: "claude",
      target: "local",
      cliSessionId: "legacy-claude-thread",
      startedAt: "2026-08-07T01:00:00.000Z",
      usageInput: 1,
      usageOutput: 1,
      usageCacheRead: 1,
      usageCacheWrite: 1,
      usageReasoning: 0,
      usageTurns: 2,
    },
  ]);
  const cumulative1 = { input: 10, output: 5, cacheRead: 90, cacheWrite: 0, reasoning: 3, costUsd: null, turns: 1 };
  const cumulative2 = { input: 20, output: 10, cacheRead: 180, cacheWrite: 0, reasoning: 6, costUsd: null, turns: 1 };
  appendSessionTrace("legacy-codex-task", legacyCodexId, "2026-08-07T01:00:00.000Z", { kind: "usage", usage: cumulative1 }, "2026-08-07T01:01:00.000Z");
  appendSessionTrace("legacy-codex-task", legacyCodexId, "2026-08-07T02:00:00.000Z", { kind: "usage", usage: cumulative2 }, "2026-08-07T02:01:00.000Z");
  // 数据库说有两轮，trace 只有一轮：不能猜旧累计基线，也不能让下一次 resume 把整份
  // 累计值再加一次。
  appendSessionTrace("incomplete-codex-task", incompleteCodexId, "2026-08-07T01:00:00.000Z", { kind: "usage", usage: cumulative1 }, "2026-08-07T01:01:00.000Z");
  const claudeTurn1 = { input: 2, output: 7, cacheRead: 30, cacheWrite: 4, reasoning: 0, costUsd: 0.1, turns: 1 };
  const claudeTurn2 = { input: 3, output: 8, cacheRead: 40, cacheWrite: 5, reasoning: 0, costUsd: 0.2, turns: 1 };
  appendSessionTrace("legacy-claude-task", legacyClaudeId, "2026-08-07T01:00:00.000Z", { kind: "usage", usage: claudeTurn1 }, "2026-08-07T01:01:00.000Z");
  appendSessionTrace("legacy-claude-task", legacyClaudeId, "2026-08-07T02:00:00.000Z", { kind: "usage", usage: claudeTurn2 }, "2026-08-07T02:01:00.000Z");

  await db.insert(appSettings).values({ key: "internal.usage-accounting-v2", value: "{}" });
  const repaired = await repairLegacyUsageAccounting();
  assert.equal(repaired.alreadyApplied, false, "跑过 v2 的实例仍要执行 v3 缺失基线补救");
  assert.equal(repaired.repairedCodexSessions, 1);
  assert.equal(repaired.repairedClaudeSessions, 1);
  assert.ok(repaired.skippedSessions >= 1, "不完整 Codex trace 必须走跳过 + 待建基线路径");
  assert.deepEqual(
    sessionUsage((await db.select().from(sessions).where(eq(sessions.id, legacyCodexId)).get())!),
    { ...cumulative2, turns: 2 },
    "Codex 旧账应恢复成最后一份累计快照，而不是两份快照相加",
  );
  assert.deepEqual(
    sessionUsage((await db.select().from(sessions).where(eq(sessions.id, legacyClaudeId)).get())!),
    addUsage(claudeTurn1, claudeTurn2),
    "Claude 旧账仍按每轮增量重建",
  );
  const incompleteNext = { ...cumulative2, input: 24, output: 12, cacheRead: 200, reasoning: 7 };
  const baselineOnly = await recordSessionUsageEvent(
    incompleteCodexId,
    { kind: "usage", usage: incompleteNext },
    "codex",
    "incomplete-thread",
  );
  assert.deepEqual(
    baselineOnly.usage,
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: null, turns: 1 },
    "旧 trace 不完整时下一轮只建立累计基线，不能把整条线程再次入账",
  );
  assert.deepEqual(
    sessionUsage((await db.select().from(sessions).where(eq(sessions.id, incompleteCodexId)).get())!),
    { input: 20, output: 10, cacheRead: 180, cacheWrite: 0, reasoning: 6, costUsd: null, turns: 3 },
  );
  const afterBaseline = await recordSessionUsageEvent(
    incompleteCodexId,
    { kind: "usage", usage: { ...incompleteNext, input: 30, output: 15, cacheRead: 230, reasoning: 9 } },
    "codex",
    "incomplete-thread",
  );
  assert.deepEqual(
    afterBaseline.usage,
    { input: 6, output: 3, cacheRead: 30, cacheWrite: 0, reasoning: 2, costUsd: null, turns: 1 },
    "基线建立后的再下一轮恢复正常求差",
  );
  const nextLegacy = { ...cumulative2, input: 24, output: 12, cacheRead: 200, reasoning: 7 };
  const nextLegacyEvent = await recordSessionUsageEvent(
    legacyCodexId,
    { kind: "usage", usage: nextLegacy },
    "codex",
    "legacy-thread",
  );
  assert.equal(usageTotal(nextLegacyEvent.usage), 26, "历史修复还要给后续续聊留下累计基线");
  assert.equal((await repairLegacyUsageAccounting()).alreadyApplied, true, "历史纠偏只能执行一次");

  // ── ④ 单轮的账要能落进 trace，刷新后按回合回放 ───────────────────────────
  const traceTask = `usage-trace-${process.pid}`;
  const tracePath = sessionTracePath(traceTask, sessId);
  appendSessionTrace(traceTask, sessId, "2026-08-07T01:00:00.000Z", { kind: "text", text: "干完了。" });
  appendSessionTrace(traceTask, sessId, "2026-08-07T01:00:00.000Z", { kind: "usage", usage: claude });
  const parsed = parseSessionTrace(readFileSync(tracePath, "utf8"));
  assert.equal(parsed.length, 2);
  const replayed = parsed[1]!.event;
  assert.equal(replayed.kind, "usage");
  assert.equal(replayed.kind === "usage" ? replayed.usage.input : 0, 3_404);
  // 形状不对的 usage 行要被丢掉，不能把 undefined 塞进界面。
  assert.equal(parseSessionTrace(`{"at":"x","event":{"kind":"usage"}}\n`).length, 0);
  rmSync(dirname(tracePath), { recursive: true, force: true });

  // ── ⑤ 水位是覆盖不是累加 ─────────────────────────────────────────────────
  // 这一段是整个文件里最容易被下一个人改错的地方：上面三段全在说「累加」，
  // 顺手把 setSessionContext 也写成累加，长会话立刻算出「用了窗口的 90 倍」。
  assert.equal(sessionContext(blank!), null, "还没采到水位的会话行读回来必须是 null");

  await setSessionContext(sessId, { used: 61_200, window: 200_000, windowEstimated: true });
  await setSessionContext(sessId, { used: 117_016, window: 200_000, windowEstimated: true });
  const water = sessionContext((await db.select().from(sessions).where(eq(sessions.id, sessId)).get())!);
  assert.ok(water);
  assert.equal(water.used, 117_016, "水位必须被后一次覆盖；累加成 178,216 就是错的");
  assert.equal(water.window, 200_000);
  assert.equal(water.windowEstimated, true);
  assert.equal(Math.round(contextRatio(water)! * 100), 59);

  await setSessionContext(sessId, { used: 0, window: null, windowEstimated: false });
  assert.equal(
    sessionContext((await db.select().from(sessions).where(eq(sessions.id, sessId)).get())!),
    null,
    "执行器明确没采到水位时必须清空旧值，不能继续展示上一轮数字",
  );

  // 没有窗口 → 没有比例。宁可界面上不显示百分比，也不许编一个分母出来。
  assert.equal(contextRatio({ used: 1_000, window: null, windowEstimated: false }), null);
  assert.equal(hasContext({ used: 0, window: 200_000, windowEstimated: false }), false, "0 = 没采到");
  assert.equal(guessContextWindow("claude-opus-5"), 200_000);
  assert.equal(guessContextWindow("gpt-5.6-sol"), null, "猜不出就是 null，不许瞎垫一个");

  // claude 的水位取**单次调用**的输入规模（含缓存命中的那部分——它确实在上下文里）。
  assert.equal(claudeContextUsed({ input_tokens: 5, cache_read_input_tokens: 116_000, cache_creation_input_tokens: 1_011 }), 117_016);
  assert.equal(claudeContextUsed(undefined), 0);

  // ── ⑥ 分母:自报永远压过猜测 ──────────────────────────────────────────────
  // 这一段钉的是一个**按模型名猜不出来**的事实：开了 1M 窗口的会话，assistant 事件里
  // 的模型名跟普通 200k 会话逐字相同（都是 claude-opus-5），唯一的线索 `[1m]` 只出现
  // 在 result.modelUsage 的 key 上。漏读自报值 → 1M 会话「剩 94%」被显示成「剩 72%」，
  // 水位过 20 万还会提前变红报快满了（2026-08-07 审查抓到的 P1）。
  assert.equal(
    claudeContextWindow({ modelUsage: { "claude-opus-5[1m]": { contextWindow: 1_000_000 } } }, "claude-opus-5"),
    1_000_000,
    "`claude-opus-5` 必须认出 `claude-opus-5[1m]` 这个 key——差的就是那个后缀",
  );
  assert.equal(
    claudeContextWindow({ modelUsage: { "claude-opus-5": { contextWindow: 200_000 } } }, "claude-opus-5"),
    200_000,
    "精确同名当然也要认",
  );
  // 小模型（跑标题/压缩的 haiku）也在 modelUsage 里，它的 200k 不许冒充主模型的窗口。
  assert.equal(
    claudeContextWindow({
      modelUsage: {
        "claude-opus-5[1m]": { contextWindow: 1_000_000 },
        "claude-haiku-4-5": { contextWindow: 200_000 },
      },
    }, "claude-opus-5"),
    1_000_000,
  );
  assert.equal(
    claudeContextWindow({
      modelUsage: { "a-model": { contextWindow: 111 }, "b-model": { contextWindow: 222 } },
    }, "对不上的名字"),
    null,
    "多项且认不出是哪个模型时不许挑一个——挑错了分母比没有更坏",
  );
  assert.equal(claudeContextWindow({}, "claude-opus-5"), null, "没有 modelUsage 就是没自报");
  assert.equal(
    claudeContextWindow({ modelUsage: { "claude-opus-5": { contextWindow: 0 } } }, "claude-opus-5"),
    null,
    "0 / 非有限值不是窗口",
  );

  // 端到端跑一遍解析器：上面全是纯函数，而 P1 出在**接线**上（读到了自报值却没往
  // context 事件里传）。喂两行真形状的 stdout，看它最后吐出来的那颗胶囊的数据。
  const oneMega = await parseFakeClaude([
    { type: "assistant", message: { model: "claude-opus-5", usage: { input_tokens: 5, cache_read_input_tokens: 116_000 }, content: [] } },
    { type: "result", subtype: "success", modelUsage: { "claude-opus-5[1m]": { contextWindow: 1_000_000, inputTokens: 5 } } },
  ]);
  assert.deepEqual(
    oneMega,
    { used: 116_005, window: 1_000_000, windowEstimated: false },
    "自报 1M 必须原样传到 context 事件，且不许标成估算",
  );

  const noReport = await parseFakeClaude([
    { type: "assistant", message: { model: "claude-opus-5", usage: { input_tokens: 5, cache_read_input_tokens: 116_000 }, content: [] } },
    { type: "result", subtype: "success", usage: { input_tokens: 5 } },
  ]);
  assert.deepEqual(
    noReport,
    { used: 116_005, window: 200_000, windowEstimated: true },
    "没自报才退回按模型名估，且必须标成估算",
  );

  // ── ⑦ Codex 私有 rollout 变格式时必须失败关闭 ───────────────────────────
  const oldAt = "2026-08-07T10:00:00.000Z";
  const currentAt = "2026-08-07T11:00:00.000Z";
  const currentTurn = Date.parse(currentAt) - 1;
  const tokenCount = (at: string, used: number, window: number) => JSON.stringify({
    timestamp: at,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { last_token_usage: { input_tokens: used }, model_context_window: window },
    },
  });

  assert.deepEqual(
    parseCodexContextLines([tokenCount(currentAt, 232_956, 353_400)], currentTurn),
    { used: 232_956, window: 353_400, windowEstimated: false },
    "当前版本的真实 token_count 形状应能读出水位",
  );
  assert.equal(
    parseCodexContextLines([
      tokenCount(oldAt, 117_016, 353_400),
      JSON.stringify({ timestamp: currentAt, type: "event_msg", payload: { type: "token_usage", last: 232_956 } }),
    ], currentTurn),
    null,
    "事件名变化后不能退回上一轮旧 token_count",
  );
  assert.equal(
    parseCodexContextLines([
      tokenCount(oldAt, 117_016, 353_400),
      `{"timestamp":"${currentAt}","type":"event_msg","payload":{"type":"token_count",BROKEN`,
    ], currentTurn),
    null,
    "最新 token_count 损坏时不能继续向前捞旧值",
  );
  assert.equal(
    parseCodexContextLines([JSON.stringify({
      timestamp: currentAt,
      type: "event_msg",
      payload: { type: "token_count", info: { lastTokenUsage: { inputTokens: 232_956 }, modelContextWindow: 353_400 } },
    })], currentTurn),
    null,
    "字段改名后应返回 null，而不是猜测新私有格式",
  );
  assert.equal(
    parseCodexContextLines([tokenCount(currentAt, 400_000, 353_400)], currentTurn),
    null,
    "水位超过窗口是不可信数据，不应显示",
  );

  const codexHome = join(root, "codex-home");
  const rolloutDir = join(codexHome, "sessions", "2026", "08", "07");
  const threadId = "019fe3e7-b770-7c80-b880-de5078b5f7d8";
  mkdirSync(rolloutDir, { recursive: true });
  process.env.CODEX_HOME = codexHome;
  writeFileSync(
    join(rolloutDir, `rollout-2026-08-07T11-00-00-${threadId}.jsonl`),
    `${tokenCount(oldAt, 117_016, 353_400)}\n${tokenCount(currentAt, 232_956, 353_400)}\n`,
  );
  assert.deepEqual(
    await readCodexContext(threadId, currentTurn),
    { used: 232_956, window: 353_400, windowEstimated: false },
    "文件查找、尾读和严格解析应能端到端取到当前回合水位",
  );
  assert.equal(await readCodexContext("missing-thread", currentTurn), null, "找不到 rollout 就安静退化成无水位");

  const codexEvents = await parseFakeCodex([
    { type: "thread.started", thread_id: threadId },
    { type: "turn.completed", usage: { input_tokens: 240_000, cached_input_tokens: 220_000, output_tokens: 800 } },
  ], { initialThreadId: "", contextNotBeforeMs: currentTurn });
  assert.deepEqual(
    codexEvents.map((event) => event.kind),
    ["session", "usage", "context", "done"],
    "Codex 水位必须在 done 前接入事件流，后续落库才看得到",
  );
  assert.deepEqual(codexEvents[2]?.context, { used: 232_956, window: 353_400, windowEstimated: false });

  writeFileSync(
    join(rolloutDir, `rollout-2026-08-07T11-00-00-${threadId}.jsonl`),
    `${tokenCount(oldAt, 117_016, 353_400)}\n${JSON.stringify({ timestamp: currentAt, type: "event_msg", payload: { type: "token_usage" } })}\n`,
  );
  const unavailableEvents = await parseFakeCodex([
    { type: "thread.started", thread_id: threadId },
    { type: "turn.completed", usage: { input_tokens: 240_000, cached_input_tokens: 220_000, output_tokens: 800 } },
  ], { initialThreadId: "", contextNotBeforeMs: currentTurn });
  assert.deepEqual(
    unavailableEvents.map((event) => event.kind),
    ["session", "usage", "context", "done"],
    "读取失败也要发 context 事件，才能清掉数据库旧水位",
  );
  assert.deepEqual(
    unavailableEvents[2]?.context,
    { used: 0, window: null, windowEstimated: false },
    "私有格式变化后必须发没采到哨兵，清掉旧值且不显示水位",
  );

  console.log("Token 账本验证通过：Claude 增量、Codex 累计求差、历史纠偏、水位覆盖");
} finally {
  rmSync(root, { recursive: true, force: true });
}

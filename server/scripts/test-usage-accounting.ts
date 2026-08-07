// Token 账本的三处要害，在**真数据库**上钉住。
//
// ① 口径要能跨执行器相加：codex 的 `input_tokens` **已含**命中缓存的那部分，
//    claude 的没有。采集处不减出来的话，同样的花费在两家 CLI 上算出来的合计
//    不一样，任务级的「所有会话之和」就是一笔糊涂账。
// ② 「没报账」≠「花了 0」：不报账的 CLI / 本功能之前建的会话行必须读回 null，
//    界面才能区分「这家不报」和「真没花」。费用同理——codex 不报价，它的回合
//    不能被算成 $0 摊进总额。
// ③ 累加而不是覆盖：一条 sessions 行会被复用（--resume 续跑、常驻调度台每个
//    回合都记在同一行），跟 active_ms 同一副形状。
// ④ **但上下文水位恰恰相反，是覆盖**：它是「此刻装了多少」，累加会得出一个没有
//    物理意义的数（流水 18M 的会话水位可能才 12 万）。同一个文件里两种账并存，
//    所以这条必须在测试里钉死。
//
// Run: npm -w server run test:usage
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "harness-usage-"));
process.env.HARNESS_DB = join(root, "harness.db");

const { db, ensureSchema } = await import("../src/db/index.js");
const { sessions } = await import("../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { addSessionUsage, sessionUsage, setSessionContext, sessionContext } = await import("../src/usage.js");
const { claudeUsage, claudeContextUsed, claudeContextWindow, parseClaudeStream } = await import("../src/executors/claude.js");
const { codexUsage } = await import("../src/executors/codex.js");
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

  // ── ② 落库与累加 ─────────────────────────────────────────────────────────
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

  await addSessionUsage(sessId, claude);
  await addSessionUsage(sessId, codex); // 换执行器续跑：同一行上继续累加
  const after = await db.select().from(sessions).where(eq(sessions.id, sessId)).get();
  const total = sessionUsage(after!);
  assert.ok(total);
  assert.equal(total.input, 6_808);
  assert.equal(total.output, 2_240);
  assert.equal(total.cacheRead, 40_000);
  assert.equal(total.cacheWrite, 500);
  assert.equal(total.reasoning, 640);
  assert.equal(total.turns, 2);
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

  // ── ③ 单轮的账要能落进 trace，刷新后按回合回放 ───────────────────────────
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

  // ── ④ 水位是覆盖不是累加 ─────────────────────────────────────────────────
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

  // 没有窗口 → 没有比例。宁可界面上不显示百分比，也不许编一个分母出来。
  assert.equal(contextRatio({ used: 1_000, window: null, windowEstimated: false }), null);
  assert.equal(hasContext({ used: 0, window: 200_000, windowEstimated: false }), false, "0 = 没采到");
  assert.equal(guessContextWindow("claude-opus-5"), 200_000);
  assert.equal(guessContextWindow("gpt-5.6-sol"), null, "猜不出就是 null，不许瞎垫一个");

  // claude 的水位取**单次调用**的输入规模（含缓存命中的那部分——它确实在上下文里）。
  assert.equal(claudeContextUsed({ input_tokens: 5, cache_read_input_tokens: 116_000, cache_creation_input_tokens: 1_011 }), 117_016);
  assert.equal(claudeContextUsed(undefined), 0);

  // ── ⑤ 分母:自报永远压过猜测 ──────────────────────────────────────────────
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

  console.log("Token 账本验证通过：口径可相加、未报账为 null、跨回合累加、单轮可回放、水位覆盖不累加、窗口自报压过猜测");
} finally {
  rmSync(root, { recursive: true, force: true });
}

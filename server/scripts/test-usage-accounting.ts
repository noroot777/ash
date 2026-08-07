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
//
// Run: npm -w server run test:usage
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "harness-usage-"));
process.env.HARNESS_DB = join(root, "harness.db");

const { db, ensureSchema } = await import("../src/db/index.js");
const { sessions } = await import("../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { addSessionUsage, sessionUsage } = await import("../src/usage.js");
const { claudeUsage } = await import("../src/executors/claude.js");
const { codexUsage } = await import("../src/executors/codex.js");
const { appendSessionTrace, parseSessionTrace, sessionTracePath } = await import("../src/transcript.js");
const { addUsage, sumUsage, usageTotal, hasUsage, formatTokens, formatCost } = await import("@harness/shared/usage");

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

  console.log("Token 账本验证通过：口径可相加、未报账为 null、跨回合累加、单轮可回放");
} finally {
  rmSync(root, { recursive: true, force: true });
}

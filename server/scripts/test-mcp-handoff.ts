// 「交卷丢了回头补捞」的回归。
//
// 这条路径的危险不在「补不到」，而在**补多了**：它替 agent 重放动作，一旦口径松了，
// 就会把 server 明确拒绝过的调用偷偷做成、把 agent 后来自己改的口覆盖回去、或者拿着
// 别的任务的参数往本任务身上写。所以下面的红灯里，「不该补的没补」占了大多数。
//
// fixture 用的是 2026-08-06 那次真实事故的原始流（codex 跑完验证、report_stage 连撞
// 两次 Transport closed），格式一个字节都没改。
// Run: npm -w server run test:mcp-handoff
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "harness-mcp-handoff-"));
process.env.HARNESS_DB = join(root, "harness.db");

const { collectHarnessMcpCalls, planReplay, replayUndeliveredMcpCalls } = await import("../src/mcp-handoff.js");
const { RUNS_DIR } = await import("../src/paths.js");
const { sessionTranscriptPath } = await import("../src/transcript.js");
const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, sessions, tasks } = await import("../src/db/schema.js");
const { eq } = await import("drizzle-orm");

await ensureSchema();

const TASK = "handoff00001";

// ── 真实事故的原始流（codex）────────────────────────────────────────────────
const codexFailed = [
  `{"type":"item.started","item":{"id":"item_54","type":"mcp_tool_call","server":"harness","tool":"report_stage","arguments":{"taskId":"${TASK}","stage":"verified"},"result":null,"error":null,"status":"in_progress"}}`,
  `{"type":"item.completed","item":{"id":"item_54","type":"mcp_tool_call","server":"harness","tool":"report_stage","arguments":{"taskId":"${TASK}","stage":"verified"},"result":null,"error":{"message":"tool call error: tool call failed for \`harness/report_stage\`\\n\\nCaused by:\\n    Transport closed"},"status":"failed"}}`,
  `{"type":"item.completed","item":{"id":"item_55","type":"mcp_tool_call","server":"harness","tool":"report_stage","arguments":{"taskId":"${TASK}","stage":"verified"},"result":null,"error":{"message":"tool call error: tool call failed for \`harness/report_stage\`\\n\\nCaused by:\\n    Transport closed"},"status":"failed"}}`,
].join("\n");

const writeStream = (taskId: string, sess: string, turn: string, body: string): void => {
  const dir = join(RUNS_DIR, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sess}-${turn.replace(/[^0-9A-Za-z]/g, "")}.agent-out.jsonl`), body);
};

// ── ① codex 流：认出失败调用，参数完整 ───────────────────────────────────────
writeStream(TASK, "sessA", "2026-08-06T04:08:22.911Z", codexFailed);
const codexCalls = collectHarnessMcpCalls(
  join(RUNS_DIR, TASK, "sessA-20260806T040822911Z.agent-out.jsonl"), "codex",
);
assert.equal(codexCalls.length, 2, "两条 completed 都要认出来（in_progress 那条不算）");
assert.equal(codexCalls[0].tool, "report_stage");
assert.equal(codexCalls[0].ok, false);
assert.equal(codexCalls[0].args.stage, "verified", "参数必须原样带出来，补录靠的就是它");

const codexPlan = planReplay(codexCalls, TASK);
assert.equal(codexPlan.length, 1, "同一个工具失败两次只补一笔（去重）");
assert.equal(codexPlan[0].args.stage, "verified");

// ── ② claude 流：tool_use 与 tool_result 靠 id 配对 ──────────────────────────
const claudeStream = [
  `{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_1","name":"mcp__harness__complete_task","input":{}}}}`,
  `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"mcp__harness__complete_task","input":{"taskId":"${TASK}"}}]}}`,
  `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","is_error":true,"content":"MCP server is not connected"}]}}`,
].join("\n");
writeStream(TASK, "sessB", "2026-08-06T05:00:00.000Z", claudeStream);
const claudeCalls = collectHarnessMcpCalls(
  join(RUNS_DIR, TASK, "sessB-20260806T050000000Z.agent-out.jsonl"), "claude",
);
assert.equal(claudeCalls.length, 1, "流式增量那条 tool_use（input 空）不该被当成第二次调用");
assert.equal(claudeCalls[0].tool, "complete_task");
assert.equal(claudeCalls[0].args.taskId, TASK, "取的必须是 assistant 那条完整参数，不是流式空壳");
assert.equal(planReplay(claudeCalls, TASK).length, 1);

// ── ③ 白名单：有后果的调用一律不补 ───────────────────────────────────────────
// 这是整条路径最要命的一条红灯：accept_task 补一次 = 多合并一次代码。
const dangerous = ["accept_task", "dispatch", "run_task", "stop_task", "batch_create_tasks"].map((tool) => ({
  tool, args: { taskId: TASK }, ok: false, error: "Transport closed",
}));
assert.equal(planReplay(dangerous, TASK).length, 0, "非幂等/有外部后果的工具绝不自动重放");

// ── ④ 口径：server 明确拒绝过的不补 ─────────────────────────────────────────
// 409 是「收到了并拒绝」，重放它等于把 server 的拒绝偷偷绕过去。
assert.equal(
  planReplay([{ tool: "complete_task", args: { taskId: TASK }, ok: false, error: "HTTP 409 — 只能在任务正在运行时确认完成" }], TASK).length,
  0, "业务错误不是「没送达」，不能补",
);

// ── ⑤ agent 自己重试成功了：别拿旧的失败记录去盖 ─────────────────────────────
const selfHealed = [
  { tool: "report_stage", args: { taskId: TASK, stage: "verify_failed" }, ok: false, error: "Transport closed" },
  { tool: "report_stage", args: { taskId: TASK, stage: "verified" }, ok: true },
];
assert.equal(planReplay(selfHealed, TASK).length, 0, "后来调成了就什么都不用补");

// ── ⑥ 改口：同一个工具多次失败，算数的是最后一次 ────────────────────────────
const changedMind = [
  { tool: "report_stage", args: { taskId: TASK, stage: "verify_failed" }, ok: false, error: "Transport closed" },
  { tool: "report_stage", args: { taskId: TASK, stage: "verified" }, ok: false, error: "Transport closed" },
];
assert.equal(planReplay(changedMind, TASK)[0].args.stage, "verified", "先报没过又改口通过，补后者");

// ── ⑦ 跨任务的调用不替它做主 ────────────────────────────────────────────────
assert.equal(
  planReplay([{ tool: "complete_task", args: { taskId: "someoneElse" }, ok: false, error: "Transport closed" }], TASK).length,
  0, "参数指向别的任务时不补（那是团队调度/批量建任务的活）",
);

// ── ⑧ 交了卷就别再替它按暂停 ────────────────────────────────────────────────
const pausedThenDone = [
  { tool: "pause_task", args: { taskId: TASK, resumePrompt: "接着做 tts" }, ok: false, error: "Transport closed" },
  { tool: "complete_task", args: { taskId: TASK }, ok: true },
];
assert.equal(planReplay(pausedThenDone, TASK).length, 0, "agent 最终确认完成了，中途想暂停的念头作废");

// ── ⑨ 顺序：先写结论，再确认完成 ────────────────────────────────────────────
const both = [
  { tool: "complete_task", args: { taskId: TASK }, ok: false, error: "Transport closed" },
  { tool: "report_stage", args: { taskId: TASK, stage: "verified" }, ok: false, error: "Transport closed" },
];
assert.deepEqual(planReplay(both, TASK).map((c) => c.tool), ["report_stage", "complete_task"]);

// ── ⑩ 端到端：真库上补录，stage 落地 + 时间线留痕 ───────────────────────────
const at = new Date().toISOString();
await db.insert(projects).values({ id: "p1", name: "handoff", repoPath: root, createdAt: at, updatedAt: at });
await db.insert(tasks).values({
  id: TASK, projectId: "p1", title: "验证结论丢了", body: "", mode: "single", status: "running",
  stage: "verifying", labels: "[]", dependsOn: "[]", resumeDependsOn: "[]",
  agentType: "codex", autoTitle: false, useWorktree: false, createdAt: at, updatedAt: at,
});
// 时间线是写进「最近一条 session」的会话 Markdown 的（appendTaskTimeline），没有 session
// 就悄悄不写——补录留痕这条断言必须建在真有会话的前提上。
await db.insert(sessions).values({
  id: "sessA", taskId: TASK, role: "main", agentType: "codex",
  executor: "codex", target: "codex", startedAt: at,
});

const applied = await replayUndeliveredMcpCalls({
  taskId: TASK, sessId: "sessA", turnStart: "2026-08-06T04:08:22.911Z", agentType: "codex",
});
assert.equal(applied, 1, "该补的那一笔要真补上");
const after = (await db.select().from(tasks).where(eq(tasks.id, TASK))).at(0)!;
assert.equal(after.stage, "verified", "验证结论必须落到 tasks.stage —— concludeRound 只认这里");

const timeline = readFileSync(sessionTranscriptPath(TASK, "sessA"), "utf8");
assert.ok(
  timeline.includes("补录"),
  "补录必须留痕，否则用户看到的是「我没点它自己就过了」",
);

// ── ⑪ 没有输出文件（非 detached 的老路径）：安静返回，不炸 ──────────────────
assert.equal(
  await replayUndeliveredMcpCalls({ taskId: TASK, sessId: "nope", turnStart: at, agentType: "codex" }),
  0,
);

// ── ⑫ 事前预警：谁手里还握着 MCP 通道（restart.sh 第 3 步的闸）──────────────
// 这一段跟上面的补捞是同一件事的两头：能不掐断就别掐断，掐断了才谈补捞。
const { holdersOf, isMcpProcess, parsePsTable } = await import("../src/mcp-holders.js");

assert.ok(isMcpProcess("node /Users/x/harness/mcp/dist/index.js"));
assert.ok(isMcpProcess("/usr/local/bin/node /repo/mcp/dist/index.js"), "带绝对路径的 node 也算");
assert.equal(
  isMcpProcess("claude --mcp-config /Users/x/harness/mcp/dist/index.js"), false,
  "把同一个路径写在参数里的 CLI 本体不算 —— 认错了就会把每个 agent 都报成持有者",
);
assert.equal(isMcpProcess("node /repo/server/dist/index.js"), false, "server 自己不算");

const psTable = parsePsTable([
  "  100     1 codex exec --json",
  "  101   100 node /Users/x/harness/mcp/dist/index.js",   // 直接子进程
  "  150   200 bash -lc npm test",
  "  151   150 node /Users/x/harness/mcp/dist/index.js",   // 隔了一层 shell
  "  200     1 claude --mcp-config /Users/x/harness/mcp/dist/index.js",
  "  300     1 node /elsewhere/mcp/dist/index.js",         // 没有 agent 祖先
].join("\n"));
assert.equal(psTable.length, 6, "ps 表逐行解析");
assert.deepEqual(holdersOf(psTable, [100]).sort(), [100]);
assert.deepEqual(holdersOf(psTable, [100, 200]).sort(), [100, 200], "隔着 shell 的孙进程也要认出来");
assert.deepEqual(holdersOf(psTable, [999]), [], "不相干的 MCP 进程不算在谁头上");
assert.deepEqual(holdersOf(psTable, []), [], "没有在跑的 agent → 随便刷新");

// ── ⑬ 宽严不对称是设计，不是疏忽 ────────────────────────────────────────────
// 补捞侧敢认「连上了又断」，是因为它另外叠了幂等白名单；MCP 端的进程内重试对所有
// 工具一视同仁，认了 ECONNRESET 就等于允许 dispatch 被做两遍。哪天有人图省事把宽的
// 那份接过去统一口径，这两条会先红。
const { UNDELIVERED_NET_CODES, isUndeliveredMcpFailure } = await import("@harness/shared/mcp-delivery");
assert.ok(
  isUndeliveredMcpFailure({ message: "socket hang up (ECONNRESET)" }),
  "补捞侧认「连上了又断」——最坏也只是把同一个 stage 再写一遍",
);
assert.equal(
  UNDELIVERED_NET_CODES.has("ECONNRESET"), false,
  "MCP 端重试绝不能认 ECONNRESET：它对 dispatch 一视同仁，重试就是多派一批执行者",
);

console.log("mcp handoff ok");
rmSync(root, { recursive: true, force: true });
rmSync(join(RUNS_DIR, TASK), { recursive: true, force: true });
process.exit(0);

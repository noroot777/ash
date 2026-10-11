import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, eq } from "drizzle-orm";
import type { AgentEvent } from "@ash/shared";
import { validateCliCommand } from "@ash/shared/cli-commands";

const root = await realpath(await mkdtemp(join(tmpdir(), "ash-goal-live-")));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_ALLOW_REAL_AGENT = "1";
const { CodexExecutor } = await import("../src/executors/codex.js");
const home = join(root, "codex");
const workspace = join(root, "workspace");
let count = 0;
let lastUserInput = "";
let lastModelInput = "";
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  assert.ok(request.url?.includes("/responses"));
  count++;
  const body = JSON.parse(Buffer.concat(chunks).toString());
  lastUserInput = JSON.stringify(body.input?.findLast((item: any) => item.role === "user") ?? {});
  lastModelInput = JSON.stringify(body.input);
  const reviewing = JSON.stringify(body.input).includes("review");
  const text = reviewing ? JSON.stringify({ findings: [], overall_correctness: "patch is correct", overall_explanation: "Local fixture has no findings.", overall_confidence_score: 1 }) : `Goal step ${count}; more work remains.`;
  const item = { type: "message", id: `msg_${count}`, role: "assistant", phase: "final_answer", content: [{ type: "output_text", text }] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id: `response_${count}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: item.content[0]!.text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `response_${count}`, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
try {
  await mkdir(home);
  await mkdir(workspace);
  await writeFile(join(home, "config.toml"), `model = "gpt-5.4"\nmodel_provider = "goal_fixture"\ncheck_for_update_on_startup = false\n[model_providers.goal_fixture]\nname = "Goal fixture"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`);
  const executor = new CodexExecutor();
  const handle = executor.runSteerable({ cwd: workspace, prompt: "ash goal fixture; continue until the budget runs out", cliCommand: validateCliCommand("codex", "/goal 持续推进直到预算用完 --budget 150")!, cliState: { goal: { objective: "持续推进直到预算用完", status: "active", tokenBudget: 150 } }, env: { CODEX_HOME: home } });
  const events: AgentEvent[] = [];
  const deadline = setTimeout(() => handle.kill(), 30_000);
  try { for await (const event of handle.events) events.push(event); }
  finally { clearTimeout(deadline); await handle.cleanup?.(); }
  assert.equal(events.find((event) => event.kind === "done")?.exitStatus, 0, events.filter((event) => event.kind === "error").map((event) => event.message).join("\n"));
  assert.ok(count >= 2, `real Codex must continue across turns: ${count}`);
  assert.equal(handle.goal?.()?.status, "budgetLimited");
  assert.ok(events.some((event) => event.kind === "system" && event.level === "notice" && /预算已耗尽/.test(event.text)));
  console.log(`real Codex /goal completed ${count} locally mocked turns and stopped at its native token budget`);
  let sessionId = events.find((event) => event.kind === "session")?.cliSessionId;
  assert.ok(sessionId);
  for (const text of ["/status", "/mcp", "/ps", "/stop", "/hooks", "/plugins", "/debug-config", "/personality friendly", "/fast off", "/rename 原生测试会话", "/plan", "/plan off", "/compact", "/review 检查当前会话的测试夹具", "/fork", "/new"]) {
    const trace = { eventsPath: join(root, "command-events.jsonl"), stderrPath: join(root, "command-stderr.log"), diagnosticsPath: join(root, "command-diagnostics.json") };
    const command = executor.runSteerable({ cwd: workspace, prompt: text, trace, cliCommand: validateCliCommand("codex", text)!, cliState: { plan: text === "/plan", personality: "friendly", serviceTier: "default" }, sessionId, env: { CODEX_HOME: home } });
    const output: AgentEvent[] = [];
    const timeout = setTimeout(() => command.kill(), 15_000);
    try { for await (const event of command.events) output.push(event); }
    finally { clearTimeout(timeout); await command.cleanup?.(); }
    const diagnostics = await readFile(trace.diagnosticsPath, "utf8");
    const wire = output.find((event) => event.kind === "done")?.exitStatus !== 0 ? (await readFile(trace.eventsPath, "utf8")).split("\n").filter((line) => /turn\/started|turn\/completed|reviewThreadId/.test(line)).slice(-7).join("\n") : "";
    assert.equal(output.find((event) => event.kind === "done")?.exitStatus, 0, `${text}: ${diagnostics}\n${wire}`);
    sessionId = output.find((event) => event.kind === "session")?.cliSessionId ?? sessionId;
  }
  console.log("real Codex inspection, local plugin inventory, settings, plan, compact, review, fork and new RPCs: passed");
  process.env.CODEX_HOME = home;
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { agents, projects, tasks, sessions } = await import("../src/db/schema.js");
  const { continueTask } = await import("../src/orchestrator.js");
  const { readCliState } = await import("../src/task-cli-state.js");
  await ensureSchema();
  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "live-project", name: "native CLI integration", repoPath: workspace, useWorktreeDefault: false, createdAt: at });
  await db.insert(agents).values({ id: "first-profile", name: "codex@fixture", type: "codex", isDefault: true });
  await db.insert(tasks).values({ id: "live-task", projectId: "live-project", title: "native CLI", body: "验证原生命令", mode: "single", agentType: "codex", status: "done", stage: "accepted", autoTitle: false, useWorktree: false, createdAt: at, updatedAt: at });
  const task = async () => (await db.select().from(tasks).where(eq(tasks.id, "live-task")))[0]!;
  assert.equal(await continueTask("live-task", "/plan"), true);
  assert.equal(readCliState((await task()).cliState, "codex").plan, true);
  const beforePlan = count;
  assert.equal(await continueTask("live-task", "拆解下一步"), true);
  if (count === beforePlan) {
    const { sessionTranscriptPath } = await import("../src/transcript.js");
    const recorded = await db.select().from(sessions).where(eq(sessions.taskId, "live-task"));
    for (const session of recorded) console.log((await readFile(sessionTranscriptPath("live-task", session.id), "utf8")).slice(-1600));
  }
  assert.match(lastUserInput, /本回合只讨论计划/);
  assert.equal((await task()).status, "done");
  assert.equal((await task()).stage, "accepted");
  assert.equal(await continueTask("live-task", "旁路核对逻辑", { sideTurn: true }), true);
  assert.doesNotMatch(lastUserInput, /本回合只讨论计划/);
  assert.equal(readCliState((await task()).cliState, "codex").plan, true);
  await db.update(agents).set({ isDefault: false }).where(eq(agents.id, "first-profile"));
  await db.insert(agents).values({ id: "second-profile", name: "codex@other-fixture", type: "codex", isDefault: true });
  assert.equal(await continueTask("live-task", "切换默认执行器后的普通消息"), true);
  assert.doesNotMatch(lastUserInput, /本回合只讨论计划/);
  assert.equal(readCliState((await task()).cliState, "codex").profileId, "second-profile");
  assert.equal(readCliState((await task()).cliState, "codex").plan, undefined);
  const beforeGoal = count;
  assert.equal(await continueTask("live-task", "/goal 自动推进直到预算用完 --budget 150"), true);
  assert.ok(count >= beforeGoal + 2);
  assert.equal((await task()).status, "paused");
  assert.equal((await task()).goalTurn, false);
  assert.equal(readCliState((await task()).cliState, "codex").goal?.status, "budgetLimited");
  assert.equal(readCliState((await task()).cliState, "codex").goalHold, true);
  assert.equal(await continueTask("live-task", "/goal"), true);
  assert.equal((await task()).status, "paused");
  const currentSession = async () => (await db.select().from(sessions).where(eq(sessions.taskId, "live-task")).orderBy(desc(sessions.turnStartedAt), desc(sessions.startedAt)))[0]!;
  const originalSessionId = (await currentSession()).cliSessionId;
  assert.equal(await continueTask("live-task", "/new"), true);
  assert.ok(!(await currentSession()).cliSessionId);
  assert.equal(await continueTask("live-task", "新会话独立问题", { sideTurn: true }), true);
  assert.ok((await currentSession()).cliSessionId);
  assert.notEqual((await currentSession()).cliSessionId, originalSessionId);
  assert.doesNotMatch(lastModelInput, /自动推进直到预算用完/);
  const newSessionId = (await currentSession()).cliSessionId;
  assert.equal(await continueTask("live-task", "/clear"), true);
  assert.equal(await continueTask("live-task", "清空后独立问题", { sideTurn: true }), true);
  assert.notEqual((await currentSession()).cliSessionId, newSessionId);
  assert.doesNotMatch(lastModelInput, /新会话独立问题/);
  console.log("real ash continuation: plan scope, side-turn isolation, native multi-turn goal, durable budget pause and inspection: passed");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { dbClient } = await import("../src/db/index.js");
  dbClient.close();
  await rm(root, { recursive: true, force: true });
}

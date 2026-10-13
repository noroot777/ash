import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, eq } from "drizzle-orm";
import type { AgentEvent } from "@ash/shared";
import { hasCliGoalHold, validateCliCommand } from "@ash/shared/cli-commands";

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
const reasoningEfforts: string[] = [];
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  assert.ok(request.url?.includes("/responses"));
  count++;
  const body = JSON.parse(Buffer.concat(chunks).toString());
  reasoningEfforts.push(body.reasoning?.effort);
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
  await writeFile(join(home, "config.toml"), `model = "gpt-5.4"\nmodel_reasoning_effort = "high"\nmodel_provider = "goal_fixture"\ncheck_for_update_on_startup = false\n[model_providers.goal_fixture]\nname = "Goal fixture"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`);
  const executor = new CodexExecutor({ reasoningEffort: "xhigh" });
  const handle = executor.runSteerable({ cwd: workspace, prompt: "ash goal fixture; continue until the budget runs out", cliCommand: validateCliCommand("codex", "/goal 持续推进直到预算用完 --budget 150")!, cliState: { goal: { objective: "持续推进直到预算用完", status: "active", tokenBudget: 150 } }, env: { CODEX_HOME: home } });
  const events: AgentEvent[] = [];
  const deadline = setTimeout(() => handle.kill(), 30_000);
  try { for await (const event of handle.events) events.push(event); }
  finally { clearTimeout(deadline); await handle.cleanup?.(); }
  assert.equal(events.find((event) => event.kind === "done")?.exitStatus, 0, events.filter((event) => event.kind === "error").map((event) => event.message).join("\n"));
  assert.ok(count >= 2, `real Codex must continue across turns: ${count}`);
  assert.ok(reasoningEfforts.every((effort) => effort === "xhigh"), JSON.stringify(reasoningEfforts));
  assert.equal(handle.goalStarted?.(), true);
  assert.equal(handle.goal?.()?.status, "budgetLimited");
  assert.ok(events.some((event) => event.kind === "system" && event.level === "notice" && /预算已耗尽/.test(event.text)));
  console.log(`real Codex /goal completed ${count} locally mocked turns and stopped at its native token budget`);
  let sessionId = events.find((event) => event.kind === "session")?.cliSessionId;
  assert.ok(sessionId);
  for (const invocation of [{ prompt: "普通测试回合", plan: false }, { prompt: "计划状态下的测试回合", plan: true }, { prompt: "/plan 分析测试夹具", plan: true }]) {
    const before = reasoningEfforts.length;
    const run = executor.runSteerable({ cwd: workspace, prompt: invocation.prompt, cliCommand: validateCliCommand("codex", invocation.prompt) ?? undefined, cliState: { plan: invocation.plan }, sessionId, env: { CODEX_HOME: home } });
    const output: AgentEvent[] = [];
    const timeout = setTimeout(() => run.kill(), 15_000);
    try { for await (const event of run.events) output.push(event); }
    finally { clearTimeout(timeout); await run.cleanup?.(); }
    assert.equal(output.find((event) => event.kind === "done")?.exitStatus, 0, JSON.stringify(output.filter((event) => event.kind === "error")));
    assert.ok(reasoningEfforts.length > before);
    assert.ok(reasoningEfforts.slice(before).every((effort) => effort === "xhigh"), JSON.stringify(reasoningEfforts.slice(before)));
  }
  console.log("real Codex preserves xhigh in ordinary, planning, /plan prompt, and automatic goal turns");
  for (const text of ["/goal clear", "/status", "/mcp", "/ps", "/stop", "/hooks", "/plugins", "/debug-config", "/personality friendly", "/fast off", "/rename 原生测试会话", "/plan", "/plan off", "/compact", "/review 检查当前会话的测试夹具", "/fork", "/new"]) {
    const trace = { eventsPath: join(root, "command-events.jsonl"), stderrPath: join(root, "command-stderr.log"), diagnosticsPath: join(root, "command-diagnostics.json") };
    const command = executor.runSteerable({ cwd: workspace, prompt: text, trace, cliCommand: validateCliCommand("codex", text)!, cliState: { plan: text === "/plan", personality: "friendly", serviceTier: "default" }, sessionId, env: { CODEX_HOME: home } });
    const output: AgentEvent[] = [];
    const timeout = setTimeout(() => command.kill(), 15_000);
    try { for await (const event of command.events) output.push(event); }
    finally { clearTimeout(timeout); await command.cleanup?.(); }
    const diagnostics = await readFile(trace.diagnosticsPath, "utf8");
    const wire = output.find((event) => event.kind === "done")?.exitStatus !== 0 ? (await readFile(trace.eventsPath, "utf8")).split("\n").filter((line) => /turn\/started|turn\/completed|reviewThreadId/.test(line)).slice(-7).join("\n") : "";
    assert.equal(output.find((event) => event.kind === "done")?.exitStatus, 0, `${text}: ${diagnostics}\n${wire}`);
    if (text === "/goal clear") assert.ok(output.some((event) => event.kind === "text" && /当前没有目标/.test(event.text)), "clearing a known native goal must display its command result");
    sessionId = output.find((event) => event.kind === "session")?.cliSessionId ?? sessionId;
  }
  console.log("real Codex inspection, local plugin inventory, settings, plan, compact, review, fork and new RPCs: passed");
  process.env.CODEX_HOME = home;
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { agents, projects, tasks, sessions } = await import("../src/db/schema.js");
  const { continueTask, runTask } = await import("../src/orchestrator.js");
  const { resumeOrRunTask } = await import("../src/task-resume.js");
  const { readCliState } = await import("../src/task-cli-state.js");
  const { sessionTranscriptPath } = await import("../src/transcript.js");
  await ensureSchema();
  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "live-project", name: "native CLI integration", repoPath: workspace, useWorktreeDefault: false, createdAt: at });
  await db.insert(agents).values({ id: "first-profile", name: "codex@fixture", type: "codex", isDefault: true });
  await db.insert(tasks).values({ id: "ordinary-task", projectId: "live-project", title: "普通续聊", body: "回答普通问题，不设置目标", mode: "single", agentType: "codex", status: "backlog", autoTitle: false, useWorktree: false, createdAt: at, updatedAt: at });
  await runTask("ordinary-task");
  const ordinarySessions = async () => db.select().from(sessions).where(eq(sessions.taskId, "ordinary-task"));
  const originalOrdinarySession = (await ordinarySessions())[0]!;
  assert.ok(originalOrdinarySession.cliSessionId);
  for (const reply of ["再说一句", "还有一句"]) {
    assert.equal(await continueTask("ordinary-task", reply), true);
    const recorded = await ordinarySessions();
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.cliSessionId, originalOrdinarySession.cliSessionId);
    assert.equal(recorded[0]!.exitStatus, 0);
    const transcript = await readFile(sessionTranscriptPath("ordinary-task", recorded[0]!.id), "utf8");
    assert.match(transcript, new RegExp(reply));
    assert.doesNotMatch(transcript, /〔目标〕/, "ordinary replies must not persist phantom goal notifications");
  }
  console.log("real Codex ordinary fresh task and two resumed replies persist no goal notifications: passed");
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
  assert.equal(reasoningEfforts.at(-1), "high");
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
  assert.equal(reasoningEfforts.at(-1), "high");
  assert.equal(readCliState((await task()).cliState, "codex").plan, undefined);
  const beforeGoal = count;
  assert.equal(await continueTask("live-task", "/goal 自动推进直到预算用完 --budget 150"), true);
  assert.ok(count >= beforeGoal + 2);
  assert.ok(reasoningEfforts.slice(beforeGoal).every((effort) => effort === "high"), JSON.stringify(reasoningEfforts.slice(beforeGoal)));
  assert.equal((await task()).status, "paused");
  assert.equal((await task()).goalTurn, false);
  assert.equal(readCliState((await task()).cliState, "codex").goal?.status, "budgetLimited");
  assert.equal(readCliState((await task()).cliState, "codex").goalHold, true);
  assert.equal(await continueTask("live-task", "/goal"), true);
  assert.equal((await task()).status, "paused");
  const savedGoal = readCliState((await task()).cliState, "codex", "second-profile", null);
  const beforeReview = (await task()).cliState;
  assert.equal(await continueTask("live-task", "另一个 profile 的审查旁路", { system: "run", sideTurn: true, agent: "codex", executorId: "first-profile" }), true);
  assert.equal((await task()).cliState, beforeReview);
  assert.doesNotMatch(lastUserInput, /本回合只讨论计划/);
  assert.equal(await continueTask("live-task", "换回另一个 profile 讨论", { agent: "codex", executorId: "first-profile" }), true);
  assert.deepEqual(readCliState((await task()).cliState, "codex", "second-profile", null), savedGoal);
  assert.equal(hasCliGoalHold((await task()).cliState), true);
  assert.equal(await continueTask("live-task", "/goal resume", { agent: "codex", executorId: "second-profile" }), true);
  assert.equal(readCliState((await task()).cliState, "codex", "second-profile", null).goal?.objective, savedGoal.goal?.objective);
  assert.equal(readCliState((await task()).cliState, "codex", "second-profile", null).goal?.tokenBudget, 150);
  assert.ok(readCliState((await task()).cliState, "codex", "second-profile", null).goal!.tokensUsed! >= savedGoal.goal!.tokensUsed!);
  assert.equal((await task()).status, "paused");
  console.log("real Codex cross-profile reply/review preserves budget-limited goal and resumes its own scope: passed");
  const currentSession = async () => (await db.select().from(sessions).where(eq(sessions.taskId, "live-task")).orderBy(desc(sessions.turnStartedAt), desc(sessions.startedAt)))[0]!;
  const parentSessionId = (await currentSession()).cliSessionId;
  const beforeFork = count;
  assert.equal(await continueTask("live-task", "/fork"), true);
  const forkedSession = await currentSession();
  assert.ok(forkedSession.cliSessionId);
  assert.notEqual(forkedSession.cliSessionId, parentSessionId);
  assert.equal(count, beforeFork, "forking must not start a model turn");
  const forkedState = readCliState((await task()).cliState, "codex", "second-profile", null);
  assert.equal(forkedState.goal, null);
  assert.equal(forkedState.goalHold, false);
  assert.equal(forkedState.goalStart, undefined);
  const forkNotice = await readFile(sessionTranscriptPath("live-task", forkedSession.id), "utf8");
  assert.match(forkNotice, /分叉后的会话不保留原目标、预算和已用量/);
  assert.match(forkNotice, /\/goal 描述 重新设置目标/);
  assert.match(forkNotice, /--budget 上限/);
  assert.doesNotMatch(forkNotice, /\/goal resume/);
  assert.equal(await continueTask("live-task", "/goal"), true);
  assert.match(await readFile(sessionTranscriptPath("live-task", (await currentSession()).id), "utf8"), /当前没有目标/);
  const beforeMissingResume = (await task()).cliState;
  await assert.rejects(continueTask("live-task", "/goal resume"), /没有可恢复的目标/);
  assert.equal((await task()).cliState, beforeMissingResume);
  assert.equal(count, beforeFork);
  assert.equal(await continueTask("live-task", "/goal 分叉后的新目标 --budget 250"), true);
  const replacementGoal = readCliState((await task()).cliState, "codex", "second-profile", null).goal!;
  assert.equal(replacementGoal.objective, "分叉后的新目标");
  assert.equal(replacementGoal.tokenBudget, 250);
  assert.equal(replacementGoal.status, "budgetLimited");
  assert.ok(count > beforeFork);
  console.log("real ash /fork clears branch goal without starting a model turn, reports a truthful reset guide, and accepts a new budgeted goal: passed");
  const originalSessionId = (await currentSession()).cliSessionId;
  assert.equal(await continueTask("live-task", "/new"), true);
  assert.ok(!(await currentSession()).cliSessionId);
  assert.equal(await continueTask("live-task", "新会话独立问题", { sideTurn: true }), true);
  assert.ok((await currentSession()).cliSessionId);
  assert.notEqual((await currentSession()).cliSessionId, originalSessionId);
  assert.doesNotMatch(lastModelInput, /自动推进直到预算用完/);
  assert.doesNotMatch(lastModelInput, /分叉后的新目标/);
  const newSessionId = (await currentSession()).cliSessionId;
  assert.equal(await continueTask("live-task", "/clear"), true);
  assert.equal(await continueTask("live-task", "清空后独立问题", { sideTurn: true }), true);
  assert.notEqual((await currentSession()).cliSessionId, newSessionId);
  assert.doesNotMatch(lastModelInput, /新会话独立问题/);
  await db.insert(tasks).values({ id: "restart-plan", projectId: "live-project", title: "restart plan", body: "重新运行后开始实施", mode: "single", agentType: "codex", status: "backlog", autoTitle: false, useWorktree: false, cliState: JSON.stringify({ codex: { profileId: "second-profile", ownerUserId: null, plan: true } }), createdAt: at, updatedAt: at });
  const restartTask = async () => (await db.select().from(tasks).where(eq(tasks.id, "restart-plan")))[0]!;
  const beforeRestart = count;
  await runTask("restart-plan");
  assert.ok(count > beforeRestart);
  assert.equal(readCliState((await restartTask()).cliState, "codex").plan, false);
  assert.doesNotMatch(lastUserInput, /本回合只讨论计划/);
  assert.equal(await continueTask("restart-plan", "/plan"), true);
  assert.equal(readCliState((await restartTask()).cliState, "codex").plan, true);
  const beforeResumedRun = count;
  await resumeOrRunTask("restart-plan", { reason: "run" });
  assert.ok(count > beforeResumedRun);
  assert.equal(readCliState((await restartTask()).cliState, "codex").plan, false);
  assert.doesNotMatch(lastUserInput, /本回合只讨论计划/);
  assert.equal(await continueTask("restart-plan", "/plan"), true);
  assert.equal(await continueTask("restart-plan", "重试后开始实施", { system: "retry" }), true);
  assert.equal(readCliState((await restartTask()).cliState, "codex").plan, false);
  assert.doesNotMatch(lastUserInput, /本回合只讨论计划/);
  for (const reason of ["queue", "group", "wake"] as const) {
    assert.equal(await continueTask("restart-plan", "/plan"), true);
    const beforeAutomatic = count;
    await resumeOrRunTask("restart-plan", { reason });
    assert.ok(count > beforeAutomatic, reason);
    assert.equal(readCliState((await restartTask()).cliState, "codex").plan, false, reason);
    assert.doesNotMatch(lastUserInput, /本回合只讨论计划/, reason);
    assert.equal((await restartTask()).status, "failed", `${reason}: an unconfirmed real CLI turn must not settle done`);
  }
  console.log("real ash fresh run, resumable run and retry exit stored plan mode: passed");
  console.log("real CLI queue/group/wake resumptions exit stored plan mode and require completion: passed");
  console.log("real ash continuation: plan scope, side-turn isolation, native multi-turn goal, durable budget pause and inspection: passed");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { dbClient } = await import("../src/db/index.js");
  dbClient.close();
  await rm(root, { recursive: true, force: true });
}

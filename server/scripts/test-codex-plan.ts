import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { eq } from "drizzle-orm";
import type { AgentEvent } from "@ash/shared";
import { isPlanImplementation, validateCliCommand } from "@ash/shared/cli-commands";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-codex-plan-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_LAX_DONE = "1";
const { openCodexAppServer } = await import("../src/executors/codex-app-server.js");
const { CodexPlanStream } = await import("../src/executors/codex-plan.js");
const { parseSessionTraceLines, sessionTracePath } = await import("../src/transcript.js");
const { assertCodexPlanReady } = await import("../src/task-plan.js");
const { prepareCliInvocation, saveCliState } = await import("../src/task-cli-state.js");
const { inputStartsExecution } = await import("../src/task-continuation-entry.js");
const { nativeCliCommand } = await import("../src/skills.js");
const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks, sessions, sessionTurns } = await import("../src/db/schema.js");
const { setTaskQuestion } = await import("../src/task-question.js");
const { planTranscript } = await import("../../mcp/src/plan-transcript.js");

class PlanServer extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin: Writable;
  exitCode: number | null = null;
  signalCode = null;
  requests: any[] = [];
  constructor() {
    super();
    let input = "";
    this.stdin = new Writable({
      write: (chunk, _encoding, done) => {
        input += chunk.toString();
        for (;;) {
          const newline = input.indexOf("\n");
          if (newline < 0) break;
          const line = input.slice(0, newline);
          input = input.slice(newline + 1);
          if (line) this.receive(JSON.parse(line));
        }
        done();
      },
      final: (done) => { this.exitCode = 0; queueMicrotask(() => this.emit("close", 0, null)); done(); },
    });
  }
  kill() { this.exitCode = 1; this.emit("close", 1, "SIGTERM"); return true; }
  send(message: unknown) { this.stdout.write(`${JSON.stringify(message)}\n`); }
  notify(method: string, params: Record<string, unknown>) { this.send({ method, params: { threadId: "thread", turnId: "turn", ...params } }); }
  receive(message: any) {
    this.requests.push(message);
    if (!message.method || message.id === undefined) return;
    const result = ["thread/start", "thread/resume"].includes(message.method) ? { model: "model", thread: { id: "thread" } }
      : message.method === "turn/start" ? { turn: { id: "turn" } } : {};
    this.send({ id: message.id, result });
    if (message.method === "turn/start") this.notify("turn/started", { turn: { id: "turn" } });
    if (message.method === "turn/interrupt") this.notify("turn/completed", { turn: { id: "turn", status: "interrupted" } });
  }
}

async function runPlan(command?: string) {
  const fake = new PlanServer();
  const handle = openCodexAppServer({
    bin: "codex", args: [], cwd: root, prompt: "完成协议 direction-token 与用户正文", model: "model",
    env: { CODEX_HOME: join(root, "codex") }, cliState: { plan: !command?.includes("implement") },
    ...(command ? { cliCommand: validateCliCommand("codex", command)! } : {}),
    startProcess: () => fake as unknown as ChildProcess,
  });
  const events: AgentEvent[] = [];
  const consumed = (async () => { for await (const event of handle.events) events.push(event); })();
  assert.equal(await handle.inputAccepted, "accepted");
  return { fake, handle, events, consumed };
}

try {
  const current = await runPlan();
  current.fake.notify("item/reasoning/summaryTextDelta", { itemId: "reasoning", delta: "实际思考" });
  current.fake.notify("item/started", { item: { type: "plan", id: "proposal", text: "" } });
  current.fake.notify("item/plan/delta", { itemId: "proposal", delta: "# 草稿\n" });
  current.fake.notify("item/plan/delta", { itemId: "proposal", delta: "临时内容" });
  current.fake.notify("item/completed", { item: { type: "plan", id: "proposal", text: "# 正式计划\n\n- 修复链路" } });
  current.fake.notify("item/plan/delta", { itemId: "proposal", delta: "迟到内容" });
  current.fake.notify("turn/completed", { turn: { id: "turn", status: "completed" } });
  await current.consumed;
  assert.deepEqual(current.events.filter((event) => event.kind === "thinking").map((event) => event.text), ["实际思考"]);
  const plans = current.events.filter((event) => event.kind === "plan");
  assert.equal(plans.length, 4);
  assert.equal(plans[1]!.delta, true);
  assert.equal(plans[2]!.text, "临时内容");
  assert.deepEqual(plans.at(-1), { kind: "plan", id: "proposal", text: "# 正式计划\n\n- 修复链路", status: "complete" });
  assert.equal(current.events.at(-1)?.kind, "done");

  const snapshot = new CodexPlanStream().notification("item/completed", { item: { type: "plan", id: "snapshot", text: "快照也能显示" } });
  assert.equal(snapshot?.status, "complete");
  const asked = await runPlan();
  asked.fake.send({ id: 900, method: "item/tool/requestUserInput", params: { threadId: "thread", turnId: "turn", questions: [
    { id: "period", question: "什么时候重置？", options: [{ label: "每周", description: "周一零点" }] },
    { id: "effect", question: "什么时候生效？", options: [{ label: "立即", description: "保留已用金额" }] },
  ] } });
  await asked.consumed;
  const question = asked.events.find((event) => event.kind === "userInput");
  assert.equal(question?.questions.length, 2);
  assert.deepEqual(question?.questions[0]?.options, ["每周：周一零点"]);
  assert.ok(asked.fake.requests.some((request) => request.method === "turn/interrupt"));
  assert.equal(asked.events.filter((event) => event.kind === "error").length, 0);
  assert.equal(asked.events.find((event) => event.kind === "done")?.exitStatus, 0);

  const implementation = await runPlan("/plan implement proposal");
  const started = implementation.fake.requests.find((request) => request.method === "turn/start");
  assert.equal(started.params.collaborationMode.mode, "default");
  assert.match(started.params.input[0].text, /完成协议 direction-token/);
  assert.match(started.params.input[0].text, /开始实施/);
  implementation.fake.notify("turn/completed", { turn: { id: "turn", status: "completed" } });
  await implementation.consumed;
  assert.equal(isPlanImplementation(validateCliCommand("codex", "/plan implement proposal")), true);
  assert.equal(inputStartsExecution("codex", "/plan implement proposal"), true);
  assert.equal(nativeCliCommand("codex", "/plan implement proposal"), null);
  assert.equal(inputStartsExecution("codex", "/plan off"), false);

  await ensureSchema();
  const at = "2026-11-19T01:00:00.000Z";
  await db.insert(projects).values({ id: "project", name: "plan", repoPath: root, createdAt: at });
  await db.insert(tasks).values({ id: "task", projectId: "project", title: "plan", body: "plan", mode: "single", status: "paused", agentType: "codex", createdAt: at, updatedAt: at });
  await db.insert(sessions).values({ id: "session", taskId: "task", role: "single", agentType: "codex", executor: "codex", executorId: "profile", runOwnerUserId: null, cwd: root, startedAt: at, turnStartedAt: at, endedAt: at });
  mkdirSync(join(root, "runs", "task"), { recursive: true });
  const trace = plans.map((event) => ({ at, turnStartedAt: at, event }));
  writeFileSync(sessionTracePath("task", "session"), trace.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  assert.equal(parseSessionTraceLines(trace.map((entry) => JSON.stringify(entry)).join("\n") + "\n").entries.length, 4);
  await assertCodexPlanReady("task", "profile", null, "proposal");
  await assert.rejects(assertCodexPlanReady("task", "profile", null, "old-proposal"), /新版本/);
  await assert.rejects(assertCodexPlanReady("task", "other-profile", null, "proposal"), /没有可实施/);
  await assert.rejects(assertCodexPlanReady("task", "profile", "another-owner", "proposal"), /没有可实施/);
  await db.insert(sessionTurns).values({ id: "plan-turn", sessionId: "session", taskId: "task", startedAt: at, endedAt: at, outcome: "failed" });
  await assert.rejects(assertCodexPlanReady("task", "profile", null, "proposal"), /未正常完成/);
  await db.update(sessionTurns).set({ outcome: "stopped" }).where(eq(sessionTurns.id, "plan-turn"));
  await assert.rejects(assertCodexPlanReady("task", "profile", null, "proposal"), /未正常完成/);
  await db.update(sessionTurns).set({ outcome: "completed" }).where(eq(sessionTurns.id, "plan-turn"));
  await db.update(sessions).set({ turnStartedAt: "2026-11-19T02:00:00.000Z" }).where(eq(sessions.id, "session"));
  await assert.rejects(assertCodexPlanReady("task", "profile", null, "proposal"), /没有已完成的计划/);
  await db.update(sessions).set({ turnStartedAt: at }).where(eq(sessions.id, "session"));
  await saveCliState("task", "codex", { profileId: "profile", ownerUserId: null, plan: true });
  await saveCliState("task", "codex", { profileId: "other-profile", ownerUserId: null, plan: true });
  const row = async () => (await db.select().from(tasks).where(eq(tasks.id, "task")))[0]!;
  const approved = await prepareCliInvocation(await row(), "codex", "/plan implement proposal", "profile", null);
  assert.equal(approved.cliState.plan, false);
  const other = await prepareCliInvocation(await row(), "codex", "继续规划", "other-profile", null);
  assert.equal(other.cliState.plan, true);
  await assert.rejects(prepareCliInvocation(await row(), "codex", "/plan implement proposal", "profile", null), /已关闭/);

  await db.update(tasks).set({ status: "running", activeTurnToken: "turn-token", activeDirectionToken: "direction" }).where(eq(tasks.id, "task"));
  assert.equal(await setTaskQuestion({ taskId: "task", question: "确认规则", items: question!.questions, currentTurn: { token: "old", directionToken: "direction" } }), false);
  assert.equal(await setTaskQuestion({ taskId: "task", question: "确认规则", items: question!.questions, currentTurn: { token: "turn-token", directionToken: "direction" } }), true);
  assert.match((await row()).questionItems!, /什么时候重置/);
  const exported = planTranscript(trace);
  assert.match(exported, /正式计划/);
  assert.doesNotMatch(exported, /临时内容|迟到内容/);
  console.log("Codex plan streaming, authoritative completion, native questions, scoped implementation and transcript persistence: passed");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}

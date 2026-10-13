import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AgentType, TaskStatus } from "@ash/shared";
import { readCliState, type CliSessionState } from "@ash/shared/cli-commands";
import type { RunOpts } from "../src/executors/types.js";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-goal-queue-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_UPLOADS_DIR = join(root, "uploads");
delete process.env.ASH_ALLOW_REAL_AGENT;
const { db, ensureSchema } = await import("../src/db/index.js");
const { agents, groups, projects, queueItems, scheduledMessages, sessions, tasks } = await import("../src/db/schema.js");
const { CodexExecutor } = await import("../src/executors/codex.js");
const { ClaudeExecutor } = await import("../src/executors/claude.js");
const { saveCliState } = await import("../src/task-cli-state.js");
const { cliGoalScopeSelector } = await import("../src/task-cli-goal-scopes.js");
const { replyToTask } = await import("../src/task-reply.js");
const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
const { continueTask } = await import("../src/orchestrator.js");
const { deliverPendingMessages } = await import("../src/pending-messages.js");
const { claimQueueSeat } = await import("../src/queue-seat.js");
const { queueBlockers } = await import("../src/queues.js");
const { claimTurn, isTurnClaimed, releaseTurn, stopTask } = await import("../src/runs.js");
await ensureSchema();

const invocations = new Map<string, RunOpts[]>();
const holding = new Set<string>();
const finishers = new Map<string, () => void>();
const failures = new Map<string, number>();
const failStarts = new Map<string, "prepare" | "run">();
const originalCodex = CodexExecutor.prototype.runSteerable;
const originalClaude = ClaudeExecutor.prototype.runSteerable;
const originalPrepare = CodexExecutor.prototype.prepareResume;
const claudePrototype = ClaudeExecutor.prototype as typeof ClaudeExecutor.prototype & { prepareResume: typeof originalPrepare };
const originalClaudePrepare = claudePrototype.prepareResume;
function failStart(taskId: string, phase: "prepare" | "run") {
  if (failStarts.get(taskId) !== phase) return;
  failures.set(taskId, (failures.get(taskId) ?? 0) + 1);
  throw new Error(`fixture goal startup failure: ${phase}`);
}
const fixturePrepare: typeof originalPrepare = async function (options) {
  failStart(options.env!.ASH_TASK_ID!, "prepare");
};
const fixtureRun: typeof originalCodex = function (options) {
  const taskId = options.env!.ASH_TASK_ID!;
  invocations.set(taskId, [...invocations.get(taskId) ?? [], options]);
  failStart(taskId, "run");
  const nativeId = options.sessionId ?? `${taskId}-native`;
  const saved = options.cliState?.goal;
  const goal = saved ? { ...saved, status: "active" as const, tokensUsed: saved.tokensUsed || 50, timeUsedSeconds: 21 } : null;
  const complete = holding.has(taskId) ? new Promise<void>((resolve) => finishers.set(taskId, resolve)) : Promise.resolve();
  return {
    sessionId: nativeId, commandLine: "goal queue fixture; no CLI/model", cliCommand: options.cliCommand,
    goal: () => goal, goalStarted: () => !!goal, kill() { finishers.get(taskId)?.(); },
    events: (async function* () {
      yield { kind: "session" as const, cliSessionId: nativeId };
      yield { kind: "text" as const, text: "fixture running" };
      await complete;
      finishers.delete(taskId);
      yield { kind: "done" as const, exitStatus: 0 };
    })(),
  };
};
CodexExecutor.prototype.runSteerable = fixtureRun;
ClaudeExecutor.prototype.runSteerable = fixtureRun;
CodexExecutor.prototype.prepareResume = fixturePrepare;
claudePrototype.prepareResume = fixturePrepare;
const app = new Hono();
app.post("/tasks/:id/reply", (context) => replyToTask(context, context.req.param("id")));
mountTaskRunRoutes(app);
const at = new Date().toISOString();
const row = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
const calls = (taskId: string) => invocations.get(taskId)?.length ?? 0;
const request = (path: string, body = {}) => app.request(path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const reply = (taskId: string, text: string, extra = {}) => request(`/tasks/${taskId}/reply`, { text, ...extra });
async function waitFor(taskId: string, predicate: (task: typeof tasks.$inferSelect) => boolean) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const task = await row(taskId);
    if (predicate(task)) return task;
    await delay(10);
  }
  assert.fail(`task did not reach expected state: ${taskId}; ${JSON.stringify(await row(taskId))}`);
}
const active = (taskId: string, count = 1) => waitFor(taskId, (task) => task.status === "running" && calls(taskId) >= count && finishers.has(taskId));
const settled = (taskId: string, status: string) => waitFor(taskId, (task) => task.status === status && !isTurnClaimed(taskId));
async function createPair(taskId: string, agentType: AgentType, status: TaskStatus, siblingStatus: TaskStatus) {
  const siblingId = `${taskId}-sibling`;
  await db.insert(groups).values({ id: taskId, projectId: "project", name: taskId, mode: "serial", createdAt: at });
  const common = { projectId: "project", groupId: taskId, mode: "single", agentType, useWorktree: false, autoTitle: false, createdAt: at, updatedAt: at };
  await db.insert(tasks).values([
    { ...common, id: taskId, title: taskId, body: agentType === "codex" ? "/goal 保留原目标 --budget 150" : "/goal 保留原目标", status },
    { ...common, id: siblingId, title: siblingId, body: "下一项", status: siblingStatus },
  ]);
  await db.insert(queueItems).values([
    { taskId, queueId: taskId, position: 0, createdAt: at },
    { taskId: siblingId, queueId: taskId, position: 1, createdAt: at },
  ]);
  return siblingId;
}
async function seed(taskId: string, agentType: AgentType, held = true, profileId = `${agentType}-old`): Promise<CliSessionState> {
  const state: CliSessionState = {
    profileId, ownerUserId: null, goalSessionId: `${taskId}-original-native`, goalHold: held,
    goal: { objective: "保留原目标", status: held ? "paused" : "complete", tokenBudget: 150, tokensUsed: 50, timeUsedSeconds: 21 },
  };
  await saveCliState(taskId, agentType, state, true);
  await db.insert(sessions).values({ id: `${taskId}-original`, taskId, role: "single", agentType, executor: agentType, executorId: state.profileId, cliSessionId: state.goalSessionId, cwd: root, startedAt: at, turnStartedAt: at, endedAt: at });
  return state;
}
async function otherScopes(taskId: string, agentType: AgentType, saved: CliSessionState) {
  const foreign: CliSessionState = { ...saved, ownerUserId: "other-owner", goal: { ...saved.goal!, objective: "其他发起人的目标", tokensUsed: 92 }, goalHold: true };
  await saveCliState(taskId, agentType, foreign);
  await saveCliState(taskId, agentType, { profileId: `${agentType}-new`, ownerUserId: null, personality: "friendly" }, true);
  return foreign;
}
function assertPreserved(task: typeof tasks.$inferSelect, agentType: AgentType, saved: CliSessionState, foreign: CliSessionState) {
  assert.deepEqual(readCliState(task.cliState, agentType, saved.profileId, null), saved);
  assert.deepEqual(readCliState(task.cliState, agentType, saved.profileId, foreign.ownerUserId), foreign);
  assert.equal(readCliState(task.cliState, agentType, `${agentType}-new`, null).personality, "friendly");
}

try {
  await db.insert(projects).values({ id: "project", name: "goal queue recovery", repoPath: root, createdAt: at });
  for (const agentType of ["codex", "claude"] as const) {
    await db.insert(agents).values([
      { id: `${agentType}-old`, name: `${agentType}@原目标`, type: agentType, isDefault: true },
      { id: `${agentType}-new`, name: `${agentType}@新默认`, type: agentType, isDefault: false },
    ]);
    for (const pinned of [false, true]) for (const scoped of [false, true]) {
      const taskId = `${agentType}-stopped-${pinned}-${scoped}`;
      const siblingId = await createPair(taskId, agentType, "backlog", "backlog");
      await db.update(agents).set({ isDefault: true }).where(eq(agents.id, `${agentType}-old`));
      await db.update(agents).set({ isDefault: false }).where(eq(agents.id, `${agentType}-new`));
      if (pinned) await db.update(tasks).set({ executorId: `${agentType}-old` }).where(eq(tasks.id, taskId));
      holding.add(taskId); holding.add(siblingId);
      assert.equal((await request(`/tasks/${taskId}/run`)).status, 202);
      await active(taskId);
      assert.equal((await request(`/tasks/${taskId}/stop`)).status, 200);
      const stopped = await settled(taskId, "canceled");
      await active(siblingId);
      const saved = readCliState(stopped.cliState, agentType, `${agentType}-old`, null);
      assert.equal(saved.goal?.tokensUsed, 50);
      assert.equal(saved.goalHold, true);
      assert.equal(saved.goalSessionId, `${taskId}-native`);
      const foreign = await otherScopes(taskId, agentType, saved);
      if (pinned) await db.update(tasks).set({ executorId: `${agentType}-new` }).where(eq(tasks.id, taskId));
      else {
        await db.update(agents).set({ isDefault: false }).where(eq(agents.id, `${agentType}-old`));
        await db.update(agents).set({ isDefault: true }).where(eq(agents.id, `${agentType}-new`));
      }
      const text = scoped ? `/goal resume --scope ${cliGoalScopeSelector(agentType, saved)}` : "/goal resume";
      const response = await reply(taskId, text, pinned ? { agent: agentType, executorId: `${agentType}-new` } : {});
      assert.equal(response.status, 202);
      const pending = await response.json();
      assert.equal(pending.scheduled, true, "stopped goal recovery must wait for the running queue member");
      assert.equal(pending.message.execution, true);
      assert.match(pending.message.text, /resume --scope/);
      await deliverPendingMessages(taskId);
      assert.equal(calls(taskId), 1, "scanning cannot run a stopped goal alongside its sibling");
      assertPreserved(await row(taskId), agentType, saved, foreign);
      assert.equal((await row(taskId)).status, "canceled");
      assert.equal((await request(`/tasks/${siblingId}/stop`)).status, 200);
      await settled(siblingId, "canceled");
      await deliverPendingMessages(taskId);
      const resumed = await active(taskId, 2);
      const invocation = invocations.get(taskId)![1]!;
      assert.equal(invocation.cliState?.profileId, saved.profileId);
      assert.equal(invocation.sessionId, saved.goalSessionId);
      assert.deepEqual(invocation.cliState?.goal, { ...saved.goal, status: "active" });
      assert.equal(resumed.followUpFrom, null);
      assert.equal(resumed.executorId, pinned ? `${agentType}-new` : null);
      assert.deepEqual(readCliState(resumed.cliState, agentType, saved.profileId, foreign.ownerUserId), foreign);
      assert.equal((await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, pending.message.id)))[0]!.status, "sent");
      assert.equal((await request(`/tasks/${taskId}/stop`)).status, 200);
      await settled(taskId, "canceled");
    }
    console.log(`${agentType}: real start/stop/queue handoff, default/explicit drift, plain/scoped delayed recovery: passed`);

    await db.update(agents).set({ isDefault: false }).where(eq(agents.id, `${agentType}-old`));
    await db.update(agents).set({ isDefault: true }).where(eq(agents.id, `${agentType}-new`));
    for (const status of ["done", "failed", "canceled"] as const) {
      const chatId = `${agentType}-chat-${status}`;
      const chatSibling = await createPair(chatId, agentType, status, "running");
      await seed(chatId, agentType);
      const chat = await reply(chatId, "普通终态追问");
      assert.equal((await chat.json()).started, true, "ordinary terminal chat retains its queue exemption");
      await waitFor(chatId, (task) => task.status === status && calls(chatId) === 1 && !isTurnClaimed(chatId));
      assert.equal((await row(chatSibling)).status, "running");

      for (const delayed of [false, true]) for (const phase of ["prepare", "run"] as const) {
        const taskId = `${agentType}-${status}-${delayed}-${phase}`;
        const siblingId = await createPair(taskId, agentType, status, delayed ? "running" : "done");
        const saved = await seed(taskId, agentType, status !== "done");
        const foreign = await otherScopes(taskId, agentType, saved);
        const originalSession = (await db.select().from(sessions).where(eq(sessions.id, `${taskId}-original`)))[0]!;
        failStarts.set(taskId, phase);
        const response = await reply(taskId, `/goal resume --scope ${cliGoalScopeSelector(agentType, saved)}`);
        assert.equal(response.status, 202);
        const result = await response.json();
        if (delayed) {
          assert.equal(result.scheduled, true);
          assert.equal(result.message.execution, true);
          await deliverPendingMessages(taskId);
          assert.equal(failures.has(taskId), false);
          await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, siblingId));
          await deliverPendingMessages(taskId);
        } else assert.equal(result.started, true);
        const restored = await waitFor(taskId, (task) => (failures.get(taskId) ?? 0) > 0 && !isTurnClaimed(taskId) && task.status === status);
        assert.equal(restored.goalTurn, false);
        assert.equal(restored.followUpFrom, null);
        assertPreserved(restored, agentType, saved, foreign);
        assert.deepEqual((await db.select().from(sessions).where(eq(sessions.id, `${taskId}-original`)))[0], originalSession);
        assert.deepEqual(await queueBlockers(siblingId), [], "failed recovery must release its queue seat");
        const claim = await claimQueueSeat(siblingId);
        assert.equal(claim.ok, true);
        if (claim.ok) await claim.seat?.release();
        if (delayed) {
          const message = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, result.message.id)))[0]!;
          assert.equal(message.status, "pending");
          assert.equal(message.deliveringSince, null);
          await db.update(scheduledMessages).set({ status: "canceled" }).where(eq(scheduledMessages.id, message.id));
        }
      }
    }
    console.log(`${agentType}: terminal chats bypass, immediate/delayed failures before/after preparation restore status/scopes/session/seat: passed`);

    for (const status of ["failed", "canceled"] as const) for (const phase of ["prepare", "run"] as const) {
      const taskId = `${agentType}-handoff-${status}-${phase}`;
      const siblingId = await createPair(taskId, agentType, status, "running");
      const saved = await seed(taskId, agentType);
      const foreign = await otherScopes(taskId, agentType, saved);
      const response = await reply(taskId, "/goal resume");
      const result = await response.json();
      assert.equal(response.status, 202);
      assert.equal(result.scheduled, true);
      await db.update(groups).set({ paused: true }).where(eq(groups.id, taskId));
      await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, siblingId));
      failStarts.set(taskId, phase);
      const start = await request(`/tasks/${taskId}/${status === "failed" ? "retry" : "run"}`);
      assert.equal(start.status, 202);
      const restored = await waitFor(taskId, (task) => (failures.get(taskId) ?? 0) > 0 && !isTurnClaimed(taskId) && task.status === status);
      assertPreserved(restored, agentType, saved, foreign);
      assert.equal(restored.followUpFrom, null);
      assert.deepEqual(await queueBlockers(siblingId), []);
      const message = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, result.message.id)))[0]!;
      assert.equal(message.status, "pending");
      assert.equal(message.deliveringSince, null);
      await db.update(scheduledMessages).set({ status: "canceled" }).where(eq(scheduledMessages.id, message.id));
    }
    console.log(`${agentType}: run/retry pending-goal handoff preserves terminal status on startup failure: passed`);

    for (const status of ["failed", "canceled", "paused"] as const) for (const invalidated of ["profile", "goal", "goal-only"] as const) {
      const taskId = `${agentType}-stale-${status}-${invalidated}`;
      const profileId = `${taskId}-profile`;
      const siblingId = await createPair(taskId, agentType, status, "running");
      await db.insert(agents).values({ id: profileId, name: `${agentType}@待删除目标`, type: agentType });
      const saved = await seed(taskId, agentType, true, profileId);
      const foreign = await otherScopes(taskId, agentType, saved);
      const response = await reply(taskId, "/goal resume");
      const result = await response.json();
      assert.equal(response.status, 202);
      assert.equal(result.scheduled, true);
      assert.equal(result.message.execution, true);
      await db.update(groups).set({ paused: true }).where(eq(groups.id, taskId));
      if (invalidated !== "goal-only") await db.delete(agents).where(eq(agents.id, profileId));
      const clearText = `/goal clear --scope ${cliGoalScopeSelector(agentType, saved)}`;
      if (invalidated !== "profile") {
        assert.ok([200, 202].includes((await reply(taskId, clearText)).status));
        await waitFor(taskId, (task) => !isTurnClaimed(taskId) && !readCliState(task.cliState, agentType, profileId, null).goal);
      }
      const before = await row(taskId);
      const originalSession = (await db.select().from(sessions).where(eq(sessions.id, `${taskId}-original`)))[0]!;
      const beforeCalls = calls(taskId);
      assert.equal(claimTurn(taskId), true);
      try {
        await assert.rejects(continueTask(taskId, result.message.text), /原执行器已不可用|目标作用域不存在或已清除/);
        assert.equal(isTurnClaimed(taskId), true, "preflight without a borrowed lock cannot release another caller's turn");
      } finally {
        releaseTurn(taskId);
      }
      await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, siblingId));
      assert.equal((await request(`/tasks/${taskId}/${status === "failed" ? "retry" : "run"}`)).status, 202);
      const restored = await waitFor(taskId, (task) => task.status === status && !isTurnClaimed(taskId));
      const message = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, result.message.id)))[0]!;
      assert.equal(message.status, "canceled", "stale recovery is rejected, not delivered or retried forever");
      assert.equal(message.deliveringSince, null);
      assert.equal(calls(taskId), beforeCalls, "invalid recovery never starts a CLI or silently migrates to the new default");
      assert.equal(restored.cliState, before.cliState, "preflight refusal cannot rewrite any goal, budget, usage or hold");
      assert.equal(restored.activeTurnToken, before.activeTurnToken);
      assert.equal(restored.goalTurn, before.goalTurn);
      assert.equal(restored.nativeTurn, before.nativeTurn);
      assert.equal(restored.followUpFrom, before.followUpFrom);
      assert.deepEqual((await db.select().from(sessions).where(eq(sessions.id, `${taskId}-original`)))[0], originalSession);
      assert.deepEqual(await queueBlockers(siblingId), status === "paused" ? [taskId] : [], "only the original paused state may block the next task");
      if (status !== "paused") {
        const seat = await claimQueueSeat(siblingId);
        assert.equal(seat.ok, true);
        if (seat.ok) await seat.seat?.release();
      }
      const clearCalls = calls(taskId);
      const clearResponse = await reply(taskId, clearText);
      assert.ok([200, 202].includes(clearResponse.status), "a rejected recovery must not block goal clearing");
      await waitFor(taskId, (task) => (clearResponse.status === 200 || calls(taskId) > clearCalls) && !isTurnClaimed(taskId) && !readCliState(task.cliState, agentType, profileId, null).goal);
      const cleared = await row(taskId);
      assert.equal(readCliState(cleared.cliState, agentType, profileId, null).goal, null);
      assert.equal(readCliState(cleared.cliState, agentType, profileId, null).goalHold, false);
      assert.deepEqual(readCliState(cleared.cliState, agentType, profileId, foreign.ownerUserId), foreign);
      assert.equal(readCliState(cleared.cliState, agentType, `${agentType}-new`, null).personality, "friendly");
      await db.update(tasks).set({ body: "普通任务" }).where(eq(tasks.id, taskId));
      holding.add(taskId);
      const nextCall = calls(taskId) + 1;
      const rerun = await request(`/tasks/${taskId}/run`);
      assert.equal(rerun.status, 202, `${taskId}: manual run must be reachable again; ${JSON.stringify(await rerun.json())}`);
      await active(taskId, nextCall);
      assert.equal((await request(`/tasks/${taskId}/stop`)).status, 200);
      await settled(taskId, "canceled");
    }
    console.log(`${agentType}: invalidated queued goals restore run/retry status, locks, scopes and queue seats: passed`);

    const timedId = `${agentType}-timed`;
    const timedSibling = await createPair(timedId, agentType, "canceled", "running");
    await seed(timedId, agentType);
    const timed = await reply(timedId, "/goal resume", { sendAt: new Date(Date.now() + 60_000).toISOString() });
    assert.equal(timed.status, 202);
    const timer = await timed.json();
    assert.equal(timer.message.execution, true, "timed goal recovery is still task execution");
    await db.update(scheduledMessages).set({ sendAt: at, execution: false }).where(eq(scheduledMessages.id, timer.message.id));
    await deliverPendingMessages(timedId);
    assert.equal(calls(timedId), 0);
    assert.equal((await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, timer.message.id)))[0]!.execution, true, "legacy delayed goals acquire durable execution intent before queue checks");
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, timedSibling));
    await db.update(groups).set({ paused: true }).where(eq(groups.id, timedId));
    await deliverPendingMessages(timedId);
    assert.equal(calls(timedId), 0, "delayed goal recovery also respects group pause");
    await db.update(scheduledMessages).set({ status: "canceled" }).where(eq(scheduledMessages.id, timer.message.id));

    for (const status of ["done", "failed", "canceled"] as const) for (let attempt = 0; attempt < 5; attempt++) {
      const taskId = `${agentType}-race-${status}-${attempt}`;
      const siblingId = await createPair(taskId, agentType, status, "backlog");
      await seed(taskId, agentType);
      holding.add(taskId); holding.add(siblingId);
      const [resume, run] = await Promise.all([reply(taskId, "/goal resume"), request(`/tasks/${siblingId}/run`)]);
      assert.equal(resume.status, 202);
      assert.ok([202, 409].includes(run.status));
      await waitFor(taskId, asyncStatus => calls(taskId) + calls(siblingId) > 0 && (asyncStatus.status === "running" || calls(siblingId) > 0));
      await delay(30);
      const pair = [await row(taskId), await row(siblingId)];
      assert.equal(pair.filter((task) => ["running", "queued"].includes(task.status)).length, 1, "atomic claims prevent concurrent terminal recovery and manual run");
      assert.equal(calls(taskId) + calls(siblingId), 1);
      await db.update(groups).set({ paused: true }).where(eq(groups.id, taskId));
      await db.update(scheduledMessages).set({ status: "canceled" }).where(eq(scheduledMessages.taskId, taskId));
      for (const member of pair) if (isTurnClaimed(member.id)) {
        stopTask(member.id);
        await settled(member.id, "canceled");
      }
    }
    console.log(`${agentType}: timed/legacy execution intent and 15 atomic recovery/manual-start queue races: passed`);
  }
} finally {
  await db.update(scheduledMessages).set({ status: "canceled" });
  for (const taskId of holding) stopTask(taskId);
  for (let attempt = 0; attempt < 300 && [...invocations.keys()].some(isTurnClaimed); attempt++) await delay(10);
  await delay(30);
  CodexExecutor.prototype.runSteerable = originalCodex;
  ClaudeExecutor.prototype.runSteerable = originalClaude;
  CodexExecutor.prototype.prepareResume = originalPrepare;
  if (originalClaudePrepare) claudePrototype.prepareResume = originalClaudePrepare;
  else Reflect.deleteProperty(claudePrototype, "prepareResume");
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}

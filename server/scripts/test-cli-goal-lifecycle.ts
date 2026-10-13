import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AgentType } from "@ash/shared";
import { hasCliGoalHold } from "@ash/shared/cli-commands";
import type { RunHandle, RunOpts } from "../src/executors/types.js";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-goal-lifecycle-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_UPLOADS_DIR = join(root, "uploads");
delete process.env.ASH_ALLOW_REAL_AGENT;
const { db, ensureSchema } = await import("../src/db/index.js");
const { agents, projects, tasks, groups, queueItems, scheduledMessages } = await import("../src/db/schema.js");
const { replyToTask } = await import("../src/task-reply.js");
const { continueTask } = await import("../src/orchestrator.js");
const { CodexExecutor } = await import("../src/executors/codex.js");
const { ClaudeExecutor } = await import("../src/executors/claude.js");
const { readCliState, saveCliState } = await import("../src/task-cli-state.js");
const { markStopped, isTurnClaimed } = await import("../src/runs.js");
const { runGroup, selectNextInQueue } = await import("../src/scheduler.js");
await ensureSchema();
const app = new Hono();
app.post("/:id/reply", (context) => replyToTask(context, context.req.param("id")));
const at = new Date().toISOString();
const row = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
const create = (taskId: string, agentType: AgentType, extra: Partial<typeof tasks.$inferInsert> = {}) => db.insert(tasks).values({
  id: taskId, projectId: "project", title: taskId, body: "目标生命周期回归", mode: "single", agentType,
  executorId: `${agentType}-fixture`, autoTitle: false, useWorktree: false, status: "done", createdAt: at, updatedAt: at, ...extra,
});
const reply = (taskId: string, text: string) => app.request(`/${taskId}/reply`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }),
});
type Outcome = "unconfirmed" | "nonzero" | "paused" | "canceled" | "confirmed" | "startup" | "stream-error";
const outcomes = new Map<string, Outcome>();
const invocations = new Map<string, RunOpts>();
const originals = [CodexExecutor.prototype.runSteerable, ClaudeExecutor.prototype.runSteerable];
function fixture(options: RunOpts): RunHandle {
  const taskId = options.env!.ASH_TASK_ID!;
  invocations.set(taskId, options);
  const outcome = outcomes.get(taskId) ?? "unconfirmed";
  if (outcome === "startup") throw new Error("fixture startup failure");
  const goal = options.cliState?.goal ? { ...options.cliState.goal, status: "budgetLimited" as const, tokensUsed: 150 } : null;
  return {
    sessionId: options.sessionId ?? `fixture-${taskId}`, cliCommand: options.cliCommand,
    commandLine: "goal lifecycle fixture; no CLI/model", kill() {},
    goal: options.cliState?.profileId === "codex-fixture" ? () => goal : undefined,
    goalStarted: () => !!goal,
    events: (async function* () {
      yield { kind: "session" as const, cliSessionId: `fixture-${taskId}` };
      yield { kind: "text" as const, text: `目标回合：${taskId}` };
      if (outcome === "stream-error") throw new Error("fixture stream failure");
      if (outcome === "confirmed") await db.update(tasks).set({ completeConfirmedAt: at }).where(eq(tasks.id, taskId));
      if (outcome === "paused" || outcome === "canceled") markStopped(taskId, outcome);
      yield { kind: "done" as const, exitStatus: outcome === "nonzero" ? 1 : 0 };
    })(),
  };
}
CodexExecutor.prototype.runSteerable = fixture;
ClaudeExecutor.prototype.runSteerable = fixture;

try {
  await db.insert(projects).values({ id: "project", name: "目标回归", repoPath: root, createdAt: at });
  for (const agentType of ["codex", "claude"] as const) {
    await db.insert(agents).values({ id: `${agentType}-fixture`, name: `${agentType}@回归`, type: agentType, isDefault: true, extraArgs: "[]", configOverrides: "{}" });
    for (const status of ["running", "queued"] as const) {
      const taskId = `${agentType}-${status}`;
      const text = "/goal 完成重构并让测试全过";
      await create(taskId, agentType, { status });
      const response = await reply(taskId, text);
      assert.equal(response.status, 202);
      const result = await response.json();
      assert.equal(result.scheduled, true);
      const pending = await db.select().from(scheduledMessages).where(eq(scheduledMessages.taskId, taskId));
      assert.equal(pending.length, 1);
      assert.equal(pending[0]!.text, text);
      assert.equal(pending[0]!.status, "pending");
      assert.equal((await row(taskId)).status, status);
      assert.equal((await row(taskId)).goalTurn, false);
      assert.equal((await row(taskId)).cliState, null);
      assert.equal(invocations.has(taskId), false);

      const activeId = `${taskId}-active-goal`;
      await create(activeId, agentType, { status, goalTurn: true });
      await saveCliState(activeId, agentType, { profileId: `${agentType}-fixture`, ownerUserId: null, goal: { objective: "原目标不能被替换", status: "active" } });
      for (const command of [text, "/goal resume"]) {
        const rejected = await reply(activeId, command);
        assert.equal(rejected.status, 409);
        const error = (await rejected.json()).error;
        assert.match(error, /原目标不能被替换/);
        assert.match(error, /\/goal pause/);
        assert.match(error, /等待回合结束/);
      }
      assert.equal((await db.select().from(scheduledMessages).where(eq(scheduledMessages.taskId, activeId))).length, 0);
    }
    console.log(`${agentType}: running/queued ordinary goals are queued unchanged; active goals reject replacement with actionable guidance: passed`);

    for (const status of ["done", "failed", "canceled"] as const) {
      for (const outcome of ["unconfirmed", "nonzero", "paused", "canceled", "confirmed", "startup", "stream-error"] as const) {
        const taskId = `${agentType}-${status}-${outcome}`;
        await create(taskId, agentType, { status });
        outcomes.set(taskId, outcome);
        assert.equal(await continueTask(taskId, "/goal 后续覆盖率目标"), true);
        const settled = await row(taskId);
        assert.equal(settled.status, outcome === "confirmed" ? "done" : status, taskId);
        assert.equal(settled.followUpFrom, null, taskId);
        assert.equal(settled.goalTurn, false, taskId);
        assert.equal(hasCliGoalHold(settled.cliState), false, taskId);
        assert.equal(isTurnClaimed(taskId), false, taskId);
        const snapshot = readCliState(settled.cliState, agentType, `${agentType}-fixture`, null);
        assert.equal(snapshot.goal?.objective ?? null, outcome === "startup" ? null : "后续覆盖率目标", taskId);
        if (outcome === "stream-error") assert.equal(snapshot.goal?.status, "blocked", taskId);
        if (outcome === "unconfirmed" && agentType === "codex") assert.equal(snapshot.goal?.tokensUsed, 150);
      }
    }
    console.log(`${agentType}: terminal goal replies preserve status and snapshots without a hold across unconfirmed, failed, stopped, confirmed and startup-error turns: passed`);

    const resumedId = `${agentType}-terminal-resume`;
    await create(resumedId, agentType);
    await saveCliState(resumedId, agentType, { profileId: `${agentType}-fixture`, ownerUserId: null, goalHold: false, goal: { objective: "恢复终态续聊目标", status: "paused", ...(agentType === "codex" ? { tokenBudget: 150, tokensUsed: 70 } : {}) } });
    assert.equal(await continueTask(resumedId, "/goal resume"), true);
    assert.equal((await row(resumedId)).status, "done");
    assert.equal(hasCliGoalHold((await row(resumedId)).cliState), false);
    assert.equal(readCliState((await row(resumedId)).cliState, agentType).goal?.objective, "恢复终态续聊目标");
    if (agentType === "codex") assert.equal(invocations.get(resumedId)?.cliState?.goal?.tokensUsed, 70);
    console.log(`${agentType}: resuming a terminal follow-up goal preserves its scope and prior usage without reclaiming a queue hold: passed`);

    const pausedId = `${agentType}-paused-execution`;
    await create(pausedId, agentType, { status: "paused" });
    assert.equal(await continueTask(pausedId, "/goal 正常执行目标"), true);
    assert.equal((await row(pausedId)).status, "paused");
    assert.equal(hasCliGoalHold((await row(pausedId)).cliState), true);
    assert.equal(selectNextInQueue([await row(pausedId)]), null);

    const checkpointId = `${agentType}-checkpoint-execution`;
    await create(checkpointId, agentType, { status: "paused", resumePrompt: "原有检查点继续指令" });
    outcomes.set(checkpointId, "canceled");
    assert.equal(await continueTask(checkpointId, "/goal 非终态目标仍是执行"), true);
    assert.equal((await row(checkpointId)).status, "canceled");
    assert.equal((await row(checkpointId)).resumePrompt, "原有检查点继续指令");

    const systemId = `${agentType}-system-execution`;
    await create(systemId, agentType);
    assert.equal(await continueTask(systemId, "/goal 后端重新执行目标", { system: true }), true);
    assert.equal((await row(systemId)).status, "paused");
    assert.equal(hasCliGoalHold((await row(systemId)).cliState), true);
    console.log(`${agentType}: nonterminal goals and backend execution turns still retain their scheduler protection: passed`);

    const groupId = `${agentType}-group`;
    const firstId = `${agentType}-queue-first`;
    const nextId = `${agentType}-queue-next`;
    await db.insert(groups).values({ id: groupId, projectId: "project", name: "终态续聊队列", mode: "serial", createdAt: at });
    await create(firstId, agentType, { groupId });
    await create(nextId, agentType, { groupId, status: "backlog" });
    outcomes.set(nextId, "confirmed");
    await db.insert(queueItems).values([{ taskId: firstId, queueId: groupId, position: 0, createdAt: at }, { taskId: nextId, queueId: groupId, position: 1, createdAt: at }]);
    assert.equal(await continueTask(firstId, "/goal 不重新占位的后续目标"), true);
    await runGroup(groupId);
    for (let attempt = 0; attempt < 200; attempt++) {
      if (invocations.has(nextId) && !isTurnClaimed(nextId)) break;
      await delay(20);
    }
    assert.equal((await row(firstId)).status, "done");
    assert.equal(hasCliGoalHold((await row(firstId)).cliState), false);
    assert.equal(invocations.has(nextId), true, "next queue member must actually execute");
    assert.equal((await row(nextId)).status, "done");
    console.log(`${agentType}: a completed queue member's goal follow-up does not reclaim its seat or block the next member: passed`);
  }
} finally {
  CodexExecutor.prototype.runSteerable = originals[0]!;
  ClaudeExecutor.prototype.runSteerable = originals[1]!;
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}

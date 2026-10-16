import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { makeStep } from "@ash/shared/workflow";
import { readCliState } from "@ash/shared/cli-commands";
import type { RunOpts } from "../src/executors/types.js";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-plan-scheduling-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
delete process.env.ASH_ALLOW_REAL_AGENT;
const { db, ensureSchema } = await import("../src/db/index.js");
const { agents, projects, tasks, sessions, groups, queueItems } = await import("../src/db/schema.js");
const { CodexExecutor } = await import("../src/executors/codex.js");
const { advanceQueue, runGroup } = await import("../src/scheduler.js");
const { applyFailPolicy } = await import("../src/workflow-steps.js");
const { continueTask } = await import("../src/orchestrator.js");
const { saveCliState } = await import("../src/task-cli-state.js");
const { isTurnClaimed } = await import("../src/runs.js");
await ensureSchema();
const originalRun = CodexExecutor.prototype.runSteerable;
const invocations = new Map<string, RunOpts>();
CodexExecutor.prototype.runSteerable = function (options) {
  const taskId = options.env!.ASH_TASK_ID!;
  invocations.set(taskId, options);
  return {
    sessionId: options.sessionId ?? taskId, commandLine: "plan scheduling fixture; no CLI/model",
    kill() {},
    events: (async function* () {
      yield { kind: "session" as const, cliSessionId: taskId };
      yield { kind: "text" as const, text: options.cliState?.plan ? "只讨论计划" : "执行但没有确认完成" };
      yield { kind: "done" as const, exitStatus: 0 };
    })(),
  };
};
const at = new Date().toISOString();
const row = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
async function create(taskId: string, extra: Partial<typeof tasks.$inferInsert> = {}) {
  await db.insert(tasks).values({ id: taskId, projectId: "project", title: taskId, body: "开始实施", status: "backlog", mode: "single", agentType: "codex", executorId: "profile", useWorktree: false, autoTitle: false,
    cliState: JSON.stringify({ codex: { profileId: "profile", ownerUserId: null, plan: true } }), createdAt: at, updatedAt: at, ...extra });
  await saveCliState(taskId, "codex", { profileId: "reviewer-profile", ownerUserId: "other-owner", plan: true });
  await db.insert(sessions).values({ id: `${taskId}-session`, taskId, role: "single", agentType: "codex", executor: "codex", executorId: "profile", cliSessionId: taskId, cwd: root, startedAt: at, endedAt: at });
}
async function settled(taskId: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (invocations.has(taskId) && !isTurnClaimed(taskId)) return row(taskId);
    await delay(10);
  }
  assert.fail(`task did not settle: ${taskId}`);
}
async function assertExecution(taskId: string) {
  const task = await settled(taskId);
  assert.equal(readCliState(task.cliState, "codex", "profile", null).plan, false, `${taskId}: stored plan must reset (status=${task.status})`);
  assert.equal(readCliState(task.cliState, "codex", "reviewer-profile", "other-owner").plan, false, `${taskId}: scheduled runs must reset other profiles/owners too`);
  assert.equal(invocations.get(taskId)?.cliState?.plan, false, taskId);
  assert.doesNotMatch(invocations.get(taskId)!.prompt, /本回合只讨论计划/, taskId);
  assert.equal(task.status, "failed", `${taskId}: exit 0 without completion must not become done`);
}
try {
  await db.insert(projects).values({ id: "project", name: "plan", repoPath: root, createdAt: at });
  await db.insert(agents).values({ id: "profile", name: "codex@plan-fixture", type: "codex", isDefault: true });
  await db.insert(agents).values({ id: "reviewer-profile", name: "codex@review-fixture", type: "codex" });
  await db.insert(groups).values([{ id: "serial", projectId: "project", name: "serial", mode: "serial", createdAt: at }, { id: "parallel", projectId: "project", name: "parallel", mode: "parallel", createdAt: at }]);
  for (const taskId of ["queue-first", "queue-next"]) await create(taskId, { groupId: "serial" });
  await db.insert(queueItems).values(["queue-first", "queue-next"].map((taskId, position) => ({ taskId, queueId: "queue", position, createdAt: at })));
  await advanceQueue("queue");
  await assertExecution("queue-first");
  await assertExecution("queue-next");
  console.log("actual advanceQueue resets plan; unconfirmed exits fail and queue advances: passed");
  await create("parallel-task", { groupId: "parallel" });
  await runGroup("parallel");
  await assertExecution("parallel-task");
  console.log("actual runGroup/runParallel resets plan: passed");
  await create("wake-task", { status: "failed" });
  const step = makeStep("command", "failed-command");
  step.fail = { mode: "back", max: 1 };
  await applyFailPolicy(await row("wake-task"), step, "fixture failure", () => "自动唤醒修复");
  await assertExecution("wake-task");
  console.log("actual workflow fail-policy wake resets plan: passed");
  for (const route of [
    { sideTurn: true },
    // 审查者那一段:回合身份是「角色 + 为哪一次审查而起」一个对象(runs.ts `TurnSource`)。
    // 这个用例只关心「reviewer 回合不动已存的计划」,跟哪一轮审查无关,所以显式写不绑。
    { turnSource: { role: "reviewer", review: "unbound" } as const },
  ]) {
    const taskId = "sideTurn" in route ? "side-task" : "review-task";
    await create(taskId, { status: "done" });
    const before = (await row(taskId)).cliState;
    await continueTask(taskId, "旁路核对", { system: "run", agent: "codex", executorId: "reviewer-profile", ...route });
    assert.equal((await row(taskId)).cliState, before);
    assert.equal((await row(taskId)).status, "done");
    assert.equal(invocations.get(taskId)?.cliState?.plan, false);
    assert.doesNotMatch(invocations.get(taskId)!.prompt, /本回合只讨论计划/);
  }
  console.log("automatic side/reviewer turns execute without changing saved plan: passed");
  await create("verification-task", { status: "done", verifyRound: 1 });
  const verificationState = (await row("verification-task")).cliState;
  await continueTask("verification-task", "继续独立验证", { system: "wake" });
  assert.equal((await row("verification-task")).cliState, verificationState);
  assert.equal((await row("verification-task")).status, "done");
  assert.equal(invocations.get("verification-task")?.cliState?.plan, false);
  assert.doesNotMatch(invocations.get("verification-task")!.prompt, /本回合只讨论计划/);
  console.log("verification wake executes in temporary default mode and preserves saved state: passed");
} finally {
  CodexExecutor.prototype.runSteerable = originalRun;
  await delay(50);
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}

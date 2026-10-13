import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { hasCliGoalHold, readCliState, type CliGoal } from "@ash/shared/cli-commands";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-cli-scopes-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
const { db, ensureSchema } = await import("../src/db/index.js");
const { agents, projects, tasks } = await import("../src/db/schema.js");
const { prepareCliInvocation, saveCliState, markCliGoalStarted, persistRunGoal, interruptCliGoal } = await import("../src/task-cli-state.js");
const { selectNextInQueue } = await import("../src/scheduler.js");
const { replyToTask } = await import("../src/task-reply.js");
const { setActor } = await import("../src/auth/context.js");
await ensureSchema();
const at = new Date().toISOString();
const goal: CliGoal = { objective: "让 test/auth 全过", status: "budgetLimited", tokenBudget: 150, tokensUsed: 150, timeUsedSeconds: 21 };
const row = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
const held = { profileId: "profile-a", ownerUserId: null, goalHold: true, goal, plan: true };
try {
  await db.insert(projects).values({ id: "project", name: "scopes", repoPath: root, createdAt: at });
  for (const agent of ["codex", "claude"] as const) {
    await db.insert(tasks).values({ id: agent, projectId: "project", title: agent, body: "任务", status: "paused", mode: "single", agentType: agent, createdAt: at, updatedAt: at, cliState: JSON.stringify({ [agent]: held }) });
    await prepareCliInvocation(await row(agent), agent, "另一个执行器回复", "profile-b", null);
    assert.deepEqual(readCliState((await row(agent)).cliState, agent, "profile-a", null), held, "switching profile must preserve legacy goal/budget/hold");
    assert.equal(selectNextInQueue([await row(agent)]), null);
    await prepareCliInvocation(await row(agent), agent, "另一个人回复", "profile-a", "other-user");
    assert.deepEqual(readCliState((await row(agent)).cliState, agent, "profile-a", null), held);
    assert.equal(hasCliGoalHold((await row(agent)).cliState), true);
    const resumed = await prepareCliInvocation(await row(agent), agent, "/goal resume", "profile-a", null);
    assert.deepEqual(resumed.cliState.goal, { ...goal, status: "active" });
    assert.equal(resumed.cliState.goalStart?.previousHold, true);
    await db.update(tasks).set({ goalTurn: true }).where(eq(tasks.id, agent));
    const noStart = { sessionId: "fixture", commandLine: "fixture", events: (async function* () {})(), kill() {}, goal: () => null, goalStarted: () => false };
    await persistRunGoal(agent, agent, noStart, 1);
    assert.deepEqual(readCliState((await row(agent)).cliState, agent, "profile-a", null), held, "startup rollback keeps the old scope and its usage");
    const sideSnapshot = (await row(agent)).cliState;
    for (const profileId of ["profile-a", "profile-b"]) await prepareCliInvocation(await row(agent), agent, "审查核对", profileId, null, { resetPlan: true, preserveState: true });
    assert.equal((await row(agent)).cliState, sideSnapshot);
    assert.equal(readCliState(sideSnapshot, agent, "profile-a", "other-user").goal, undefined);
    await prepareCliInvocation(await row(agent), agent, "/goal resume", "profile-a", null);
    await db.update(tasks).set({ goalTurn: true }).where(eq(tasks.id, agent));
    await saveCliState(agent, agent, { profileId: "profile-b", ownerUserId: null, goal: { objective: "另一作用域", status: "paused" }, goalHold: true });
    await markCliGoalStarted(agent, agent);
    assert.equal(readCliState((await row(agent)).cliState, agent, "profile-a", null).goalStart, undefined);
    await persistRunGoal(agent, agent, { ...noStart, goal: () => ({ ...goal, status: "budgetLimited" }), goalStarted: () => true }, 0);
    assert.deepEqual(readCliState((await row(agent)).cliState, agent, "profile-a", null).goal, goal);
    assert.equal(readCliState((await row(agent)).cliState, agent, "profile-b", null).goal?.objective, "另一作用域");
    await interruptCliGoal(await row(agent), agent, true);
    assert.equal(readCliState((await row(agent)).cliState, agent, "profile-a", null).goal?.status, "blocked");
    assert.equal(readCliState((await row(agent)).cliState, agent, "profile-b", null).goal?.status, "paused");
    await prepareCliInvocation(await row(agent), agent, "/goal clear", "profile-b", null);
    assert.equal(hasCliGoalHold((await row(agent)).cliState), true, "clearing B cannot release A's scheduler hold");
    await prepareCliInvocation(await row(agent), agent, "/goal clear", "profile-a", null);
    assert.equal(hasCliGoalHold((await row(agent)).cliState), false);
    console.log(`${agent}: legacy/profile/owner isolation, resume, rollback, persistence, interruption, and cross-scope hold: passed`);
  }
  await db.insert(tasks).values({ id: "concurrent", projectId: "project", title: "concurrent", body: "任务", status: "paused", mode: "single", agentType: "codex", createdAt: at, updatedAt: at, cliState: JSON.stringify({ codex: held, claude: held }) });
  const profiles = ['special."profile', "含中文%和'的执行器"];
  await Promise.all(profiles.map((profileId) => saveCliState("concurrent", "codex", { profileId, ownerUserId: "user", goal: { ...goal, objective: profileId }, goalHold: true })));
  assert.deepEqual(readCliState((await row("concurrent")).cliState, "codex", "profile-a", null), held);
  assert.deepEqual(readCliState((await row("concurrent")).cliState, "claude", "profile-a", null), held);
  for (const profileId of profiles) assert.equal(readCliState((await row("concurrent")).cliState, "codex", profileId, "user").goal?.objective, profileId);
  assert.equal(readCliState((await row("concurrent")).cliState, "codex").profileId, "profile-a");
  assert.equal(hasCliGoalHold((await row("concurrent")).cliState), true);
  assert.deepEqual(readCliState("malformed", "codex"), {});
  assert.equal(hasCliGoalHold("malformed"), false);
  console.log("atomic scoped writes preserve legacy/other-agent state and the active run scope: passed");
  await db.insert(agents).values([{ id: "profile-a", name: "claude@scope-a", type: "claude", isDefault: true }, { id: "profile-b", name: "claude@scope-b", type: "claude" }]);
  await db.insert(tasks).values({ id: "snapshot", projectId: "project", title: "snapshot", body: "任务", status: "paused", mode: "single", agentType: "claude", createdAt: at, updatedAt: at, cliState: JSON.stringify({ claude: held }) });
  await prepareCliInvocation(await row("snapshot"), "claude", "切换作用域", "profile-b", null);
  const snapshotBefore = await row("snapshot");
  const app = new Hono();
  app.use("*", async (context, next) => {
    const user = context.req.header("x-test-user");
    if (user) setActor(context, { kind: "user", userId: user, name: user, role: "member" });
    await next();
  });
  app.post("/reply", (context) => replyToTask(context, "snapshot"));
  for (const [executorId, user, expected] of [[null, null, /让 test\/auth 全过/], ["profile-b", null, /当前没有目标/], [null, "other-user", /当前没有目标/]] as const) {
    const response = await app.request("/reply", { method: "POST", headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}) }, body: JSON.stringify({ text: "/goal", ...(executorId ? { agent: "claude", executorId } : {}) }) });
    assert.equal(response.status, 200);
    assert.match((await response.json()).text, expected);
    assert.deepEqual(await row("snapshot"), snapshotBefore);
  }
  console.log("Claude idle HTTP snapshots resolve the selected/default profile and owner, without scope leakage: passed");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}

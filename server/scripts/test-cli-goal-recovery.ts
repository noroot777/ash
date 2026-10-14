import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { hasCliGoalHold, readCliState, type CliGoal } from "@ash/shared/cli-commands";
import type { RunOpts } from "../src/executors/types.js";
import { CodexNativeCommands } from "../src/executors/codex-native-commands.js";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-goal-recovery-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_UPLOADS_DIR = join(root, "uploads");
delete process.env.ASH_ALLOW_REAL_AGENT;
const { db, ensureSchema } = await import("../src/db/index.js");
const { agents, groups, projects, queueItems, scheduledMessages, sessions, tasks } = await import("../src/db/schema.js");
const { CodexExecutor } = await import("../src/executors/codex.js");
const { ClaudeExecutor } = await import("../src/executors/claude.js");
const { prepareCliInvocation, saveCliState } = await import("../src/task-cli-state.js");
const { cliGoalScopeSelector } = await import("../src/task-cli-goal-scopes.js");
const { replyToTask } = await import("../src/task-reply.js");
const { mountGroupRoutes } = await import("../src/group-routes.js");
const { continueTask } = await import("../src/orchestrator.js");
const { runTask } = await import("../src/task-run.js");
const { resumeOrRunTask } = await import("../src/task-resume.js");
const { CROSS_OWNER_SESSION_NOTE } = await import("../src/session-notice.js");
const { advanceQueueFromTask, runGroup, selectNextInQueue } = await import("../src/scheduler.js");
const { isTurnClaimed } = await import("../src/runs.js");
const { setActor } = await import("../src/auth/context.js");
const { reconcileInterrupted } = await import("../src/task-reconcile.js");
await ensureSchema();

const at = new Date().toISOString();
const goal: CliGoal = { objective: "恢复原目标且保留预算", status: "budgetLimited", tokenBudget: 150, tokensUsed: 150, timeUsedSeconds: 21 };
const invocations = new Map<string, RunOpts[]>();
const failStarts = new Set<string>();
const nativeGoals = new Map<string, CliGoal | null>();
const nativeCalls = new Map<string, string[]>();
const originalCodex = CodexExecutor.prototype.runSteerable;
const originalClaude = ClaudeExecutor.prototype.runSteerable;
const fixtureRun: typeof originalCodex = function (options) {
  const taskId = options.env!.ASH_TASK_ID!;
  invocations.set(taskId, [...invocations.get(taskId) ?? [], options]);
  if (failStarts.has(taskId)) throw new Error("fixture startup failure after scoped preparation");
  const saved = options.cliState?.goal;
  const reported = saved && options.cliCommand?.args.startsWith("budget ") ? { ...saved, tokenBudget: Number(options.cliCommand.args.slice(7)) } : saved;
  const output: import("@ash/shared").AgentEvent[] = [];
  const native = nativeGoals.has(taskId) ? new CodexNativeCommands({
    threadId: () => options.sessionId!, turnId: () => "unrelated-turn", model: () => "fixture", cwd: options.cwd, prompt: "", state: options.cliState, push: (event) => output.push(event),
    request: async (method) => { nativeCalls.set(taskId, [...nativeCalls.get(taskId) ?? [], method]); return { goal: nativeGoals.get(taskId) }; },
  }) : null;
  return {
    sessionId: options.sessionId ?? `${taskId}-native`, commandLine: "scope recovery fixture; no CLI/model", cliCommand: options.cliCommand,
    goal: () => native ? native.goal : reported ? { ...reported, status: "paused" as const } : null,
    goalStarted: () => options.cliCommand?.args === "resume", kill() {},
    events: (async function* () {
      yield { kind: "session" as const, cliSessionId: options.sessionId ?? `${taskId}-native` };
      if (native) {
        await native.prepare(options.cliCommand);
        assert.equal((await native.start(options.cliCommand!)).immediate, true);
        yield* output;
      } else yield { kind: "text" as const, text: options.cliCommand?.args === "clear" ? "目标已清除" : "fixture turn" };
      yield { kind: "done" as const, exitStatus: 0 };
    })(),
  };
};
CodexExecutor.prototype.runSteerable = fixtureRun;
ClaudeExecutor.prototype.runSteerable = fixtureRun;
const app = new Hono();
app.use("*", async (context, next) => {
  const user = context.req.header("x-test-user");
  if (user) setActor(context, { kind: "user", userId: user, name: user, role: "member" });
  await next();
});
app.post("/:id/reply", (context) => replyToTask(context, context.req.param("id")));
mountGroupRoutes(app);
const row = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
const reply = (taskId: string, text: string, extra = {}, user?: string) => app.request(`/${taskId}/reply`, {
  method: "POST", headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}) }, body: JSON.stringify({ text, ...extra }),
});
async function settled(taskId: string, count = 1) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if ((invocations.get(taskId)?.length ?? 0) >= count && !isTurnClaimed(taskId)) return row(taskId);
    await delay(10);
  }
  const task = await row(taskId);
  assert.fail(`task did not settle: ${taskId}; status=${task.status}; followUpFrom=${task.followUpFrom}; state=${task.cliState}; calls=${invocations.get(taskId)?.map((invocation) => invocation.cliCommand?.text ?? "execution")}; claimed=${isTurnClaimed(taskId)}`);
}
async function create(taskId: string, agentType: "codex" | "claude", extra: Partial<typeof tasks.$inferInsert> = {}) {
  await db.insert(tasks).values({ id: taskId, projectId: "project", title: taskId, body: "普通任务", status: "paused", mode: "single", agentType, useWorktree: false, autoTitle: false, createdAt: at, updatedAt: at, ...extra });
}
async function seed(taskId: string, agentType: "codex" | "claude", ownerUserId: string | null = null, profileId = `${agentType}-old`) {
  const state = { profileId, ownerUserId, goal, goalHold: true, plan: false };
  await saveCliState(taskId, agentType, state, true);
  await db.insert(sessions).values({ id: `${taskId}-old`, taskId, role: "single", agentType, executor: agentType, executorId: profileId, runOwnerUserId: ownerUserId, cliSessionId: `${taskId}-original-native`, cwd: root, startedAt: at, turnStartedAt: at, endedAt: at });
  return state;
}

try {
  await db.insert(projects).values({ id: "project", name: "recovery", repoPath: root, createdAt: at });
  for (const agentType of ["codex", "claude"] as const) {
    await db.insert(agents).values([
      { id: `${agentType}-old`, name: `${agentType}@原目标`, type: agentType, isDefault: false },
      { id: `${agentType}-new`, name: `${agentType}@新默认`, type: agentType, isDefault: true },
    ]);
    const typoTask = `${agentType}-goal-typos`;
    await create(typoTask, agentType);
    await seed(typoTask, agentType);
    const beforeTypo = await row(typoTask);
    for (const text of ["/goal --scope", "/goal --scope codex:encoded-scope", "/goal -scopes", "/goal --scopes=1", "/goal scopes", ...(agentType === "codex" ? ["/plan --off", "/plan -off", "/review --bas main"] : [])]) {
      const rejected = await reply(typoTask, text);
      assert.equal(rejected.status, 409);
      assert.match((await rejected.json()).error, /\/goal|不支持这个参数/);
      assert.deepEqual(await row(typoTask), beforeTypo, "mistyped flags must not change goals, budgets, usage, holds or task state");
      assert.equal(invocations.has(typoTask), false);
      await assert.rejects(prepareCliInvocation(await row(typoTask), agentType, text, `${agentType}-old`, null));
      assert.deepEqual(await row(typoTask), beforeTypo);
    }
    console.log(`${agentType}: unknown goal/plan/review flags are rejected before any state mutation or model turn: passed`);
    for (const route of ["default", "explicit", "run", "queue", "legacy", "same"] as const) {
      const taskId = `${agentType}-ordinary-${route}`;
      const executorId = route === "same" ? `${agentType}-old` : route === "explicit" ? `${agentType}-old` : null;
      await create(taskId, agentType, { executorId });
      await db.insert(sessions).values({ id: `${taskId}-history`, taskId, role: "single", agentType, executor: agentType, executorId: route === "legacy" ? null : `${agentType}-old`, runOwnerUserId: null, cliConfigDir: "", cliSessionId: `${taskId}-thread`, cwd: root, startedAt: at, turnStartedAt: at, endedAt: at, exitStatus: 0 });
      if (route === "run") await resumeOrRunTask(taskId, { reason: "run" });
      else if (route === "queue") {
        await db.insert(groups).values({ id: taskId, projectId: "project", name: taskId, mode: "serial", createdAt: at });
        await db.update(tasks).set({ groupId: taskId }).where(eq(tasks.id, taskId));
        await db.insert(queueItems).values({ taskId, queueId: taskId, position: 0, createdAt: at });
        await runGroup(taskId);
      } else assert.equal((await reply(taskId, "刚才那段你做完了吗？", route === "explicit" ? { agent: agentType, executorId: `${agentType}-new` } : {})).status, 202);
      await settled(taskId);
      assert.equal(invocations.get(taskId)![0]!.sessionId, `${taskId}-thread`, `${route} must resume history despite profile drift`);
      assert.equal(invocations.get(taskId)![0]!.cliState?.profileId, route === "same" ? `${agentType}-old` : `${agentType}-new`);
      assert.equal((await db.select().from(sessions).where(eq(sessions.taskId, taskId))).length, 1);
    }
    for (const inaccessible of ["owner", "config"] as const) {
      const taskId = `${agentType}-inaccessible-${inaccessible}`;
      await create(taskId, agentType);
      await db.insert(sessions).values({ id: `${taskId}-history`, taskId, role: "single", agentType, executor: agentType, executorId: `${agentType}-old`, runOwnerUserId: inaccessible === "owner" ? "other-owner" : null, cliConfigDir: inaccessible === "config" ? join(root, "old-config") : null, cliSessionId: `${taskId}-thread`, cwd: root, startedAt: at, turnStartedAt: at, endedAt: at, exitStatus: 0 });
      assert.equal((await reply(taskId, "继续回答", { agent: agentType, executorId: `${agentType}-new` })).status, 202);
      await settled(taskId);
      assert.equal(invocations.get(taskId)![0]!.sessionId ?? null, null);
      assert.equal((await db.select().from(sessions).where(eq(sessions.taskId, taskId))).length, 2);
      assert.ok(readFileSync(join(root, "runs", taskId, `${taskId}-history.md`), "utf8").includes(CROSS_OWNER_SESSION_NOTE));
    }
    console.log(`${agentType}: ordinary/default/explicit/run/queue profile drift keeps history; inaccessible owner/config sessions keep persistent notices: passed`);
    for (const pinned of [false, true]) {
      const taskId = `${agentType}-${pinned ? "explicit" : "default"}-drift`;
      await create(taskId, agentType, { executorId: pinned ? `${agentType}-new` : null });
      const held = await seed(taskId, agentType);
      await saveCliState(taskId, agentType, { profileId: `${agentType}-new`, ownerUserId: null, personality: "friendly" }, true);
      await db.insert(sessions).values({ id: `${taskId}-new`, taskId, role: "single", agentType, executor: agentType, executorId: `${agentType}-new`, cliSessionId: "wrong-new-profile-thread", cwd: root, startedAt: at, turnStartedAt: new Date(Date.now() + 1000).toISOString(), endedAt: at });
      const before = await row(taskId);
      const scopes = await reply(taskId, "/goal --scopes");
      assert.equal(scopes.status, 200);
      const snapshot = await scopes.json();
      assert.match(snapshot.text, new RegExp(`${agentType}@原目标`));
      assert.match(snapshot.text, /150 \/ 150/);
      assert.match(snapshot.text, /resume --scope/);
      assert.deepEqual(await row(taskId), before, "discovery does not change status, budget, usage or holds");
      const driftQuery = await reply(taskId, "/goal");
      assert.equal(driftQuery.status, 200);
      assert.match((await driftQuery.json()).text, /原目标/);
      assert.equal((await reply(taskId, "/goal resume")).status, 202);
      const recovered = await settled(taskId);
      const invocation = invocations.get(taskId)![0]!;
      assert.equal(invocation.cliState?.profileId, held.profileId);
      assert.equal(invocation.sessionId, `${taskId}-original-native`, "resume must select the original profile's thread, not the newer profile's goal");
      assert.deepEqual(invocation.cliState?.goal, { ...goal, status: "active" });
      assert.equal(readCliState(recovered.cliState, agentType, held.profileId, null).goal?.tokensUsed, 150);
      assert.equal(readCliState(recovered.cliState, agentType, `${agentType}-new`, null).personality, "friendly");
      assert.equal(recovered.executorId, before.executorId, "fallback is a one-turn route, not a standing executor edit");
    }
    console.log(`${agentType}: default/explicit profile drift discovery, original-thread recovery, budget and standing config preservation: passed`);

    const failed = `${agentType}-rollback`;
    await create(failed, agentType);
    const held = await seed(failed, agentType);
    await saveCliState(failed, agentType, { profileId: `${agentType}-new`, ownerUserId: "other-owner", goal: { ...goal, objective: "另一发起人", tokensUsed: 92 }, goalHold: true });
    const other = readCliState((await row(failed)).cliState, agentType, `${agentType}-new`, "other-owner");
    failStarts.add(failed);
    assert.equal((await reply(failed, "/goal resume")).status, 202);
    const rolledBack = await settled(failed);
    assert.equal(rolledBack.status, "paused");
    assert.equal(rolledBack.goalTurn, false);
    assert.deepEqual(readCliState(rolledBack.cliState, agentType, held.profileId, null), held);
    assert.deepEqual(readCliState(rolledBack.cliState, agentType, `${agentType}-new`, "other-owner"), other);
    assert.equal(selectNextInQueue([rolledBack]), null);
    assert.equal((await reply(failed, `/goal clear --scope ${cliGoalScopeSelector(agentType, held)}`)).status, 202);
    const clearRolledBack = await settled(failed, 2);
    assert.equal(clearRolledBack.status, "paused");
    assert.deepEqual(readCliState(clearRolledBack.cliState, agentType, held.profileId, null), held, "failed clear must not release the original hold");
    assert.deepEqual(readCliState(clearRolledBack.cliState, agentType, `${agentType}-new`, "other-owner"), other);
    const abandoned = `${agentType}-abandoned-clear`;
    await create(abandoned, agentType);
    const abandonedHeld = await seed(abandoned, agentType);
    await prepareCliInvocation(await row(abandoned), agentType, "/goal clear", abandonedHeld.profileId, null);
    await db.update(tasks).set({ status: "running", nativeTurn: true, followUpFrom: "paused" }).where(eq(tasks.id, abandoned));
    await reconcileInterrupted();
    assert.equal((await row(abandoned)).status, "paused");
    assert.deepEqual(readCliState((await row(abandoned)).cliState, agentType, abandonedHeld.profileId, null), abandonedHeld, "a lost clear process restores the hold after server restart");
    console.log(`${agentType}: failed cross-scope startup restores original budget/usage/hold and preserves other owners: passed`);
  }

  await create("no-session-discovery", "codex", { status: "backlog" });
  const beforeDiscovery = await row("no-session-discovery");
  const emptyDiscovery = await (await reply("no-session-discovery", "/goal --scopes")).json();
  assert.equal(emptyDiscovery.recorded, false);
  assert.match(emptyDiscovery.text, /没有已保存的目标/);
  assert.deepEqual(await row("no-session-discovery"), beforeDiscovery);
  assert.equal(invocations.has("no-session-discovery"), false);
  assert.equal((await db.select().from(sessions).where(eq(sessions.taskId, "no-session-discovery"))).length, 0);

  for (const saved of [true, false]) for (const present of [true, false]) for (const text of ["/goal", "/goal pause"]) {
    const taskId = `snapshot-${saved}-${present}-${text.endsWith("pause") ? "pause" : "query"}`;
    await create(taskId, "codex", { executorId: "codex-new" });
    if (saved) await seed(taskId, "codex", null, "codex-new");
    else await db.insert(sessions).values({ id: `${taskId}-old`, taskId, role: "single", agentType: "codex", executor: "codex", executorId: "codex-new", cliSessionId: `${taskId}-original-native`, cwd: root, startedAt: at, turnStartedAt: at, endedAt: at, exitStatus: 0 });
    nativeGoals.set(taskId, present ? { ...goal, objective: "另一个原生目标", status: "active" } : null);
    assert.equal((await reply(taskId, text)).status, 202);
    const result = await settled(taskId);
    assert.equal(result.status, "paused");
    assert.equal(result.goalTurn, false);
    assert.equal((await db.select().from(sessions).where(eq(sessions.taskId, taskId)))[0]!.exitStatus, 0);
    assert.deepEqual(nativeCalls.get(taskId), ["thread/goal/get"]);
    const state = readCliState(result.cliState, "codex", "codex-new", null);
    assert.deepEqual(state.goal ?? null, saved ? { ...goal, status: text === "/goal pause" ? "paused" : goal.status } : null);
    assert.equal(state.goalHold ?? false, saved);
    let transcript = "";
    for (let attempt = 0; attempt < 100 && !transcript.includes("原生会话"); attempt++) {
      await delay(10);
      transcript = readFileSync(join(root, "runs", taskId, `${taskId}-old.md`), "utf8");
    }
    assert.match(transcript, /原生会话/);
    assert.doesNotMatch(transcript, /起跑失败|启动失败/);
  }
  console.log("no-session discovery is model-free; snapshot query/pause mismatch completes normally without changing native goals or releasing holds: passed");

  const budgetTaskId = "codex-explicit-drift";
  await db.insert(sessions).values({ id: "budget-newer-wrong-session", taskId: budgetTaskId, role: "single", agentType: "codex", executor: "codex", executorId: "codex-old", cliSessionId: "another-goal-native", cwd: root, startedAt: at, turnStartedAt: new Date(Date.now() + 2000).toISOString(), endedAt: at });
  assert.equal((await reply(budgetTaskId, "/goal budget 300", { agent: "codex", executorId: "codex-old" })).status, 202);
  const afterBudget = await settled(budgetTaskId, 2);
  const budgetState = readCliState(afterBudget.cliState, "codex", "codex-old", null);
  assert.equal(invocations.get(budgetTaskId)![1]!.sessionId, `${budgetTaskId}-original-native`, "budget control must use the saved goal's thread, not the newest same-profile thread");
  assert.equal(budgetState.goal?.tokenBudget, 300, "successful native budget changes are saved for later recovery validation");
  assert.equal(budgetState.goal?.tokensUsed, 150);
  assert.equal(budgetState.goal?.timeUsedSeconds, 21);
  assert.equal(budgetState.goalHold, true, "budget control does not release the scheduler hold");
  assert.equal((await reply(budgetTaskId, "/goal", { agent: "codex", executorId: "codex-old" })).status, 202);
  await settled(budgetTaskId, 3);
  assert.equal(invocations.get(budgetTaskId)![2]!.sessionId, `${budgetTaskId}-original-native`);
  assert.equal(invocations.get(budgetTaskId)![2]!.cliState?.goal?.tokenBudget, 300);
  assert.equal((await reply(budgetTaskId, "/goal resume")).status, 202);
  const afterBudgetResume = await settled(budgetTaskId, 4);
  assert.equal(readCliState(afterBudgetResume.cliState, "codex", "codex-old", null).goalSessionId, `${budgetTaskId}-original-native`, "settlement must preserve the actual goal thread even when another session has a later timestamp");
  console.log("native goal controls select the saved thread and persist budgets without releasing holds or resetting usage: passed");

  await create("multiple", "codex");
  const first = await seed("multiple", "codex");
  const second = { profileId: "claude-old", ownerUserId: null, goal: { ...goal, objective: "Claude 独立目标" }, goalHold: true };
  await saveCliState("multiple", "claude", second);
  const beforeMultiple = await row("multiple");
  for (const text of ["/goal resume", "/goal clear"]) {
    const ambiguous = await reply("multiple", text);
    assert.equal(ambiguous.status, 409);
    assert.match((await ambiguous.json()).error, /多个目标[\s\S]*--scope/);
    assert.deepEqual(await row("multiple"), beforeMultiple);
  }
  const secondScope = cliGoalScopeSelector("claude", second);
  assert.equal((await reply("multiple", `/goal resume --scope ${secondScope}`)).status, 202);
  await settled("multiple");
  assert.equal(invocations.get("multiple")![0]!.cliState?.profileId, "claude-old");
  assert.deepEqual(readCliState((await row("multiple")).cliState, "codex", "codex-old", null), first);
  assert.equal((await reply("multiple", `/goal clear --scope ${secondScope}`)).status, 202);
  await settled("multiple", 2);
  assert.equal(readCliState((await row("multiple")).cliState, "claude", "claude-old", null).goal, null);
  assert.equal(hasCliGoalHold((await row("multiple")).cliState), true);
  assert.deepEqual(readCliState((await row("multiple")).cliState, "codex", "codex-old", null), first);
  console.log("ambiguous goals require a selector; cross-agent recovery/clear only touches the selected scope: passed");

  await create("fresh-cross-agent-rollback", "codex", { body: "/goal resume" });
  const freshHeld = await seed("fresh-cross-agent-rollback", "claude");
  failStarts.add("fresh-cross-agent-rollback");
  await runTask("fresh-cross-agent-rollback");
  assert.equal((await row("fresh-cross-agent-rollback")).status, "paused");
  assert.deepEqual(readCliState((await row("fresh-cross-agent-rollback")).cliState, "claude", freshHeld.profileId, null), freshHeld);
  assert.equal(invocations.get("fresh-cross-agent-rollback")![0]!.cliState?.profileId, "claude-old");

  await create("owners", "codex");
  const alice = { profileId: "deleted-owner-profile", ownerUserId: "alice", goal: { ...goal, objective: "Alice 私有条件" }, goalHold: true };
  const bob = { ...alice, ownerUserId: "bob", goal: { ...goal, objective: "Bob 私有条件", tokensUsed: 73 } };
  await saveCliState("owners", "codex", alice);
  await saveCliState("owners", "codex", bob);
  const bobScope = cliGoalScopeSelector("codex", bob);
  const beforeOwners = await row("owners");
  for (const text of [`/goal resume --scope ${bobScope}`, `/goal clear --scope ${bobScope}`]) {
    const forbidden = await reply("owners", text, {}, "alice");
    assert.equal(forbidden.status, 409);
    assert.match((await forbidden.json()).error, /只有目标原发起人/);
    assert.deepEqual(await row("owners"), beforeOwners);
  }
  const ownerSnapshot = await (await reply("owners", "/goal --scopes", {}, "alice")).json();
  assert.match(ownerSnapshot.text, /Alice 私有条件/);
  assert.doesNotMatch(ownerSnapshot.text, /Bob 私有条件/);
  assert.equal((await reply("owners", "/goal clear", {}, "alice")).status, 200);
  assert.equal(hasCliGoalHold((await row("owners")).cliState), true);
  assert.deepEqual(readCliState((await row("owners")).cliState, "codex", bob.profileId, "bob"), bob);
  assert.equal((await reply("owners", `/goal clear --scope ${bobScope}`, {}, "bob")).status, 200);
  assert.equal(hasCliGoalHold((await row("owners")).cliState), false);
  console.log("only the original initiator may clear/recover; foreign goal contents and holds remain protected: passed");

  await db.insert(groups).values([
    { id: "serial", projectId: "project", name: "serial", mode: "serial", createdAt: at },
    { id: "parallel", projectId: "project", name: "parallel", mode: "parallel", createdAt: at },
    { id: "serial-rollback", projectId: "project", name: "rollback", mode: "serial", createdAt: at },
    { id: "serial-paused", projectId: "project", name: "paused", mode: "serial", paused: true, createdAt: at },
    { id: "serial-blocked", projectId: "project", name: "blocked", mode: "serial", createdAt: at },
  ]);
  await create("queue-running-blocker", "codex", { groupId: "serial-blocked", status: "running" });
  await create("queue-blocked-recovery", "codex", { groupId: "serial-blocked", resumePrompt: "原检查点" });
  const blockedHeld = await seed("queue-blocked-recovery", "codex");
  await db.insert(queueItems).values(["queue-running-blocker", "queue-blocked-recovery"].map((taskId, position) => ({ taskId, queueId: "queue-blocked", position, createdAt: at })));
  const blockedResume = await reply("queue-blocked-recovery", "/goal resume");
  assert.equal(blockedResume.status, 202);
  assert.equal((await blockedResume.json()).scheduled, true, "goal recovery is execution and must wait for its serial queue seat");
  const [waitingResume] = await db.select().from(scheduledMessages).where(eq(scheduledMessages.taskId, "queue-blocked-recovery"));
  assert.match(waitingResume!.text, new RegExp(`^/goal resume --scope ${cliGoalScopeSelector("codex", blockedHeld)}$`));
  assert.equal(invocations.has("queue-blocked-recovery"), false);
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, "queue-running-blocker"));
  await advanceQueueFromTask("queue-running-blocker");
  await settled("queue-blocked-recovery");
  assert.equal(invocations.get("queue-blocked-recovery")![0]!.cliCommand?.args, "resume", "the frozen recovery command is delivered once its predecessor releases the queue");
  assert.equal((await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, waitingResume!.id)))[0]!.status, "sent");
  await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, "queue-running-blocker"));
  assert.equal((await reply("queue-blocked-recovery", "/goal clear")).status, 202);
  await settled("queue-blocked-recovery", 2);
  assert.equal(invocations.get("queue-blocked-recovery")![1]!.cliCommand?.args, "clear", "non-execution cleanup bypasses queue blocking without starting recovery");
  assert.equal((await row("queue-blocked-recovery")).status, "paused");
  console.log("scope recovery respects serial queue seats; scope cleanup remains reachable behind running predecessors: passed");
  await create("queue-rollback", "codex", { groupId: "serial-rollback" });
  const queueHeld = await seed("queue-rollback", "codex");
  await create("queue-after-rollback", "codex", { groupId: "serial-rollback", status: "backlog" });
  await db.insert(queueItems).values(["queue-rollback", "queue-after-rollback"].map((taskId, position) => ({ taskId, queueId: "queue-rollback", position, createdAt: at })));
  failStarts.add("queue-rollback");
  assert.equal((await reply("queue-rollback", "/goal resume")).status, 202);
  const queueRolledBack = await settled("queue-rollback");
  assert.equal(queueRolledBack.status, "paused", "queued goal startup failure must not turn a held head into a transparently skipped failure");
  assert.deepEqual(readCliState(queueRolledBack.cliState, "codex", queueHeld.profileId, null), queueHeld);
  await delay(40);
  assert.equal(invocations.has("queue-after-rollback"), false);
  assert.equal(selectNextInQueue([queueRolledBack, await row("queue-after-rollback")]), null);
  await create("queue-clear", "codex", { groupId: "serial" });
  await seed("queue-clear", "codex");
  await db.insert(queueItems).values({ taskId: "queue-clear", queueId: "queue", position: 0, createdAt: at });
  assert.equal(selectNextInQueue([await row("queue-clear")]), null);
  assert.equal((await reply("queue-clear", "/goal clear")).status, 202);
  await settled("queue-clear", 2);
  assert.equal(invocations.get("queue-clear")![0]!.cliState?.profileId, "codex-old");
  assert.equal(invocations.get("queue-clear")![1]!.cliCommand, undefined, "clearing the final hold automatically resumes the unpaused queue");
  assert.equal(hasCliGoalHold((await row("queue-clear")).cliState), false);
  await create("paused-queue-clear", "claude", { groupId: "serial-paused" });
  await seed("paused-queue-clear", "claude");
  await db.insert(queueItems).values({ taskId: "paused-queue-clear", queueId: "queue-paused", position: 0, createdAt: at });
  assert.equal((await reply("paused-queue-clear", "/goal clear")).status, 202);
  assert.equal((await settled("paused-queue-clear")).status, "paused");
  await delay(40);
  assert.equal(invocations.get("paused-queue-clear")!.length, 1, "clearing a goal never cancels the group's pause intent");
  assert.equal((await db.select().from(groups).where(eq(groups.id, "serial-paused")))[0]!.paused, true);
  assert.equal((await app.request("/groups/serial-paused/run", { method: "POST" })).status, 202);
  await settled("paused-queue-clear", 2);

  await create("deleted", "claude", { groupId: "parallel" });
  const deleted = await seed("deleted", "claude", null, "deleted-profile");
  const missing = await reply("deleted", "/goal resume");
  assert.equal(missing.status, 409);
  assert.match((await missing.json()).error, /目标仍保存在[\s\S]*deleted-profile[\s\S]*clear --scope/);
  await runGroup("parallel");
  assert.equal(invocations.has("deleted"), false);
  assert.equal((await row("deleted")).status, "paused");
  assert.equal((await reply("deleted", `/goal clear --scope ${cliGoalScopeSelector("claude", deleted)}`)).status, 200);
  assert.equal(invocations.has("deleted"), false, "deleted profiles can be cleared without launching any replacement CLI");
  await runGroup("parallel");
  await settled("deleted");
  assert.equal(hasCliGoalHold((await row("deleted")).cliState), false);
  console.log("final scoped clear automatically unlocks the queue; deleted profiles expose a no-CLI clear path and unlock runGroup: passed");

  const legacy = { profileId: "codex-old", ownerUserId: null, goal, goalHold: true };
  await create("legacy", "codex", { cliState: JSON.stringify({ codex: legacy }) });
  assert.equal((await reply("legacy", "/goal resume")).status, 202);
  await settled("legacy");
  assert.equal(invocations.get("legacy")![0]!.cliState?.profileId, legacy.profileId);
  assert.equal(readCliState((await row("legacy")).cliState, "codex", legacy.profileId, null).goal?.tokenBudget, 150);
  await create("legacy-builtin", "codex", { cliState: JSON.stringify({ codex: { goal, goalHold: true } }) });
  for (const scenario of ["deleted", "changed-type", "legacy-builtin", "runnable"] as const) {
    const taskId = scenario === "changed-type" ? "changed-type" : scenario === "runnable" ? "runnable-hint" : scenario;
    if (scenario === "changed-type") {
      await db.insert(agents).values({ id: "changed-profile", name: "类型已改变", type: "claude" });
      await create(taskId, "codex");
      await saveCliState(taskId, "codex", { profileId: "changed-profile", ownerUserId: null, goal, goalHold: true });
    } else if (scenario === "runnable") {
      await create(taskId, "codex");
      await seed(taskId, "codex");
    } else if (scenario === "deleted") {
      await saveCliState(taskId, "claude", deleted, true);
    }
    const beforeHint = await row(taskId);
    const hint = await (await reply(taskId, "/goal --scopes")).json();
    assert.match(hint.text, /清除：\/goal clear --scope/);
    if (scenario === "runnable") assert.match(hint.text, /恢复：\/goal resume --scope/);
    else {
      assert.doesNotMatch(hint.text, /恢复：\/goal resume/);
      assert.match(hint.text, /原执行器已不可用[\s\S]*不能恢复/);
    }
    assert.equal((await row(taskId)).cliState, beforeHint.cliState);
    if (scenario === "deleted") await saveCliState(taskId, "claude", { ...deleted, goal: null, goalHold: false });
  }
  assert.equal((await reply("legacy-builtin", "/goal resume")).status, 409, "an old built-in scope is not silently moved into the newly registered default profile");
  assert.equal((await reply("legacy-builtin", "/goal clear")).status, 200);
  assert.equal(hasCliGoalHold((await row("legacy-builtin")).cliState), false);
  assert.equal(invocations.has("legacy-builtin"), false);
  const beforeUnknown = await row("legacy");
  assert.equal((await reply("legacy", "/goal clear --scope bogus")).status, 409);
  assert.deepEqual(await row("legacy"), beforeUnknown);
  await assert.rejects(continueTask("legacy", "/goal resume --scope bogus"), /作用域不存在/);
  const timed = await reply("legacy", `/goal resume --scope ${cliGoalScopeSelector("codex", legacy)}`, { sendAt: new Date(Date.now() + 60000).toISOString() });
  assert.equal(timed.status, 409);
  console.log("legacy single-slot goals, stale/tampered selectors, and immediate-only scope commands: passed");
} finally {
  CodexExecutor.prototype.runSteerable = originalCodex;
  ClaudeExecutor.prototype.runSteerable = originalClaude;
  await delay(80);
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}

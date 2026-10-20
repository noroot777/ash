import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { CliCommand, CliGoal } from "@ash/shared/cli-commands";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-cli-task-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
const { db, ensureSchema } = await import("../src/db/index.js");
const { agents, projects, tasks, sessions, scheduledMessages } = await import("../src/db/schema.js");
const { replyToTask } = await import("../src/task-reply.js");
const { settleTaskStatus } = await import("../src/settle-status.js");
const { prepareCliInvocation, readCliState, saveCliState, persistRunGoal, interruptCliGoal } = await import("../src/task-cli-state.js");
const { bus } = await import("../src/bus.js");
const { claudeGoalInvocation, formatClaudeGoal } = await import("../src/executors/claude-goal.js");
const { reconcileInterrupted } = await import("../src/task-reconcile.js");
const { createTasks, enrichTasks } = await import("../src/task-store.js");
const { trackRun, untrackRun, takeStopped } = await import("../src/runs.js");
const { selectNextInQueue } = await import("../src/scheduler.js");
const { sessionTranscriptPath } = await import("../src/transcript.js");
const { continueTask } = await import("../src/orchestrator.js");
const { hasCliGoalHold } = await import("@ash/shared/cli-commands");
await ensureSchema();
const app = new Hono();
app.post("/:id/reply", (context) => replyToTask(context, context.req.param("id")));
const at = new Date().toISOString();
const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
const create = async (id: string, extra: Partial<typeof tasks.$inferInsert> = {}) => db.insert(tasks).values({ id, projectId: "project", title: id, body: "任务", status: "running", mode: "single", agentType: "codex", autoTitle: false, createdAt: at, updatedAt: at, ...extra });
const reply = (id: string, text: string, extra = {}) => app.request(`/${id}/reply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, ...extra }) });
try {
  await db.insert(projects).values({ id: "project", name: "cli-test", repoPath: root, createdAt: at });
  await create("goal", { goalTurn: true });
  await db.insert(sessions).values({ id: "session", taskId: "goal", role: "single", agentType: "codex", executor: "codex", cliSessionId: "native-thread", cwd: root, startedAt: at });
  await db.insert(sessions).values({ id: "newer-closed-session", taskId: "goal", role: "single", agentType: "claude", executor: "claude", cwd: root, startedAt: new Date(Date.parse(at) + 1000).toISOString(), endedAt: at });
  let goal: CliGoal = { objective: "通过测试", status: "active", tokenBudget: 400 };
  await saveCliState("goal", "codex", { ownerUserId: null, profileId: null, goal });
  await saveCliState("goal", "claude", { ownerUserId: null, profileId: null, goal: { objective: "另一执行器", status: "paused" } });
  const calls: CliCommand[] = [];
  let kills = 0;
  const handle = { sessionId: "native-thread", commandLine: "fake", events: (async function* () {})(), kill: () => { kills++; }, command: async (command: CliCommand) => { calls.push(command); if (command.args === "pause") goal = { ...goal, status: "paused" }; return "原生结果"; }, goal: () => goal };
  trackRun("goal", handle);
  const queried = await reply("goal", "/goal");
  assert.equal(queried.status, 200);
  assert.deepEqual(await queried.json(), { started: false, command: true, text: "原生结果", recorded: true });
  assert.equal(kills, 0);
  assert.equal((await reply("goal", "/goal 替换目标")).status, 409);
  assert.equal((await reply("goal", "/status", { attachments: ["file"] })).status, 409);
  assert.equal((await reply("goal", "/status", { agent: "claude" })).status, 409);
  assert.equal((await reply("goal", "/goal pause")).status, 200);
  assert.equal(kills, 1);
  assert.equal(takeStopped("goal"), "paused");
  assert.equal(calls.length, 2);
  assert.equal((await db.select().from(scheduledMessages)).length, 0);
  assert.match(readFileSync(sessionTranscriptPath("goal", "session"), "utf8"), /原生结果/);
  assert.equal(readCliState((await row("goal")).cliState, "claude").goal?.objective, "另一执行器");
  await persistRunGoal("goal", "codex", handle, 0, "paused");
  const stopped = await settleTaskStatus("goal", 0, "paused");
  assert.equal(stopped.status, "paused");
  assert.match(stopped.note!, /持续目标已暂停/);
  assert.match(stopped.note!, /\/goal resume/);
  assert.equal((await row("goal")).goalTurn, false);
  assert.equal(readCliState((await row("goal")).cliState, "codex").goalHold, true);
  assert.equal(selectNextInQueue([await row("goal")]), null);
  untrackRun("goal", handle);

  let clearedGoal: CliGoal | null = goal;
  const clearing = { ...handle, goalStarted: () => true, goal: () => clearedGoal, command: async () => { clearedGoal = null; return "目标已清除"; } };
  await db.update(tasks).set({ goalTurn: true, status: "running" }).where(eq(tasks.id, "goal"));
  trackRun("goal", clearing);
  assert.equal((await reply("goal", "/goal clear")).status, 200);
  assert.equal(takeStopped("goal"), "paused");
  assert.equal(readCliState((await row("goal")).cliState, "codex").goal, null);
  assert.equal(hasCliGoalHold((await row("goal")).cliState), false);
  await persistRunGoal("goal", "codex", clearing, 0, "paused");
  const cleared = await settleTaskStatus("goal", 0, "paused");
  assert.equal(cleared.status, "paused");
  assert.match(cleared.note!, /持续目标已清除/);
  assert.match(cleared.note!, /\/goal 描述/);
  assert.doesNotMatch(cleared.note!, /\/goal resume/);
  assert.equal(hasCliGoalHold((await row("goal")).cliState), false);
  assert.equal(selectNextInQueue([await row("goal")])?.id, "goal");
  untrackRun("goal", clearing);

  for (const agentType of ["codex", "claude"] as const) {
    for (const action of ["pause", "clear", "stop", "off", "reset", "none", "cancel"]) {
      const taskId = `scoped-${agentType}-${action}`;
      const sessionId = `${taskId}-session`;
      const otherAgent = agentType === "codex" ? "claude" : "codex";
      await create(taskId, { agentType: otherAgent, goalTurn: true });
      await db.insert(sessions).values({ id: sessionId, taskId, role: "single", agentType, executor: agentType, executorId: "running-profile", runOwnerUserId: "running-owner", cwd: root, startedAt: at, endedAt: at });
      await saveCliState(taskId, agentType, { profileId: "running-profile", ownerUserId: "running-owner", goal, goalHold: true }, true);
      await prepareCliInvocation(await row(taskId), agentType, `/goal ${action}`, "running-profile", "running-owner");
      await saveCliState(taskId, agentType, { profileId: "other-profile", ownerUserId: "running-owner", goal: { ...goal, objective: "另一个 profile 的目标" } }, true);
      await saveCliState(taskId, agentType, { profileId: "running-profile", ownerUserId: "other-owner", goal: { ...goal, objective: "另一个发起人的目标" } }, true);
      await saveCliState(taskId, otherAgent, { goal: { ...goal, objective: "常设智能体的目标" } }, true);
      const settled = await settleTaskStatus(taskId, 0, "paused", sessionId);
      assert.equal(settled.status, "paused");
      if (action === "pause") {
        assert.match(settled.note!, /持续目标已暂停.*\/goal resume/);
      } else {
        assert.match(settled.note!, /持续目标已清除.*\/goal 描述/);
        assert.doesNotMatch(settled.note!, /\/goal resume/);
      }
      const state = (await row(taskId)).cliState;
      assert.equal(readCliState(state, agentType, "other-profile", "running-owner").goal?.objective, "另一个 profile 的目标");
      assert.equal(readCliState(state, agentType, "running-profile", "other-owner").goal?.objective, "另一个发起人的目标");
      assert.equal(readCliState(state, otherAgent).goal?.objective, "常设智能体的目标");
    }
  }

  await create("ordinary");
  await db.insert(sessions).values({ id: "ordinary-session", taskId: "ordinary", role: "single", agentType: "codex", executor: "codex", cwd: root, startedAt: at });
  trackRun("ordinary", handle);
  assert.equal((await reply("ordinary", "/goal clear")).status, 200);
  assert.equal(kills, 2, "清理一个不存在的目标不能杀掉普通任务");
  assert.equal(takeStopped("ordinary"), null);
  let renamedEvent = false;
  const unsubscribe = bus.subscribe((event) => { if (event.type === "task.updated" && event.task.id === "ordinary" && event.task.title === "新会话名") renamedEvent = true; });
  assert.equal((await reply("ordinary", "/rename 新会话名")).status, 200);
  assert.equal((await row("ordinary")).title, "新会话名");
  assert.equal(renamedEvent, true);
  unsubscribe();
  await persistRunGoal("ordinary", "codex", { ...handle, cliCommand: { name: "rename", args: "离线会话名", text: "/rename 离线会话名" } }, 0);
  assert.equal((await row("ordinary")).title, "离线会话名");
  untrackRun("ordinary", handle);

  await create("unconfirmed", { goalTurn: true });
  assert.equal((await settleTaskStatus("unconfirmed", 0)).status, "paused");
  await create("confirmed", { goalTurn: true, completeConfirmedAt: at });
  assert.equal((await settleTaskStatus("confirmed", 0)).status, "done");
  await create("inspection", { nativeTurn: true, followUpFrom: "done", stage: "accepted" });
  assert.equal((await settleTaskStatus("inspection", 1)).status, "done");
  assert.equal((await row("inspection")).stage, "accepted");
  await create("fresh-command", { nativeTurn: true });
  assert.equal((await settleTaskStatus("fresh-command", 0)).status, "done");
  await create("normal");
  assert.equal((await settleTaskStatus("normal", 0)).status, "failed");

  await create("plan", { executorId: null, status: "done" });
  const planUpdates: boolean[] = [];
  const unsubscribePlan = bus.subscribe((event) => {
    if (event.type === "task.updated" && event.task.id === "plan") planUpdates.push(!!event.task.codexPlanMode);
  });
  const planned = await prepareCliInvocation(await row("plan"), "codex", "/plan", "resolved-profile", null);
  assert.equal(planned.cliState.plan, true);
  const visiblePlan = (await enrichTasks([await row("plan")]))[0]!;
  assert.equal(visiblePlan.codexPlanMode, true);
  assert.equal(Object.hasOwn(visiblePlan, "cliState"), false);
  assert.equal(planUpdates.at(-1), true);
  assert.equal((await prepareCliInvocation(await row("plan"), "codex", "继续讨论", "resolved-profile", null)).cliState.plan, true);
  assert.equal((await prepareCliInvocation(await row("plan"), "codex", "继续讨论", "another-profile", null)).cliState.plan, undefined);
  assert.equal(planUpdates.at(-1), true);
  assert.deepEqual((await enrichTasks([await row("plan")]))[0]?.codexPlanScopes, [{ executorId: "resolved-profile", executorLabel: "resolved-profile", isTaskOwner: true }]);
  assert.equal(readCliState((await row("plan")).cliState, "codex", "resolved-profile", null).plan, true);
  assert.deepEqual(readCliState((await row("plan")).cliState, "codex", "resolved-profile", "other-owner"), {});
  await saveCliState("plan", "codex", { profileId: "resolved-profile", ownerUserId: null, plan: true, personality: "friendly", serviceTier: "priority" });
  await saveCliState("plan", "claude", { goal: { objective: "保留其他执行器的目标", status: "paused" } });
  const freshPlan = await prepareCliInvocation(await row("plan"), "codex", "开始实施", "resolved-profile", null, { resetPlan: true });
  assert.equal(freshPlan.cliState.plan, false);
  assert.equal(freshPlan.cliState.personality, "friendly");
  assert.equal(freshPlan.cliState.serviceTier, "priority");
  assert.equal(readCliState((await row("plan")).cliState, "claude").goal?.objective, "保留其他执行器的目标");
  assert.equal((await enrichTasks([await row("plan")]))[0]?.codexPlanMode, false);
  assert.equal(planUpdates.at(-1), false);
  assert.equal((await prepareCliInvocation(await row("plan"), "codex", "/plan", "resolved-profile", null, { resetPlan: true })).cliState.plan, true);
  assert.equal(planUpdates.at(-1), true);
  assert.equal((await prepareCliInvocation(await row("plan"), "codex", "/status", "resolved-profile", null)).cliState.plan, true);
  assert.equal((await prepareCliInvocation(await row("plan"), "codex", "/plan off", "resolved-profile", null)).cliState.plan, false);
  assert.equal(planUpdates.at(-1), false);
  const scopedGoal: CliGoal = { objective: "保留作用域的预算与用量", status: "budgetLimited", tokenBudget: 150, tokensUsed: 150, timeUsedSeconds: 21 };
  for (const [profileId, ownerUserId] of [["resolved-profile", null], ['other."profile%中文', null], ["resolved-profile", "other-owner"]] as const) {
    await saveCliState("plan", "codex", { profileId, ownerUserId, plan: true, goal: scopedGoal, goalHold: true, personality: "friendly", serviceTier: "priority" });
  }
  await prepareCliInvocation(await row("plan"), "codex", "/status", "inactive-profile", null);
  assert.equal(planUpdates.at(-1), true);
  assert.equal((await enrichTasks([await row("plan")]))[0]?.codexPlanScopes?.length, 3);
  assert.deepEqual((await enrichTasks([await row("plan")]))[0]?.codexPlanScopes?.map((scope) => scope.isTaskOwner), [true, true, false]);
  await prepareCliInvocation(await row("plan"), "codex", "/plan off", "resolved-profile", null);
  assert.equal((await enrichTasks([await row("plan")]))[0]?.codexPlanMode, true, "turning off one scope must not hide another scope's plan");
  assert.equal((await enrichTasks([await row("plan")]))[0]?.codexPlanScopes?.length, 2);
  const enabledPlanScopes = (await enrichTasks([await row("plan")]))[0]?.codexPlanScopes;
  await db.update(tasks).set({ agentType: "claude" }).where(eq(tasks.id, "plan"));
  assert.equal((await enrichTasks([await row("plan")]))[0]?.codexPlanMode, true, "standing agent changes must not hide saved Codex plan scopes");
  assert.deepEqual((await enrichTasks([await row("plan")]))[0]?.codexPlanScopes, enabledPlanScopes);
  const beforeClaudeRun = (await row("plan")).cliState;
  await prepareCliInvocation(await row("plan"), "claude", "旁路验证", "claude-profile", null, { resetPlan: true, preserveState: true });
  assert.equal((await row("plan")).cliState, beforeClaudeRun, "side turns must not reset any stored plan scopes");
  await prepareCliInvocation(await row("plan"), "claude", "正常实施", "claude-profile", null, { resetPlan: true });
  for (const [profileId, ownerUserId] of [["resolved-profile", null], ['other."profile%中文', null], ["resolved-profile", "other-owner"]] as const) {
    assert.deepEqual(readCliState((await row("plan")).cliState, "codex", profileId, ownerUserId), {
      profileId, ownerUserId, plan: false, goal: scopedGoal, goalHold: true, personality: "friendly", serviceTier: "priority",
    }, "running with Claude must reset all Codex plan scopes without changing goal state");
  }
  assert.equal(hasCliGoalHold((await row("plan")).cliState), true);
  assert.equal(readCliState((await row("plan")).cliState, "claude", null, null).goal?.objective, "保留其他执行器的目标");
  assert.equal((await enrichTasks([await row("plan")]))[0]?.codexPlanMode, false);
  assert.deepEqual((await enrichTasks([await row("plan")]))[0]?.codexPlanScopes, []);
  await db.update(tasks).set({ agentType: "codex" }).where(eq(tasks.id, "plan"));
  assert.equal((await enrichTasks([await row("plan")]))[0]?.codexPlanMode, false);
  await db.update(tasks).set({ cliState: JSON.stringify({ codex: { profileId: "legacy-profile", ownerUserId: null, plan: true, goal: scopedGoal, goalHold: true } }) }).where(eq(tasks.id, "plan"));
  await prepareCliInvocation(await row("plan"), "claude", "旧状态重新运行", "claude-profile", null, { resetPlan: true });
  assert.deepEqual(readCliState((await row("plan")).cliState, "codex", "legacy-profile", null), { profileId: "legacy-profile", ownerUserId: null, plan: false, goal: scopedGoal, goalHold: true });
  assert.equal(planUpdates.at(-1), false);
  console.log("plan banner covers all profile/owner scopes across standing agent switches and summoned turns; reruns reset all scopes while preserving goals: passed");
  await db.update(tasks).set({ cliState: JSON.stringify({ codex: { plan: true } }) }).where(eq(tasks.id, "plan"));
  assert.deepEqual((await enrichTasks([await row("plan")]))[0]?.codexPlanScopes, [{ executorId: null, executorLabel: "Codex（未绑定执行器）", isTaskOwner: true }]);
  await prepareCliInvocation(await row("plan"), "claude", "未绑定执行器的旧状态重新运行", "claude-profile", null, { resetPlan: true });
  assert.equal(readCliState((await row("plan")).cliState, "codex").plan, false);
  unsubscribePlan();
  await db.update(tasks).set({ cliState: "malformed" }).where(eq(tasks.id, "plan"));
  assert.equal((await enrichTasks([await row("plan")]))[0]?.codexPlanMode, false);

  await create("summoned-plan", { agentType: "claude", status: "paused" });
  await prepareCliInvocation(await row("summoned-plan"), "codex", "/plan", "resolved-profile", null);
  const summonedPlan = await prepareCliInvocation(await row("summoned-plan"), "codex", "照方案动手改吧", "resolved-profile", null);
  assert.equal(summonedPlan.cliState.plan, true);
  assert.equal((await row("summoned-plan")).agentType, "claude", "temporary Codex turns must not change the standing agent");
  const claudeReply = await prepareCliInvocation(await row("summoned-plan"), "claude", "Claude 正常实施", "claude-profile", null);
  assert.notEqual(claudeReply.cliState.plan, true);
  assert.equal((await enrichTasks([await row("summoned-plan")]))[0]?.codexPlanMode, true);
  assert.deepEqual((await enrichTasks([await row("summoned-plan")]))[0]?.codexPlanScopes, [{ executorId: "resolved-profile", executorLabel: "resolved-profile", isTaskOwner: true }], "ordinary Claude replies must not hide saved Codex plan scopes");

  await create("claude", { agentType: "claude", status: "paused" });
  await saveCliState("claude", "claude", { ownerUserId: null, profileId: null, goal: { objective: "Claude 目标", status: "paused" } });
  const claude = await reply("claude", "/goal");
  assert.equal(claude.status, 200);
  assert.equal((await claude.json()).recorded, false);
  await create("claude-running", { agentType: "claude" });
  await db.insert(sessions).values({ id: "claude-running-session", taskId: "claude-running", role: "single", agentType: "claude", executor: "claude", cliSessionId: "claude-live-thread", cwd: root, startedAt: at });
  let claudeKills = 0;
  const claudeHandle = { ...handle, sessionId: "claude-live-thread", kill: () => { claudeKills++; } };
  trackRun("claude-running", claudeHandle);
  for (const snapshot of [{ objective: "普通回合里查看保存的目标", status: "paused" } as CliGoal, null]) {
    await saveCliState("claude-running", "claude", { ownerUserId: null, profileId: null, goal: snapshot });
    const beforeSnapshot = await row("claude-running");
    const liveSnapshot = await reply("claude-running", "/goal");
    assert.equal(liveSnapshot.status, 200);
    assert.deepEqual(await liveSnapshot.json(), { started: false, command: true, text: formatClaudeGoal(snapshot), recorded: true });
    assert.deepEqual(await row("claude-running"), beforeSnapshot);
    for (const control of ["/goal pause", "/goal clear"]) {
      const rejectedControl = await reply("claude-running", control);
      assert.equal(rejectedControl.status, 409);
      assert.match((await rejectedControl.json()).error, /当前回合没有正在执行的目标/);
      assert.deepEqual(await row("claude-running"), beforeSnapshot);
    }
  }
  assert.equal((await reply("claude-running", "/goal", { agent: "codex" })).status, 409);
  assert.equal((await reply("claude-running", "/goal", { executorId: "other-profile" })).status, 409);
  assert.equal(claudeKills, 0);
  untrackRun("claude-running", claudeHandle);
  await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, "claude-running"));
  await db.update(sessions).set({ endedAt: at }).where(eq(sessions.id, "claude-running-session"));
  await assert.rejects(createTasks([{ id: "unsupported-team", projectId: "project", title: "goal", body: "/goal 完成", agentType: "codex", mode: "team", createdAt: at, updatedAt: at }]), /普通单任务/);
  assert.equal(await row("unsupported-team"), undefined);
  await create("legacy-slash", { agentType: "claude", body: "/fast on", status: "done" });
  assert.equal((await enrichTasks([await row("legacy-slash")]))[0]?.id, "legacy-slash");

  for (const agentType of ["codex", "claude"] as const) {
    const missing = `missing-${agentType}`;
    await create(missing, { agentType, status: "done", stage: "accepted" });
    const before = await row(missing);
    const rejected = await reply(missing, "/goal resume");
    assert.equal(rejected.status, 409);
    assert.match((await rejected.json()).error, /没有可恢复的目标/);
    assert.deepEqual(await row(missing), before);
    await assert.rejects(continueTask(missing, "/goal resume"), /没有可恢复的目标/);
    assert.deepEqual(await row(missing), before);
    await assert.rejects(prepareCliInvocation(before, agentType, "/goal resume", null, null), /没有可恢复的目标/);
    await saveCliState(missing, agentType, { profileId: "different-profile", ownerUserId: null, goal: { objective: "其他执行器的目标", status: "paused" } });
    const mismatched = await row(missing);
    assert.equal((await reply(missing, "/goal resume")).status, 409);
    assert.deepEqual(await row(missing), mismatched);
    await saveCliState(missing, agentType, { profileId: null, ownerUserId: "other-owner", goal: { objective: "其他归属人的目标", status: "paused" } });
    const otherOwner = await row(missing);
    assert.equal((await reply(missing, "/goal resume")).status, 409);
    assert.deepEqual(await row(missing), otherOwner);

    const failed = `startup-${agentType}`;
    await create(failed, { agentType, status: "done", stage: "accepted" });
    await prepareCliInvocation(await row(failed), agentType, "/goal 新目标", null, null);
    await db.update(tasks).set({ goalTurn: true, status: "running" }).where(eq(tasks.id, failed));
    await persistRunGoal(failed, agentType, { ...handle, goalStarted: () => false, goal: () => null }, 1);
    assert.equal((await settleTaskStatus(failed, 1)).status, "done");
    assert.equal((await row(failed)).stage, "accepted");
    assert.equal(readCliState((await row(failed)).cliState, agentType).goal, null);
    assert.equal(hasCliGoalHold((await row(failed)).cliState), false);
    assert.equal(readCliState((await row(failed)).cliState, agentType).goalStart, undefined);

    const paused = `clear-${agentType}`;
    await create(paused, { agentType, status: "paused" });
    await saveCliState(paused, agentType, { profileId: null, ownerUserId: null, goalHold: true, goal: { objective: "旧目标", status: "paused" } });
    assert.equal(selectNextInQueue([await row(paused)]), null);
    const cleared = await prepareCliInvocation(await row(paused), agentType, "/goal clear", null, null);
    assert.equal(cleared.cliState.goal, null);
    assert.equal(cleared.cliState.goalHold, false);
    assert.equal(selectNextInQueue([await row(paused)])?.id, paused);
  }
  assert.equal(hasCliGoalHold('{"codex":{"goalHold":true,"goal":null}}'), false);
  await db.insert(agents).values({ id: "exec-only", name: "Codex exec-only fixture", type: "codex", extraArgs: '["--search"]' });
  await create("sync-goal-startup", { status: "done", executorId: "exec-only" });
  assert.equal(await continueTask("sync-goal-startup", "/goal 这个目标不得启动"), true);
  assert.equal((await row("sync-goal-startup")).status, "done");
  assert.equal((await row("sync-goal-startup")).goalTurn, false);
  assert.equal(readCliState((await row("sync-goal-startup")).cliState, "codex").goal, null);
  assert.equal(hasCliGoalHold((await row("sync-goal-startup")).cliState), false);
  await create("invited-goal", { goalTurn: true });
  await saveCliState("invited-goal", "codex", { goal: { objective: "原智能体目标", status: "paused" } });
  await saveCliState("invited-goal", "claude", { goal: { objective: "召唤的智能体目标", status: "active" } });
  await interruptCliGoal(await row("invited-goal"), "claude");
  assert.equal(readCliState((await row("invited-goal")).cliState, "codex").goal?.status, "paused");
  assert.equal(readCliState((await row("invited-goal")).cliState, "claude").goal?.status, "blocked");
  const context = claudeGoalInvocation({ cwd: root, prompt: "private interrupted direction", cliCommand: { name: "goal", args: "验证清理", text: "/goal 验证清理" } });
  await create("abandoned-goal", { goalTurn: true });
  await saveCliState("abandoned-goal", "claude", { goal: { objective: "验证清理", status: "active" } });
  await db.insert(sessions).values({ id: "abandoned-session", taskId: "abandoned-goal", role: "single", agentType: "claude", executor: "claude", cwd: root, commandLine: context.marker, startedAt: at, turnStartedAt: at });
  await create("abandoned-startup", { status: "done", stage: "accepted" });
  await prepareCliInvocation(await row("abandoned-startup"), "codex", "/goal 启动前中断", null, null);
  await db.update(tasks).set({ goalTurn: true, status: "running" }).where(eq(tasks.id, "abandoned-startup"));
  await reconcileInterrupted();
  assert.equal((await row("abandoned-startup")).status, "done");
  assert.equal((await row("abandoned-startup")).stage, "accepted");
  assert.equal((await row("abandoned-startup")).followUpFrom, null);
  assert.equal(hasCliGoalHold((await row("abandoned-startup")).cliState), false);
  assert.equal((await row("abandoned-goal")).status, "paused");
  assert.equal(readCliState((await row("abandoned-goal")).cliState, "claude").goal?.status, "blocked");
  assert.equal(existsSync(context.args[1]!), false);
  console.log("native HTTP bypass, resume preflight, startup rollback, cleared queue holds, settlement, scoped state: passed");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}

import { desc, eq, sql } from "drizzle-orm";
import type { AgentType, TaskStatus } from "@ash/shared";
import { cliStateScopeKey, goalRequest, hasCliGoalHold, isGoalExecution, readCliState, readCliStateScopes, validateCliCommand, type CliCommand, type CliSessionState } from "@ash/shared/cli-commands";
import { db } from "./db/index.js";
import { sessions, tasks } from "./db/schema.js";
import type { RunHandle } from "./executors/types.js";
import type { StopSettle } from "./runs.js";
import { publishTaskUpdated } from "./task-store.js";
import { now } from "./util.js";
import { cliGoalRoute, cliGoalScopeSelector, currentCliGoalProfile, selectCliGoalScope } from "./task-cli-goal-scopes.js";

export { readCliState };

export async function saveCliState(taskId: string, agentType: string, state: CliSessionState, activate = false): Promise<void> {
  const [task] = await db.select({ cliState: tasks.cliState }).from(tasks).where(eq(tasks.id, taskId));
  const slot = readCliStateScopes(task?.cliState, agentType);
  const path = `$.${JSON.stringify(agentType)}`;
  const key = cliStateScopeKey(state);
  const raw = sql`CASE WHEN json_valid(${tasks.cliState}) THEN ${tasks.cliState} ELSE '{}' END`;
  const stored = sql`CASE WHEN json_type(${raw}, ${`${path}.scopes`}) = 'object' THEN ${raw} ELSE json_set(${raw}, ${path}, json(${JSON.stringify(slot)})) END`;
  const active = activate ? sql`${key}` : sql`COALESCE(json_extract(${stored}, ${`${path}.activeScope`}), ${key})`;
  await db.update(tasks).set({ cliState: sql`json_set(${stored}, ${`${path}.activeScope`}, ${active}, ${`${path}.scopes.${JSON.stringify(key)}`}, json(${JSON.stringify(state)}))` }).where(eq(tasks.id, taskId));
}

export async function renameCliTask(taskId: string, title: string): Promise<void> {
  await db.update(tasks).set({ title, updatedAt: now() }).where(eq(tasks.id, taskId));
  await publishTaskUpdated(taskId);
}

function assertResumableGoal(command: CliCommand | null, state: CliSessionState): void {
  if (command?.name === "goal" && command.args === "resume" && !state.goal?.objective?.trim()) throw new Error("没有可恢复的目标，请先 /goal 描述");
}

export async function preflightCliGoalCommand(task: typeof tasks.$inferSelect, agentType: AgentType, text: string, executorId: string | null, ownerUserId: string | null) {
  const command = validateCliCommand(agentType, text);
  if (command?.name !== "goal" || !/^(resume|clear|stop|off|reset|none|cancel)$/.test(command.args)) return;
  const scope = await selectCliGoalScope(task, agentType, executorId, ownerUserId, command.goalScope, command.args !== "resume");
  if (!scope) { assertResumableGoal(command, {}); return; }
  const route = await cliGoalRoute(scope, ownerUserId);
  if (command.goalScope || scope.agentType !== agentType || (scope.state.profileId ?? null) !== await currentCliGoalProfile(agentType, executorId, ownerUserId)) return route;
}

export async function resolvedCliState(task: typeof tasks.$inferSelect, agentType: AgentType, executorId: string | null, ownerUserId: string | null): Promise<CliSessionState> {
  const profileId = await currentCliGoalProfile(agentType, executorId, ownerUserId);
  return readCliState(task.cliState, agentType, profileId, ownerUserId);
}

async function resetCliPlanModes(taskId: string): Promise<void> {
  const raw = sql`CASE WHEN json_valid(${tasks.cliState}) THEN ${tasks.cliState} ELSE '{}' END`;
  const scopes = sql`(SELECT json_group_object(key, json_object('plan', json('false'))) FROM json_each(${raw}, '$.codex.scopes') WHERE type = 'object')`;
  await db.update(tasks).set({ cliState: sql`CASE
    WHEN json_type(${raw}, '$.codex.scopes') = 'object'
      THEN json_patch(${raw}, json_object('codex', json_object('scopes', json(${scopes}))))
    WHEN json_type(${raw}, '$.codex') = 'object'
      THEN json_set(${raw}, '$.codex.plan', json('false'))
    ELSE ${tasks.cliState} END` }).where(eq(tasks.id, taskId));
}

export async function prepareCliInvocation(task: typeof tasks.$inferSelect, agentType: AgentType, text: string, profileId: string | null, ownerUserId: string | null, options: { resetPlan?: boolean; preserveState?: boolean; previousStatus?: TaskStatus } = {}) {
  const cliCommand = validateCliCommand(agentType, text);
  const previousState = readCliState(task.cliState, agentType, profileId, ownerUserId);
  const cliState = { ...previousState, profileId, ownerUserId };
  if (cliCommand?.name === "goal" && cliCommand.args === "--scopes") throw new Error("查看目标作用域请在任务对话框即时发送 /goal --scopes");
  if (cliCommand?.goalScope && cliCommand.goalScope !== cliGoalScopeSelector(agentType, cliState)) throw new Error("目标作用域与本次执行器不一致；使用 /goal --scopes 选择原作用域");
  assertResumableGoal(cliCommand, cliState);
  if (options.preserveState) return { cliCommand: cliCommand ?? undefined, cliState: { ...cliState, plan: false } };
  const resetPlanChanged = !!options.resetPlan && Object.values(readCliStateScopes(task.cliState, "codex").scopes).some((state) => state?.plan === true);
  if (options.resetPlan) { await resetCliPlanModes(task.id); cliState.plan = false; }
  if (isGoalExecution(cliCommand)) {
    delete cliState.goalClearStart;
    cliState.goalStart = { previousStatus: options.previousStatus ?? (hasCliGoalHold(task.cliState) && ["running", "queued"].includes(task.status) ? "paused" : task.status), previousGoal: cliState.goal ?? null, previousHold: cliState.goalHold ?? false, ...(cliState.goalSessionId ? { previousSessionId: cliState.goalSessionId } : {}) };
    if (cliCommand?.args !== "resume") delete cliState.goalSessionId;
  }
  if (!cliCommand || isGoalExecution(cliCommand)) cliState.goalHold = false;
  if (cliCommand?.name === "plan") cliState.plan = cliCommand.args !== "off";
  if (cliCommand?.name === "personality" && cliCommand.args) cliState.personality = cliCommand.args as CliSessionState["personality"];
  if (cliCommand?.name === "fast") cliState.serviceTier = (cliCommand.args ? cliCommand.args === "on" : cliState.serviceTier !== "priority") ? "priority" : "default";
  if (isGoalExecution(cliCommand)) {
    const request = goalRequest(cliCommand!, agentType);
    if (request.objective) cliState.goal = { ...request, objective: request.objective, status: "active", tokensUsed: 0, timeUsedSeconds: 0 };
    else if (cliState.goal) cliState.goal = { ...cliState.goal, status: "active" };
  }
  if (cliCommand?.name === "goal" && /^(clear|stop|off|reset|none|cancel)$/.test(cliCommand.args)) {
    if (cliState.goal) cliState.goalClearStart = { previousGoal: cliState.goal, previousHold: cliState.goalHold ?? false };
    cliState.goal = null; cliState.goalHold = false; delete cliState.goalStart;
  }
  if (cliCommand?.name === "goal" && cliCommand.args === "pause" && cliState.goal) cliState.goal.status = "paused";
  if (cliCommand?.name === "new" || cliCommand?.name === "clear" || cliCommand?.name === "fork") { cliState.goal = null; cliState.goalHold = false; delete cliState.goalStart; delete cliState.goalSessionId; delete cliState.goalClearStart; }
  if (cliCommand || task.cliState) {
    await saveCliState(task.id, agentType, cliState, true);
    if (resetPlanChanged || cliCommand?.name === "plan" || cliState.plan !== readCliState(task.cliState, agentType).plan) await publishTaskUpdated(task.id);
  }
  return { cliCommand: cliCommand?.goalScope ? { ...cliCommand, text: `/goal ${cliCommand.args}` } : cliCommand ?? undefined, cliState };
}

async function settleCliGoalClear(taskId: string, agentType: string, state: CliSessionState, succeeded: boolean): Promise<void> {
  const start = state.goalClearStart;
  if (!start) return;
  if (!succeeded) { state.goal = start.previousGoal; state.goalHold = start.previousHold; }
  else delete state.goalSessionId;
  delete state.goalClearStart;
  await saveCliState(taskId, agentType, state);
}

async function restoreCliGoalStart(task: typeof tasks.$inferSelect, agentType: AgentType, state: CliSessionState): Promise<void> {
  const start = state.goalStart;
  if (start) { state.goal = start.previousGoal; state.goalHold = !!start.previousGoal && start.previousHold; if (start.previousSessionId) state.goalSessionId = start.previousSessionId; else delete state.goalSessionId; }
  else state.goalHold = !!state.goal && !!state.goalHold;
  delete state.goalStart;
  await saveCliState(task.id, agentType, state);
  await db.update(tasks).set({ goalTurn: false, ...(start && !["running", "queued"].includes(start.previousStatus) ? { followUpFrom: start.previousStatus } : {}) }).where(eq(tasks.id, task.id));
}

export async function markCliGoalStarted(taskId: string, agentType: AgentType, cliSessionId?: string): Promise<void> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task?.goalTurn) return;
  const state = readCliState(task.cliState, agentType);
  if (!state.goalStart) return;
  if (cliSessionId) state.goalSessionId = cliSessionId;
  delete state.goalStart;
  await saveCliState(taskId, agentType, state);
}

export async function persistRunGoal(taskId: string, agentType: AgentType, handle: RunHandle, exitStatus: number, stopped?: StopSettle | null): Promise<void> {
  if (exitStatus === 0 && handle.cliCommand?.name === "rename") await renameCliTask(taskId, handle.cliCommand.args);
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (task && !task.goalTurn) {
    const state = readCliState(task.cliState, agentType);
    await settleCliGoalClear(taskId, agentType, state, exitStatus === 0 && !stopped);
    const goal = handle.goal?.();
    if (exitStatus === 0 && !stopped && handle.cliCommand?.name === "goal" && state.goal && goal?.objective === state.goal.objective) await saveCliState(taskId, agentType, { ...state, goal });
  }
  if (!task?.goalTurn) return;
  const state = readCliState(task.cliState, agentType);
  const goal = handle.goal ? handle.goal() : state.goal;
  if (!(handle.goalStarted?.() ?? !!goal) && !task.completeConfirmedAt) { await restoreCliGoalStart(task, agentType, state); return; }
  delete state.goalStart;
  if (!state.goalSessionId) {
    const recorded = await db.select().from(sessions).where(eq(sessions.taskId, taskId)).orderBy(desc(sessions.turnStartedAt), desc(sessions.startedAt));
    const session = recorded.find((entry) => entry.role === "single" && entry.agentType === agentType && entry.executorId === (state.profileId ?? null) && entry.runOwnerUserId === (state.ownerUserId ?? null));
    if (session?.cliSessionId) state.goalSessionId = session.cliSessionId;
  }
  state.goalHold = !!goal && (!!stopped || exitStatus !== 0 || !task.completeConfirmedAt);
  if (!goal) { delete state.goalSessionId; await saveCliState(taskId, agentType, { ...state, goal: null }); return; }
  const status = stopped ? "paused" : handle.goal ? (exitStatus !== 0 && goal.status === "active" ? "blocked" : goal.status)
    : task.completeConfirmedAt && exitStatus === 0 ? "complete" : "paused";
  await saveCliState(taskId, agentType, { ...state, goal: { ...goal, status } });
}

export async function interruptCliGoal(task: typeof tasks.$inferSelect, agentType = task.agentType ?? "claude", started?: boolean): Promise<boolean> {
  const state = readCliState(task.cliState, agentType);
  await settleCliGoalClear(task.id, agentType, state, false);
  if (!task.goalTurn) return false;
  if (!(started ?? !state.goalStart) || !state.goal) { await restoreCliGoalStart(task, agentType as AgentType, state); return false; }
  delete state.goalStart;
  await saveCliState(task.id, agentType, { ...state, goalHold: true, goal: { ...state.goal, status: "blocked" } });
  await db.update(tasks).set({ goalTurn: false }).where(eq(tasks.id, task.id));
  return true;
}

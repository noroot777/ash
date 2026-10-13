import { eq, sql } from "drizzle-orm";
import type { AgentType } from "@ash/shared";
import { cliStateScopeKey, goalRequest, isGoalExecution, readCliState, readCliStateScopes, validateCliCommand, type CliCommand, type CliSessionState } from "@ash/shared/cli-commands";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import type { RunHandle } from "./executors/types.js";
import type { StopSettle } from "./runs.js";
import { publishTaskUpdated } from "./task-store.js";
import { now } from "./util.js";

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

export async function preflightCliGoalResume(task: typeof tasks.$inferSelect, agentType: AgentType, text: string, executorId: string | null, ownerUserId: string | null): Promise<void> {
  const command = validateCliCommand(agentType, text);
  if (command?.name !== "goal" || command.args !== "resume") return;
  assertResumableGoal(command, await resolvedCliState(task, agentType, executorId, ownerUserId));
}

export async function resolvedCliState(task: typeof tasks.$inferSelect, agentType: AgentType, executorId: string | null, ownerUserId: string | null): Promise<CliSessionState> {
  const { executorOwnerScope } = await import("./auth/dispatch-gate.js");
  const { resolveExecutorWithProfile } = await import("./executors/index.js");
  const { profileId } = await resolveExecutorWithProfile({ type: agentType, executorId, ...await executorOwnerScope(ownerUserId) });
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

export async function prepareCliInvocation(task: typeof tasks.$inferSelect, agentType: AgentType, text: string, profileId: string | null, ownerUserId: string | null, options: { resetPlan?: boolean; preserveState?: boolean } = {}) {
  const cliCommand = validateCliCommand(agentType, text);
  const previousState = readCliState(task.cliState, agentType, profileId, ownerUserId);
  const cliState = { ...previousState, profileId, ownerUserId };
  assertResumableGoal(cliCommand, cliState);
  if (options.preserveState) return { cliCommand: cliCommand ?? undefined, cliState: { ...cliState, plan: false } };
  const resetPlanChanged = !!options.resetPlan && Object.values(readCliStateScopes(task.cliState, "codex").scopes).some((state) => state?.plan === true);
  if (options.resetPlan) { await resetCliPlanModes(task.id); cliState.plan = false; }
  if (isGoalExecution(cliCommand)) cliState.goalStart = { previousStatus: task.status, previousGoal: cliState.goal ?? null, previousHold: cliState.goalHold ?? false };
  if (!cliCommand || isGoalExecution(cliCommand)) cliState.goalHold = false;
  if (cliCommand?.name === "plan") cliState.plan = cliCommand.args !== "off";
  if (cliCommand?.name === "personality" && cliCommand.args) cliState.personality = cliCommand.args as CliSessionState["personality"];
  if (cliCommand?.name === "fast") cliState.serviceTier = (cliCommand.args ? cliCommand.args === "on" : cliState.serviceTier !== "priority") ? "priority" : "default";
  if (isGoalExecution(cliCommand)) {
    const request = goalRequest(cliCommand!, agentType);
    if (request.objective) cliState.goal = { ...request, objective: request.objective, status: "active", tokensUsed: 0, timeUsedSeconds: 0 };
    else if (cliState.goal) cliState.goal = { ...cliState.goal, status: "active" };
  }
  if (cliCommand?.name === "goal" && /^(clear|stop|off|reset|none|cancel)$/.test(cliCommand.args)) { cliState.goal = null; cliState.goalHold = false; delete cliState.goalStart; }
  if (cliCommand?.name === "goal" && cliCommand.args === "pause" && cliState.goal) cliState.goal.status = "paused";
  if (cliCommand?.name === "new" || cliCommand?.name === "clear" || cliCommand?.name === "fork") { cliState.goal = null; cliState.goalHold = false; delete cliState.goalStart; }
  if (cliCommand || task.cliState) {
    await saveCliState(task.id, agentType, cliState, true);
    if (resetPlanChanged || cliCommand?.name === "plan" || cliState.plan !== readCliState(task.cliState, agentType).plan) await publishTaskUpdated(task.id);
  }
  return { cliCommand: cliCommand ?? undefined, cliState };
}

async function restoreCliGoalStart(task: typeof tasks.$inferSelect, agentType: AgentType, state: CliSessionState): Promise<void> {
  const start = state.goalStart;
  if (start) { state.goal = start.previousGoal; state.goalHold = !!start.previousGoal && start.previousHold; }
  else state.goalHold = !!state.goal && !!state.goalHold;
  delete state.goalStart;
  await saveCliState(task.id, agentType, state);
  await db.update(tasks).set({ goalTurn: false, ...(start && !["running", "queued"].includes(start.previousStatus) ? { followUpFrom: start.previousStatus } : {}) }).where(eq(tasks.id, task.id));
}

export async function markCliGoalStarted(taskId: string, agentType: AgentType): Promise<void> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task?.goalTurn) return;
  const state = readCliState(task.cliState, agentType);
  if (!state.goalStart) return;
  delete state.goalStart;
  await saveCliState(taskId, agentType, state);
}

export async function persistRunGoal(taskId: string, agentType: AgentType, handle: RunHandle, exitStatus: number, stopped?: StopSettle | null): Promise<void> {
  if (exitStatus === 0 && handle.cliCommand?.name === "rename") await renameCliTask(taskId, handle.cliCommand.args);
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task?.goalTurn) return;
  const state = readCliState(task.cliState, agentType);
  const goal = handle.goal ? handle.goal() : state.goal;
  if (!(handle.goalStarted?.() ?? !!goal) && !task.completeConfirmedAt) { await restoreCliGoalStart(task, agentType, state); return; }
  delete state.goalStart;
  state.goalHold = !!goal && (!!stopped || exitStatus !== 0 || !task.completeConfirmedAt);
  if (!goal) { await saveCliState(taskId, agentType, { ...state, goal: null }); return; }
  const status = stopped ? "paused" : handle.goal ? (exitStatus !== 0 && goal.status === "active" ? "blocked" : goal.status)
    : task.completeConfirmedAt && exitStatus === 0 ? "complete" : "paused";
  await saveCliState(taskId, agentType, { ...state, goal: { ...goal, status } });
}

export async function interruptCliGoal(task: typeof tasks.$inferSelect, agentType = task.agentType ?? "claude", started?: boolean): Promise<boolean> {
  if (!task.goalTurn) return false;
  const state = readCliState(task.cliState, agentType);
  if (!(started ?? !state.goalStart) || !state.goal) { await restoreCliGoalStart(task, agentType as AgentType, state); return false; }
  delete state.goalStart;
  await saveCliState(task.id, agentType, { ...state, goalHold: true, goal: { ...state.goal, status: "blocked" } });
  await db.update(tasks).set({ goalTurn: false }).where(eq(tasks.id, task.id));
  return true;
}

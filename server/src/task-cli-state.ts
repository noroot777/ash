import { eq, sql } from "drizzle-orm";
import type { AgentType } from "@ash/shared";
import { goalRequest, isGoalExecution, validateCliCommand, type CliCommand, type CliSessionState } from "@ash/shared/cli-commands";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import type { RunHandle } from "./executors/types.js";
import type { StopSettle } from "./runs.js";
import { publishTaskUpdated } from "./task-store.js";
import { now } from "./util.js";

export function readCliState(raw: string | null | undefined, agentType: string, profileId?: string | null, ownerUserId?: string | null): CliSessionState {
  try {
    const state = JSON.parse(raw ?? "{}")[agentType] as CliSessionState | undefined;
    if (!state || (profileId !== undefined && state.profileId !== profileId) || (ownerUserId !== undefined && state.ownerUserId !== ownerUserId)) return {};
    return state;
  } catch { return {}; }
}

export async function saveCliState(taskId: string, agentType: string, state: CliSessionState): Promise<void> {
  await db.update(tasks).set({ cliState: sql`json_set(COALESCE(${tasks.cliState}, '{}'), ${`$.${agentType}`}, json(${JSON.stringify(state)}))` }).where(eq(tasks.id, taskId));
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
  const { executorOwnerScope } = await import("./auth/dispatch-gate.js");
  const { resolveExecutorWithProfile } = await import("./executors/index.js");
  const { profileId } = await resolveExecutorWithProfile({ type: agentType, executorId, ...await executorOwnerScope(ownerUserId) });
  assertResumableGoal(command, readCliState(task.cliState, agentType, profileId, ownerUserId));
}

export async function prepareCliInvocation(task: typeof tasks.$inferSelect, agentType: AgentType, text: string, profileId: string | null, ownerUserId: string | null) {
  const cliCommand = validateCliCommand(agentType, text);
  const cliState = { ...readCliState(task.cliState, agentType, profileId, ownerUserId), profileId, ownerUserId };
  assertResumableGoal(cliCommand, cliState);
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
  if (cliCommand || task.cliState) await saveCliState(task.id, agentType, cliState);
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

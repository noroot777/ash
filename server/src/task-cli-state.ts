import { eq, sql } from "drizzle-orm";
import type { AgentType } from "@ash/shared";
import { goalRequest, isGoalExecution, validateCliCommand, type CliSessionState } from "@ash/shared/cli-commands";
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

export async function prepareCliInvocation(task: typeof tasks.$inferSelect, agentType: AgentType, text: string, profileId: string | null, ownerUserId: string | null) {
  const cliCommand = validateCliCommand(agentType, text);
  const cliState = { ...readCliState(task.cliState, agentType, profileId, ownerUserId), profileId, ownerUserId };
  if (!cliCommand || isGoalExecution(cliCommand)) cliState.goalHold = false;
  if (cliCommand?.name === "plan") cliState.plan = cliCommand.args !== "off";
  if (cliCommand?.name === "personality" && cliCommand.args) cliState.personality = cliCommand.args as CliSessionState["personality"];
  if (cliCommand?.name === "fast") cliState.serviceTier = (cliCommand.args ? cliCommand.args === "on" : cliState.serviceTier !== "priority") ? "priority" : "default";
  if (isGoalExecution(cliCommand)) {
    const request = goalRequest(cliCommand!, agentType);
    if (request.objective) cliState.goal = { ...request, objective: request.objective, status: "active", tokensUsed: 0, timeUsedSeconds: 0 };
    else if (cliState.goal) cliState.goal = { ...cliState.goal, status: "active" };
    else if (agentType === "claude") throw new Error("没有可恢复的 Claude 目标，请先 /goal 描述");
  }
  if (cliCommand?.name === "goal" && /^(clear|stop|off|reset|none|cancel)$/.test(cliCommand.args)) cliState.goal = null;
  if (cliCommand?.name === "goal" && cliCommand.args === "pause" && cliState.goal) cliState.goal.status = "paused";
  if (cliCommand?.name === "new" || cliCommand?.name === "clear" || cliCommand?.name === "fork") cliState.goal = null;
  if (cliCommand || task.cliState) await saveCliState(task.id, agentType, cliState);
  return { cliCommand: cliCommand ?? undefined, cliState };
}

export async function persistRunGoal(taskId: string, agentType: AgentType, handle: RunHandle, exitStatus: number, stopped?: StopSettle | null): Promise<void> {
  if (exitStatus === 0 && handle.cliCommand?.name === "rename") await renameCliTask(taskId, handle.cliCommand.args);
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task?.goalTurn) return;
  const state = readCliState(task.cliState, agentType);
  const goal = handle.goal ? handle.goal() : state.goal;
  state.goalHold = !!stopped || exitStatus !== 0 || !task.completeConfirmedAt;
  if (!goal) { await saveCliState(taskId, agentType, state); return; }
  const status = stopped ? "paused" : handle.goal ? (exitStatus !== 0 && goal.status === "active" ? "blocked" : goal.status)
    : task.completeConfirmedAt && exitStatus === 0 ? "complete" : "paused";
  await saveCliState(taskId, agentType, { ...state, goal: { ...goal, status } });
}

export async function interruptCliGoal(task: typeof tasks.$inferSelect, agentType = task.agentType ?? "claude"): Promise<void> {
  if (!task.goalTurn) return;
  const state = readCliState(task.cliState, agentType);
  await saveCliState(task.id, agentType, { ...state, goalHold: true, ...(state.goal ? { goal: { ...state.goal, status: "blocked" } } : {}) });
  await db.update(tasks).set({ goalTurn: false }).where(eq(tasks.id, task.id));
}

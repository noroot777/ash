import { eq } from "drizzle-orm";
import type { AgentType } from "@ash/shared";
import { cliStateScopeKey, isGoalExecution, readCliState, readCliStateScopes, type CliCommand, type CliSessionState } from "@ash/shared/cli-commands";
import { db } from "./db/index.js";
import { agents, sessions, tasks } from "./db/schema.js";
import { executorOwnerScope } from "./auth/dispatch-gate.js";
import { resolveExecutorProfileId } from "./executors/index.js";
import { formatGoal } from "./executors/codex-native-commands.js";

type TaskRow = typeof tasks.$inferSelect;
export interface CliGoalScope {
  agentType: "codex" | "claude";
  selector: string;
  state: CliSessionState;
}
export type CliGoalRoute = { agent: AgentType; executorId: string | null; model: null; reasoningEffort: null };

export function cliGoalScopeSelector(agentType: string, state: CliSessionState): string {
  return `${agentType}:${cliStateScopeKey(state)}`;
}

function storedCliGoalScopes(task: TaskRow): CliGoalScope[] {
  return (["codex", "claude"] as const).flatMap((agentType) => Object.values(readCliStateScopes(task.cliState, agentType).scopes)
    .filter((state) => state && typeof state === "object")
    .map((state) => ({ agentType, state, selector: cliGoalScopeSelector(agentType, state) })));
}

export function cliGoalScopes(task: TaskRow): CliGoalScope[] {
  return storedCliGoalScopes(task).filter((scope) => typeof scope.state.goal?.objective === "string" && scope.state.goal.objective.trim());
}

export async function cliGoalScopeLabel(scope: CliGoalScope): Promise<string> {
  const profileId = scope.state.profileId;
  const profile = profileId ? (await db.select({ name: agents.name, type: agents.type }).from(agents).where(eq(agents.id, profileId)))[0] : null;
  const name = profile?.type === scope.agentType ? profile.name : profileId ? `已删除或变更的执行器 ${profileId}` : `${scope.agentType} 内置执行器`;
  return `${name}（${scope.agentType}；发起人：${scope.state.ownerUserId ?? "自用模式"}）`;
}

export async function formatCliGoalScopes(task: TaskRow, ownerUserId: string | null): Promise<string> {
  const scopes = cliGoalScopes(task);
  if (!scopes.length) return "没有已保存的目标。使用 /goal 描述 设置持续目标。";
  const lines = ["已保存的目标作用域（ash 快照，不启动模型）："];
  for (const scope of scopes) {
    lines.push(`\n${await cliGoalScopeLabel(scope)}${scope.state.goalHold ? "；持有任务暂停标记" : ""}`);
    if ((scope.state.ownerUserId ?? null) !== ownerUserId) {
      lines.push("其他发起人的目标；仅原发起人可以恢复或清除，目标内容未展示。");
      continue;
    }
    lines.push(formatGoal(scope.state.goal ?? null), `恢复：/goal resume --scope ${scope.selector}`, `清除：/goal clear --scope ${scope.selector}`);
  }
  return lines.join("\n");
}

export async function currentCliGoalProfile(agentType: AgentType, executorId: string | null, ownerUserId: string | null): Promise<string | null> {
  return resolveExecutorProfileId({ type: agentType, executorId, ...await executorOwnerScope(ownerUserId) });
}

export async function selectCliGoalScope(task: TaskRow, agentType: AgentType, executorId: string | null, ownerUserId: string | null, selector?: string, allowCleared = false): Promise<CliGoalScope | null> {
  const scopes = cliGoalScopes(task);
  if (selector) {
    const selected = (allowCleared ? storedCliGoalScopes(task) : scopes).find((scope) => scope.selector === selector);
    if (!selected) throw new Error(`目标作用域不存在或已清除；使用 /goal --scopes 查看当前目标。\n${await formatCliGoalScopes(task, ownerUserId)}`);
    if ((selected.state.ownerUserId ?? null) !== ownerUserId) throw new Error(`只有目标原发起人可以恢复或清除 ${await cliGoalScopeLabel(selected)}；你的操作未改变该目标或暂停标记。`);
    return selected;
  }
  const profileId = await currentCliGoalProfile(agentType, executorId, ownerUserId);
  const current = readCliState(task.cliState, agentType, profileId, ownerUserId);
  const exact = scopes.find((scope) => scope.agentType === agentType && scope.selector === cliGoalScopeSelector(agentType, current)
    && (scope.state.profileId ?? null) === profileId && (scope.state.ownerUserId ?? null) === ownerUserId);
  if (exact) return exact;
  const owned = scopes.filter((scope) => (scope.state.ownerUserId ?? null) === ownerUserId);
  if (owned.length === 1) return owned[0]!;
  if (owned.length > 1) throw new Error(`当前执行器没有目标，但你持有多个目标；请用 --scope 明确选择，不自动覆盖或解除其他作用域。\n${await formatCliGoalScopes(task, ownerUserId)}`);
  if (scopes.length) throw new Error(`没有你可恢复或清除的目标；已有目标及其暂停标记由其他发起人持有。\n${await formatCliGoalScopes(task, ownerUserId)}`);
  return null;
}

export async function runnableCliGoalScope(scope: CliGoalScope, ownerUserId: string | null): Promise<boolean> {
  const profileId = scope.state.profileId ?? null;
  if (profileId) {
    const [profile] = await db.select({ type: agents.type }).from(agents).where(eq(agents.id, profileId));
    if (profile?.type !== scope.agentType) return false;
  }
  return await currentCliGoalProfile(scope.agentType, profileId, ownerUserId) === profileId;
}

export async function cliGoalRoute(scope: CliGoalScope, ownerUserId: string | null): Promise<CliGoalRoute> {
  if (!await runnableCliGoalScope(scope, ownerUserId)) throw new Error(`目标仍保存在 ${await cliGoalScopeLabel(scope)}，但原执行器已不可用；不自动迁移目标、预算或已用量。可直接清除该作用域并解锁：/goal clear --scope ${scope.selector}`);
  return { agent: scope.agentType, executorId: scope.state.profileId ?? null, model: null, reasoningEffort: null };
}

export function cliGoalSessionCandidates(task: TaskRow, agentType: AgentType, profileId: string | null, ownerUserId: string | null, command: CliCommand | null, candidates: (typeof sessions.$inferSelect)[]) {
  const exact = candidates.filter((session) => session.executorId === profileId || !session.executorId);
  if (command?.name !== "goal" || (isGoalExecution(command) && command.args !== "resume")) return exact;
  const ordered = [...exact.filter((session) => session.cliSessionId), ...exact.filter((session) => !session.cliSessionId)];
  const state = readCliState(task.cliState, agentType, profileId, ownerUserId);
  if (state.goalSessionId) return candidates.filter((session) => session.cliSessionId === state.goalSessionId);
  const owned = cliGoalScopes(task).filter((scope) => scope.agentType === agentType && (scope.state.ownerUserId ?? null) === ownerUserId);
  if (ordered.some((session) => session.cliSessionId) || !state.goal || owned.length !== 1) return ordered;
  return [...candidates.filter((session) => session.cliSessionId), ...ordered.filter((session) => !session.cliSessionId)];
}

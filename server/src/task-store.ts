import { eq, inArray } from "drizzle-orm";
import { normalizeDuetConfig } from "@harness/shared/duet";
import type { AgentType, QuestionItem, Task, TaskStage, TaskStatus } from "@harness/shared";
import { db } from "./db/index.js";
import { agents, projects, queueItems, sessions, tasks } from "./db/schema.js";
import { bus } from "./bus.js";
import { runsTiming } from "./util.js";
import { getAppSettings } from "./app-settings.js";
import { projectHealthLight } from "./git.js";
import { resolveWorkflowDef } from "./workflows.js";

export type TaskRow = typeof tasks.$inferSelect;
// workflowId 不是列：它是**创建那一刻**用来挑起手式的 id，落库时会被换成 tasks.workflow
// 里的那份快照（见 createTasks）。调用方给 id，库里存线本身。
export type NewTaskRow = typeof tasks.$inferInsert & { id: string; workflowId?: string | null };

type AgentLabelRow = { id: string; name: string; type: string; isDefault: boolean };

const executorLabelFor = (
  profiles: AgentLabelRow[],
  executorId?: string | null,
  type?: AgentType | null,
): string | null => {
  const selected = executorId ? profiles.find((a) => a.id === executorId) : null;
  if (selected) return selected.name;
  const fallbackType = type ?? "claude";
  const sameType = profiles.filter((a) => a.type === fallbackType);
  return (sameType.find((a) => a.isDefault) ?? sameType[0])?.name ?? null;
};

const enrichTeamExecutorLabels = (
  team: Task["team"],
  profiles: AgentLabelRow[],
): Task["team"] => {
  if (!team) return undefined;
  return {
    ...team,
    leadExecutorLabel: executorLabelFor(profiles, team.leadExecutorId, team.lead),
    workerExecutorLabel: executorLabelFor(profiles, team.workerExecutorId, team.worker),
    reviewerExecutorLabel: executorLabelFor(
      profiles,
      team.reviewerExecutorId,
      team.reviewerAgentType ?? team.worker,
    ),
  };
};

const toTask = (r: TaskRow, profiles: AgentLabelRow[] = []): Task => ({
  id: r.id,
  projectId: r.projectId,
  groupId: r.groupId,
  parentId: r.parentId,
  title: r.title,
  body: r.body,
  mode: r.mode as Task["mode"],
  status: r.status as TaskStatus,
  stage: (r.stage as TaskStage | null) ?? null,
  pinnedAt: r.pinnedAt ?? null,
  starredAt: r.starredAt ?? null,
  reviewOf: r.reviewOf ?? null,
  reviewRound: r.reviewRound ?? null,
  reviewRequested: r.reviewRequested,
  labels: JSON.parse(r.labels),
  dependsOn: JSON.parse(r.dependsOn),
  resumeDependsOn: JSON.parse(r.resumeDependsOn),
  agentType: (r.agentType as Task["agentType"]) ?? undefined,
  executorId: r.executorId ?? null,
  model: r.model ?? null,
  reasoningEffort: r.reasoningEffort ?? null,
  executorLabel: executorLabelFor(profiles, r.executorId, (r.agentType as AgentType) ?? null),
  autoTitle: r.autoTitle,
  // 读出口归一:老库 JSON 可能还是改名前的 debaterA… 形状,前端永远只见 voiceA…。
  duet: r.duet ? normalizeDuetConfig(JSON.parse(r.duet)) : undefined,
  team: r.team ? enrichTeamExecutorLabels(JSON.parse(r.team), profiles) : undefined,
  reportBack: r.reportBack,
  scheduleId: r.scheduleId,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  startedAt: r.startedAt,
  endedAt: r.endedAt,
  archived: r.archived,
  archivedAt: r.archivedAt,
  useWorktree: r.useWorktree,
  worktreeBase: r.worktreeBase,
  acceptedTargetBranch: r.acceptedTargetBranch ?? null,
  acceptedBaseCommit: r.acceptedBaseCommit ?? null,
  acceptedMergeCommit: r.acceptedMergeCommit ?? null,
  workflow: r.workflow ? JSON.parse(r.workflow) : null,
  workflowMode: r.workflowMode as Task["workflowMode"],
  workflowAt: r.workflowAt ?? null,
  originTaskId: r.originTaskId ?? null,
  resumePrompt: r.resumePrompt ?? null,
  verifyRound: r.verifyRound ?? null,
  question: r.question ?? null,
  questionOptions: r.questionOptions ? (JSON.parse(r.questionOptions) as string[]) : null,
  questionItems: r.questionItems ? (JSON.parse(r.questionItems) as QuestionItem[]) : null,
});

// GET /tasks、task.created 和 task.updated 共用这一条序列化路径，保证派生的
// executorLabel、执行时长以及 queueId/queuePosition 不会在事件里缺字段。
export async function enrichTasks(rows: TaskRow[]): Promise<Task[]> {
  if (rows.length === 0) return [];
  const profiles = await db
    .select({ id: agents.id, name: agents.name, type: agents.type, isDefault: agents.isDefault })
    .from(agents);
  const runs = await db
    .select({
      taskId: sessions.taskId,
      activeMs: sessions.activeMs,
      turnStartedAt: sessions.turnStartedAt,
      endedAt: sessions.endedAt,
    })
    .from(sessions)
    .where(inArray(sessions.taskId, rows.map((r) => r.id)));
  const byTask = new Map<string, typeof runs>();
  for (const s of runs) {
    const arr = byTask.get(s.taskId) ?? [];
    arr.push(s);
    byTask.set(s.taskId, arr);
  }
  const items = await db
    .select()
    .from(queueItems)
    .where(inArray(queueItems.taskId, rows.map((r) => r.id)));
  const byQueueTask = new Map(items.map((q) => [q.taskId, q] as const));
  return rows.map((r) => {
    const q = byQueueTask.get(r.id);
    return {
      ...toTask(r, profiles),
      ...runsTiming(byTask.get(r.id) ?? []),
      queueId: q?.queueId ?? null,
      queuePosition: q?.position ?? null,
    };
  });
}

// 任务创建时把那条线**拷一份**进 tasks.workflow。起手式是「起手式」不是「模板引用」：
// 之后改库、停用、恢复默认，都不会追着改已经开工的任务 —— 用户改库时要能放心改，不必
// 先想一遍「这会不会把正在跑的 40 个任务也改了」。
//
// workspace 这一栏刻意**跟着 useWorktree 走，而不是反过来**：这一期只落数据、不接管
// 执行链。让起手式来决定「要不要开 worktree」得等前端真能选起手式的那一期，否则用户在
// 全局设置里关掉的 worktree，会被一条他还看不见的线悄悄打开。
async function snapshotWorkflow(
  workflowId: string | null | undefined,
  projectId: string,
  useWorktree: boolean,
): Promise<string> {
  const { def } = await resolveWorkflowDef({ explicitId: workflowId, projectId });
  return JSON.stringify({ ...def, workspace: useWorktree ? "isolated" : "shared" });
}

// All task creation paths go through here. afterInsert lets callers persist
// queue membership before serialization/broadcast, so the event matches GET /tasks.
export async function createTasks(
  rows: NewTaskRow[],
  afterInsert?: () => Promise<void>,
): Promise<Task[]> {
  if (rows.length === 0) return [];
  // Creation defaults belong here so every ordinary path (HTTP single, batch /
  // chain, duet handoff, future clients) gets the same behavior. Explicit
  // true/false wins, but a non-repo project can never materialize a worktree.
  const defaultUseWorktree = rows.some((row) => row.useWorktree === undefined)
    ? (await getAppSettings()).worktreeDefault
    : false;
  const projectIds = [...new Set(rows.map((row) => row.projectId))];
  const projectRows = await db
    .select({ id: projects.id, repoPath: projects.repoPath })
    .from(projects)
    .where(inArray(projects.id, projectIds));
  const repoByProject = new Map(projectRows.map((project) => [project.id, project.repoPath] as const));
  const normalizedRows = await Promise.all(rows.map(async (row): Promise<typeof tasks.$inferInsert & { id: string }> => {
    const requested = row.useWorktree ?? defaultUseWorktree;
    const useWorktree = requested && projectHealthLight(repoByProject.get(row.projectId)).isRepo;
    const { workflowId, ...rest } = row;
    return {
      ...rest,
      useWorktree,
      worktreeBase: useWorktree ? row.worktreeBase ?? null : null,
      // 审查任务（reviewOf 非空）不拷线：它本身就是别人那条线上「验证」那一站长出来的
      // 产物，再给它配一条自己的线就成了「审查任务的审查任务」。
      workflow: row.workflowMode === "free"
        ? null
        : row.workflow ?? (row.reviewOf
          ? null
          : await snapshotWorkflow(workflowId, row.projectId, useWorktree)),
    };
  }));
  await db.insert(tasks).values(normalizedRows);
  await afterInsert?.();
  const persisted = await db
    .select()
    .from(tasks)
    .where(inArray(tasks.id, normalizedRows.map((r) => r.id)));
  const byId = new Map(persisted.map((r) => [r.id, r] as const));
  const ordered = normalizedRows.flatMap((r) => {
    const persistedRow = byId.get(r.id);
    return persistedRow ? [persistedRow] : [];
  });
  const created = await enrichTasks(ordered);
  for (const task of created) bus.publish({ type: "task.created", task });
  return created;
}

export async function publishTaskUpdated(taskId: string): Promise<Task | null> {
  const row = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!row) return null;
  const task = (await enrichTasks([row]))[0]!;
  bus.publish({ type: "task.updated", task });
  return task;
}

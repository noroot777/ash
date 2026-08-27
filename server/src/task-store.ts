import { eq, inArray } from "drizzle-orm";
import { normalizeDuetConfig } from "@ash/shared/duet";
import type { AgentType, QuestionItem, Task, TaskListItem, TaskStage, TaskStatus } from "@ash/shared";
import { db } from "./db/index.js";
import { agents, projects, queueItems, sessions, tasks } from "./db/schema.js";
import { bus } from "./bus.js";
import { runsTiming } from "./util.js";
import { projectHealthLight } from "./git.js";
import { resolveWorkflowDef } from "./workflows.js";
import { isMultiUser } from "./auth/mode.js";
import { settingsFor } from "./auth/personal-settings.js";
import { profilesOwnedBy, type ExecutorProfileRow } from "./auth/owned-executors.js";

export type TaskRow = typeof tasks.$inferSelect;
// workflowId 不是列：它是**创建那一刻**用来挑起手式的 id，落库时会被换成 tasks.workflow
// 里的那份快照（见 createTasks）。调用方给 id，库里存线本身。
export type NewTaskRow = typeof tasks.$inferInsert & { id: string; workflowId?: string | null };

type AgentLabelRow = ExecutorProfileRow;

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

// executorLabel 一律在**这条任务归属人**自己的执行器里解析(为什么锚在归属人而不是
// 看客,见 auth/owned-executors.ts `profilesOwnedBy`;这份结果还会经 SSE 广播,那里根本
// 没有看客身份可用)。少了这道筛子,`executorId:null` 的默认回退会把别人的默认执行器名
// 写进响应 —— 第 2 轮审查 P1 的额外发现。
const toTask = (r: TaskRow, allProfiles: AgentLabelRow[] = []): Task =>
  toTaskWith(r, profilesOwnedBy(allProfiles, r.ownerUserId));

const toTaskWith = (r: TaskRow, profiles: AgentLabelRow[]): Task => ({
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
  handoff: r.handoff ? JSON.parse(r.handoff) : null,
  handoffAudit: r.handoffAudit ? JSON.parse(r.handoffAudit) : null,
});

// GET /tasks、task.created 和 task.updated 共用这一条序列化路径，保证派生的
// executorLabel、执行时长以及 queueId/queuePosition 不会在事件里缺字段。
export async function enrichTasks(rows: TaskRow[]): Promise<Task[]> {
  if (rows.length === 0) return [];
  const profiles = await db
    .select({
      id: agents.id,
      name: agents.name,
      type: agents.type,
      isDefault: agents.isDefault,
      ownerUserId: agents.ownerUserId,
    })
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

/**
 * 列表序列化：丢掉正文。
 *
 * 只有 `GET /tasks` 用它。`GET /tasks/:id` 和 SSE 的 task.created/updated 仍发整份
 * `Task`——前者就是详情面取正文的地方，后者要能就地更新已经打开的任务。
 */
export function toTaskListItem({ body: _body, ...rest }: Task): TaskListItem {
  return rest;
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
  owner: string | null,
): Promise<string> {
  const { def } = await resolveWorkflowDef({ explicitId: workflowId, projectId, owner });
  return JSON.stringify({ ...def, workspace: useWorktree ? "isolated" : "shared" });
}

/**
 * 执行器快照(§八):任务落库时记下「当时选的是谁、什么类型、什么型号」。
 * 照 workflow 快照的先例 —— 执行器是可编辑可删除的私有资源,主键说不清它当时长什么样。
 * 别人重跑这个任务时,前端拿这份快照说「原执行器属于 A 的 xxx」。
 */
async function snapshotExecutor(row: NewTaskRow): Promise<string | null> {
  if (!(await isMultiUser())) return null;
  const type = row.agentType ?? null;
  const typeOnly = () => (type ? JSON.stringify({ type, name: null, model: row.model ?? null }) : null);
  if (!row.executorId) return typeOnly();
  const profile = (await db.select().from(agents).where(eq(agents.id, row.executorId))).at(0);
  if (!profile) return null;
  // 最后一道:这份快照会原样回显给前端(名字 + 归属人),所以**不给别人的 profile 拍照**。
  // 各写入口已经各自过了 scope,这里兜的是「又长出一条新的建任务路径、而它忘了过」——
  // 建任务只此一条汇流处,所以判据放这儿最省(第 3 轮审查 P1 泄露的就是这份快照)。
  // 归属人为空(转多人前的存量行)时不判:那不是「别人的」,是「还没认领的」。
  if (row.ownerUserId && profile.ownerUserId !== row.ownerUserId) return typeOnly();
  return JSON.stringify({
    id: profile.id,
    name: profile.name,
    type: profile.type,
    model: row.model ?? profile.model ?? null,
    ownerUserId: profile.ownerUserId,
  });
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
  // worktree 默认是**个人面**设置(§八):同一批任务理论上可以来自不同归属人(接力导入、
  // 派生),所以按 owner 各查各的,别用「第一行的归属人」代表整批。
  const worktreeDefaults = new Map<string, boolean>();
  for (const row of rows) {
    if (row.useWorktree !== undefined) continue;
    const owner = row.ownerUserId ?? "";
    if (worktreeDefaults.has(owner)) continue;
    worktreeDefaults.set(owner, (await settingsFor(row.ownerUserId ?? null)).worktreeDefault);
  }
  const projectIds = [...new Set(rows.map((row) => row.projectId))];
  const projectRows = await db
    .select({ id: projects.id, repoPath: projects.repoPath })
    .from(projects)
    .where(inArray(projects.id, projectIds));
  const repoByProject = new Map(projectRows.map((project) => [project.id, project.repoPath] as const));
  const normalizedRows = await Promise.all(rows.map(async (row): Promise<typeof tasks.$inferInsert & { id: string }> => {
    const requested = row.useWorktree ?? worktreeDefaults.get(row.ownerUserId ?? "") ?? false;
    const useWorktree = requested && projectHealthLight(repoByProject.get(row.projectId)).isRepo;
    const { workflowId, ...rest } = row;
    return {
      ...rest,
      useWorktree,
      worktreeBase: useWorktree ? row.worktreeBase ?? null : null,
      // 审查任务（reviewOf 非空）不拷线：它本身就是别人那条线上「验证」那一站长出来的
      // 产物，再给它配一条自己的线就成了「审查任务的审查任务」。
      executorSnapshot: row.executorSnapshot ?? (await snapshotExecutor(row)),
      workflow: row.workflowMode === "free"
        ? null
        : row.workflow ?? (row.reviewOf
          ? null
          : await snapshotWorkflow(workflowId, row.projectId, useWorktree, row.ownerUserId ?? null)),
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

import { eq, inArray, sql } from "drizzle-orm";
import { normalizeDuetConfig } from "@ash/shared/duet";
import type { AgentType, QuestionItem, Task, TaskListItem, TaskStage, TaskStatus } from "@ash/shared";
import { db } from "./db/index.js";
import { acceptGateRuns, agents, monitors, projects, queueItems, sessions, taskBackgroundRevisions, tasks } from "./db/schema.js";
import { bus } from "./bus.js";
import { runsTiming } from "./util.js";
import { projectHealthLight } from "./git.js";
import { withRepoLock } from "./repo-lock.js";
import { admissionKeysOf, admitMembers, TeamAcceptingError } from "./team-admission.js";
import { execFileText as exec } from "./exec.js";
import { expandHome } from "./git.js";
import { baseRef, initializeBranchPlan } from "./task-branch-plan.js";
import { resolveWorkflowDef } from "./workflows.js";
import { isMultiUser } from "./auth/mode.js";
import { profilesOwnedBy, type ExecutorProfileRow } from "./auth/owned-executors.js";
import { parseTaskCreationOrigin } from "@ash/shared/task-origin";
import { CliCommandValidationError, readCliStateScopes, validateCliCommand } from "@ash/shared/cli-commands";

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

const codexPlanStateFor = (task: TaskRow, profiles: AgentLabelRow[]): Pick<Task, "codexPlanMode" | "codexPlanScopes"> => {
  const states = task.mode === "single"
    ? Object.values(readCliStateScopes(task.cliState, "codex").scopes).filter((state) => state?.plan === true)
    : [];
  const codexPlanScopes = states.map((state) => ({
    executorId: state.profileId ?? null,
    executorLabel: state.profileId
      ? profiles.find((profile) => profile.id === state.profileId)?.name ?? state.profileId
      : "Codex（未绑定执行器）",
    isTaskOwner: (state.ownerUserId ?? null) === task.ownerUserId,
  }));
  return { codexPlanMode: codexPlanScopes.length > 0, codexPlanScopes };
};

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
  ...codexPlanStateFor(r, profiles),
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
  worktreeStartCommit: r.worktreeStartCommit,
  worktreeBaseBranch: r.worktreeBaseBranch ?? null,
  mergeTargetBranch: r.mergeTargetBranch,
  baseTaskId: r.baseTaskId,
  acceptedSourceCommit: r.acceptedSourceCommit,
  acceptedTargetBranch: r.acceptedTargetBranch ?? null,
  acceptedBaseCommit: r.acceptedBaseCommit ?? null,
  acceptedMergeCommit: r.acceptedMergeCommit ?? null,
  acceptedMergeMethod: (r.acceptedMergeMethod as Task["acceptedMergeMethod"]) ?? null,
  acceptedPendingTree: r.acceptedPendingTree ?? null,
  workflow: r.workflow ? JSON.parse(r.workflow) : null,
  workflowMode: r.workflowMode as Task["workflowMode"],
  workflowAt: r.workflowAt ?? null,
  originTaskId: r.originTaskId ?? null,
  creationOrigin: parseTaskCreationOrigin(r.creationOrigin),
  resumePrompt: r.resumePrompt ?? null,
  verifyRound: r.verifyRound ?? null,
  question: r.question ?? null,
  questionOptions: r.questionOptions ? (JSON.parse(r.questionOptions) as string[]) : null,
  questionItems: r.questionItems ? (JSON.parse(r.questionItems) as QuestionItem[]) : null,
  questionHistory: r.questionHistory ? JSON.parse(r.questionHistory) : [],
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
  const background = new Map((await db.select({
    taskId: tasks.id,
    backgroundRevision: sql<number>`coalesce(${taskBackgroundRevisions.revision}, 0)`.mapWith(Number),
    acceptGateRunning: sql<boolean>`exists(select 1 from ${acceptGateRuns} where ${acceptGateRuns.taskId} = ${tasks.id}
      and (${acceptGateRuns.status} = 'running' or ${acceptGateRuns.processPending} = 1))`.mapWith(Boolean),
    monitorRunning: sql<boolean>`exists(select 1 from ${monitors} where ${monitors.taskId} = ${tasks.id}
      and ${monitors.status} = 'running')`.mapWith(Boolean),
    // 「这个任务其实在干等上游」(回合级停滞看门狗,见 turn-stall.ts)。四个条件缺一不可:
    // 标记在、那条会话还没收尾、任务此刻真的在跑、而且**那条会话就是此刻这一轮用的那条** ——
    // 后三条是残值闸:ash 被硬杀时标记留在库里没人撤,少了它们那颗点会永久亮在卡片上。
    //
    // 最后一条是第 5 轮审查 F5:前三条挡不住「旧行还挂着标记、新回合已经在跑」。换执行器重试
    // 或者旧执行器不能复用时会**新建一条会话行**(task-run.ts / orchestrator.ts),旧行一个字
    // 不动;新会话正常输出只撤得掉自己那一行的标记(CAS 认的是置标记的那一次停滞),于是旧行
    // 跟着新任务的 running 一起又把红环点亮,一直亮到下一次有人恰好清了旧行。
    //
    // **「取代了它」按角色认,不按时间先后**(第 1 轮审查 F3,已实测)。上一版写的是「任务名下
    // 存在任何更晚开始的会话」,而讨论首轮本来就是两个声部**合法并行**(duet/index.ts 里两条
    // `runTurn` 一起起跑):A 卡在上游连不上、B 正常答完,B 只是晚了 100 毫秒开始,于是 A 那条
    // 仍然有效的停滞被当成旧残值过滤掉 —— 任务卡片只显示普通运行中,刷新也一样。
    // 时间戳回答不了「谁取代了谁」,角色才回答得了:一个任务上同一个角色(`single` / `voiceA` /
    // `voiceB` / `lead` …)**同时只有一条会话在执行**,换执行器重试换的就是同一个角色的下一条;
    // 而另一个声部压根不是同一个位置上的人,它多晚开始都挡不住这一条。
    upstreamStalled: sql<boolean>`exists(select 1 from ${sessions} where ${sessions.taskId} = ${tasks.id}
      and ${sessions.upstreamStalledSince} is not null and ${sessions.endedAt} is null
      and ${tasks.status} = 'running'
      and not exists(select 1 from sessions newer where newer.task_id = ${tasks.id}
        and newer.role = ${sessions.role}
        and coalesce(newer.turn_started_at, newer.started_at)
          > coalesce(${sessions.turnStartedAt}, ${sessions.startedAt})))`.mapWith(Boolean),
  }).from(tasks).leftJoin(taskBackgroundRevisions, eq(tasks.id, taskBackgroundRevisions.taskId))
    .where(inArray(tasks.id, rows.map(row => row.id)))).map(row => [row.taskId, row]));
  return rows.map((r) => {
    const q = byQueueTask.get(r.id);
    return {
      ...toTask(r, profiles),
      ...runsTiming(byTask.get(r.id) ?? []),
      queueId: q?.queueId ?? null,
      queuePosition: q?.position ?? null,
      backgroundRevision: background.get(r.id)?.backgroundRevision ?? 0,
      acceptGateRunning: background.get(r.id)?.acceptGateRunning ?? false,
      monitorRunning: background.get(r.id)?.monitorRunning ?? false,
      upstreamStalled: background.get(r.id)?.upstreamStalled ?? false,
    };
  });
}

/**
 * 列表序列化：丢掉正文和问答历史。
 *
 * 只有 `GET /tasks` 用它。`GET /tasks/:id` 和 SSE 的 task.created/updated 仍发整份
 * `Task`——前者就是详情面取正文的地方，后者要能就地更新已经打开的任务。
 */
export function toTaskListItem({ body: _body, questionHistory: _history, ...rest }: Task): TaskListItem {
  return rest;
}

// 任务创建时把那条线**拷一份**进 tasks.workflow。起手式是「起手式」不是「模板引用」：
// 之后改库、停用、恢复默认，都不会追着改已经开工的任务 —— 用户改库时要能放心改，不必
// 先想一遍「这会不会把正在跑的 40 个任务也改了」。
//
// workspace 这一栏刻意**跟着 useWorktree 走，而不是反过来**：这一期只落数据、不接管
// 执行链。让起手式来决定「要不要开 worktree」得等前端真能选起手式的那一期，否则用户在
// 项目设置里关掉的 worktree，会被一条他还看不见的线悄悄打开。
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
//
// beforeInsert 是**拿到全部 repo lock 之后、产生任何副作用之前**的最后一次「现在还该建吗」。
// 等锁可能等很久，等着的这段时间里委派来源可能已经不作数了（聊天派生的任务：群聊被删了），
// 而 createTasks 一旦越过这里就只管把行插进去。抛出即取消创建，此时还没有分支计划、没有
// 插入，无需回滚。放在这里而不是调用方 `await createTasks()` 之前——那太早，锁还没拿到。
export async function createTasks(
  rows: NewTaskRow[],
  afterInsert?: () => Promise<void>,
  beforeInsert?: () => Promise<void> | void,
  /** 行上没记、但这次创建也挂靠着的任务（POST /tasks 的 reviewOf）：一起占「加成员」的位。 */
  alsoAdmit: (string | null | undefined)[] = [],
): Promise<Task[]> {
  if (rows.length === 0) return [];
  for (const row of rows) {
    const agentType = row.agentType ?? "claude";
    const command = validateCliCommand(agentType, row.body ?? "");
    if (command && row.mode && row.mode !== "single" && !(agentType === "claude" && command.name === "compact")) throw new CliCommandValidationError("原生命令仅支持普通单任务");
  }
  // Creation defaults belong here so every ordinary path (HTTP single, batch /
  // chain, duet handoff, future clients) gets the same behavior. Explicit
  // true/false wins, but a non-repo project can never materialize a worktree.
  // worktree 默认住在**项目**上(projects.use_worktree_default),所以同一批里跨项目的任务
  // 各按各自项目的那一位算 —— 它不是个人口味,也不是这台机器的性质,而是「这个仓库吃不吃
  // 得住 worktree」。
  const projectIds = [...new Set(rows.map((row) => row.projectId))];
  const projectRows = await db
    .select({ id: projects.id, repoPath: projects.repoPath, useWorktreeDefault: projects.useWorktreeDefault })
    .from(projects)
    .where(inArray(projects.id, projectIds));
  const repoByProject = new Map(projectRows.map((project) => [project.id, project.repoPath] as const));
  const worktreeDefaultByProject = new Map(projectRows.map((project) => [project.id, project.useWorktreeDefault] as const));
  const normalizedRows = await Promise.all(rows.map(async (row): Promise<typeof tasks.$inferInsert & { id: string }> => {
    const requested = row.useWorktree ?? worktreeDefaultByProject.get(row.projectId) ?? false;
    const useWorktree = requested && projectHealthLight(repoByProject.get(row.projectId)).isRepo;
    const { workflowId, ...rest } = row;
    return {
      ...rest,
      creationOrigin: row.creationOrigin === undefined ? JSON.stringify({ kind: "system" }) : row.creationOrigin,
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
  const repos = [...new Set(projectRows.map(p => p.repoPath))].sort();
  const insert = async (index: number): Promise<void> => {
    if (index < repos.length) return withRepoLock(repos[index], () => insert(index + 1));
    // 挂在别的任务名下的（执行者、子任务、审查）：落库那一下占着「加成员」的位，跟挂靠任务的验收互斥（team-admission.ts）。
    const admitted = admitMembers(await admissionKeysOf([...rows.flatMap((row) => [row.parentId, row.reviewOf]), ...alsoAdmit]));
    if (!admitted) throw new TeamAcceptingError();
    try {
      await insertAdmitted();
    } finally {
      admitted();
    }
  };
  const insertAdmitted = async (): Promise<void> => {
    await beforeInsert?.();
    const pinned: typeof normalizedRows = [];
    try {
      for (const row of normalizedRows) {
        const hadStart = !!row.worktreeStartCommit;
        await initializeBranchPlan(row, repoByProject.get(row.projectId) || "");
        if (!hadStart && row.worktreeStartCommit) pinned.push(row);
      }
      await db.insert(tasks).values(normalizedRows);
    } catch (error) {
      for (const row of pinned) await exec("git", ["-C", expandHome(repoByProject.get(row.projectId)), "update-ref", "-d", baseRef(row.id), row.worktreeStartCommit!]).catch(() => {});
      throw error;
    }
  };
  await insert(0);
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

import { eq, inArray, sql } from "drizzle-orm";
import { normalizeDuetConfig } from "@navi/shared/duet";
import type { AgentType, QuestionItem, Task, TaskListItem, TaskStage, TaskStatus } from "@navi/shared";
import { db } from "./db/index.js";
import { serializeQueueClaims } from "./queue-claim-chain.js";
import { acceptGateRuns, agents, freeReviewRounds, freeReviewRuns, freeWorkflowStates, monitors, projects, queueItems, sessions, taskBackgroundRevisions, tasks } from "./db/schema.js";
import { startDisputeOpenSync } from "./dispute-open-sync.js";
import { awaitingRuling } from "./free-review-awaiting-ruling.js";
import { bus } from "./bus.js";
import { now, runsTiming } from "./util.js";
import { projectHealthLight } from "./git.js";
import { withRepoLock } from "./repo-lock.js";
import { admissionKeysOf, admitMembers, joinDispatchChain, TeamAcceptingError } from "./team-admission.js";
import { execFileText as exec } from "./exec.js";
import { expandHome } from "./git.js";
import { baseRef, initializeBranchPlan } from "./task-branch-plan.js";
import { assertPrerequisiteEdges, insertPrerequisiteEdges, withPrerequisiteGraph, type EdgeTask, type PrerequisiteEdge } from "./prerequisite-store.js";
import { resolveWorkflowDef } from "./workflows.js";
import { isMultiUser } from "./auth/mode.js";
import { profilesOwnedBy, type ExecutorProfileRow } from "./auth/owned-executors.js";
import { parseTaskCreationOrigin } from "@navi/shared/task-origin";
import { resolveDispatchedBy, withDispatchDefaults } from "./task-dispatch.js";
import { activeDispatchPlan, parseDispatchPlan, parseDispatchTarget } from "@navi/shared/dispatch-plan";
import { parseDispatchSuggestions, parseWithdrawnSuggestions, publicSuggestions } from "@navi/shared/dispatch-suggestion";
import { CliCommandValidationError, PLAN_AGENTS, PLAN_TOGGLE_NOT_A_RUN, isPlanToggle, readCliStateScopes, validateCliCommand } from "@navi/shared/cli-commands";
import type { CreateReviewChoice } from "@navi/shared/review-on-create";
import { announceCreateReviews, reservationRows, resolveCreateReviews, type CreateReviewSlot } from "./review-on-create.js";

export type TaskRow = typeof tasks.$inferSelect;
// workflowId 不是列：它是**创建那一刻**用来挑起手式的 id，落库时会被换成 tasks.workflow
// 里的那份快照（见 createTasks）。调用方给 id，库里存线本身。
/** `review`：建出来就带的审查预约（review-on-create.ts），不是任务表的列；缺省 = 不带。 */
export type NewTaskRow = typeof tasks.$inferInsert & { id: string; workflowId?: string | null; review?: CreateReviewChoice };

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

const UNBOUND_PLAN_LABEL: Record<(typeof PLAN_AGENTS)[number], string> = { codex: "Codex（未绑定执行器）", claude: "Claude Code（未绑定执行器）" };

const planStateFor = (task: TaskRow, profiles: AgentLabelRow[]): Pick<Task, "planMode" | "planScopes"> => {
  const planScopes = task.mode !== "single" ? [] : PLAN_AGENTS.flatMap((agentType) =>
    Object.values(readCliStateScopes(task.cliState, agentType).scopes).filter((state) => state?.plan === true).map((state) => ({
      agentType,
      executorId: state.profileId ?? null,
      executorLabel: state.profileId
        ? profiles.find((profile) => profile.id === state.profileId)?.name ?? state.profileId
        : UNBOUND_PLAN_LABEL[agentType],
      isTaskOwner: (state.ownerUserId ?? null) === task.ownerUserId,
    })));
  return { planMode: planScopes.length > 0, planScopes };
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
  ...planStateFor(r, profiles),
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
  dispatchedBy: r.dispatchedBy ?? null,
  dispatchHoldAt: r.dispatchHoldAt ?? null,
  dispatchHoldPendingAt: r.dispatchHoldPendingAt ?? null,
  resumePrompt: r.resumePrompt ?? null,
  verifyRound: r.verifyRound ?? null,
  question: r.question ?? null,
  questionOptions: r.questionOptions ? (JSON.parse(r.questionOptions) as string[]) : null,
  questionItems: r.questionItems ? (JSON.parse(r.questionItems) as QuestionItem[]) : null,
  questionHistory: r.questionHistory ? JSON.parse(r.questionHistory) : [],
  // 只在它绑的那一问还在时下发（shared/src/dispatch-plan.ts `activeDispatchPlan`）。
  dispatchPlan: activeDispatchPlan({ question: r.question, dispatchPlan: parseDispatchPlan(r.dispatchPlan) }),
  dispatchTarget: parseDispatchTarget(r.dispatchTarget),
  dispatchSuggestions: publicSuggestions(parseDispatchSuggestions(r.dispatchSuggestions)),
  dispatchWithdrawals: parseWithdrawnSuggestions(r.dispatchWithdrawals),
  handoff: r.handoff ? JSON.parse(r.handoff) : null,
  handoffAudit: r.handoffAudit ? JSON.parse(r.handoffAudit) : null,
});

// 「等你裁定」那一格变了就重发快照：挂在列表投影旁边，加载即生效（dispute-open-sync.ts）。
startDisputeOpenSync();

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
  // 对外的 queuePosition 是**名次**(0..N-1),不是库里那一列的原值:position 只保证先后,
  // 中间缺号(删任务只摘自己那一格)的话原值 +1 就成了「13/12」这种读数。
  const queueRank = new Map<string, number>();
  const queueIds = [...new Set(items.map((q) => q.queueId))];
  if (queueIds.length) {
    const members = await db.select({ queueId: queueItems.queueId, taskId: queueItems.taskId }).from(queueItems)
      .where(inArray(queueItems.queueId, queueIds)).orderBy(queueItems.queueId, queueItems.position);
    let queueId: string | null = null;
    let rank = 0;
    for (const member of members) {
      if (member.queueId !== queueId) { queueId = member.queueId; rank = 0; }
      queueRank.set(member.taskId, rank++);
    }
  }
  const background = new Map((await db.select({
    taskId: tasks.id,
    backgroundRevision: sql<number>`coalesce(${taskBackgroundRevisions.revision}, 0)`.mapWith(Number),
    acceptGateRunning: sql<boolean>`exists(select 1 from ${acceptGateRuns} where ${acceptGateRuns.taskId} = ${tasks.id}
      and (${acceptGateRuns.status} = 'running' or ${acceptGateRuns.processPending} = 1))`.mapWith(Boolean),
    monitorRunning: sql<boolean>`exists(select 1 from ${monitors} where ${monitors.taskId} = ${tasks.id}
      and ${monitors.status} = 'running')`.mapWith(Boolean),
    // 「这个任务其实在干等上游」(回合级停滞看门狗,见 turn-stall.ts)。四个条件缺一不可:
    // 标记在、那条会话还没收尾、任务此刻真的在跑、而且**那条会话就是此刻这一轮用的那条** ——
    // 后三条是残值闸:navi 被硬杀时标记留在库里没人撤,少了它们那颗点会永久亮在卡片上。
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
    // 「执行者驳回了一轮审查意见，在等你裁定」。判据跟裁定闸、审查面板那张卡同一份（awaitingRuling）；
    // 它变了由 dispute-open-sync.ts 统一重发快照（下面 startDisputeOpenSync）。
    disputeOpen: sql<boolean>`exists(select 1 from ${freeReviewRounds}
      inner join ${freeReviewRuns} on ${freeReviewRuns.id} = ${freeReviewRounds.runId}
      where ${freeReviewRuns.taskId} = ${tasks.id} and ${awaitingRuling})`.mapWith(Boolean),
  }).from(tasks).leftJoin(taskBackgroundRevisions, eq(tasks.id, taskBackgroundRevisions.taskId))
    .where(inArray(tasks.id, rows.map(row => row.id)))).map(row => [row.taskId, row]));
  const { prerequisiteViews } = await import("./prerequisite-view.js");
  const prerequisites = await prerequisiteViews(rows);
  return rows.map((r) => {
    const q = byQueueTask.get(r.id);
    const view = prerequisites.get(r.id);
    return {
      ...toTask(r, profiles),
      ...runsTiming(byTask.get(r.id) ?? []),
      queueId: q?.queueId ?? null,
      queuePosition: q ? queueRank.get(r.id) ?? q.position : null,
      backgroundRevision: background.get(r.id)?.backgroundRevision ?? 0,
      acceptGateRunning: background.get(r.id)?.acceptGateRunning ?? false,
      monitorRunning: background.get(r.id)?.monitorRunning ?? false,
      upstreamStalled: background.get(r.id)?.upstreamStalled ?? false,
      disputeOpen: background.get(r.id)?.disputeOpen ?? false,
      ...(view ? { prerequisites: view } : {}),
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
//
// 串进队列这一种挂靠不能走 afterInsert，要走 `atomic`：任务行一插进去，调度器（分组运行、
// 队列推进）和改分组那些写方读库就看得见它，这时队列成员还没写，它就是一条可以被单独起跑、
// 单独改组的独立任务 —— 随后再串进队列，挂上的是一条已经在跑、或者已经换了组的任务；串不进去
// 时再删行，删掉的可能是一条已经被人接手跑起来的任务（NJ1Maq-3KV_I 第 2 轮审查实测三种）。所以
// 任务行与队列成员**同一笔事务**落库，且整笔排在队列认领链上（queue-claim-chain.ts）：事务没提交时
// 同一条连接上的读看得见新行，但凡要起它、改它归属的都在链上，轮到时它已经在队里了。
type TaskTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function createTasks(
  rows: NewTaskRow[],
  afterInsert?: () => Promise<void>,
  beforeInsert?: () => Promise<void> | void,
  /** 行上没记、但这次创建也挂靠着的任务（POST /tasks 的 reviewOf）：一起占「加成员」的位。 */
  alsoAdmit: (string | null | undefined)[] = [],
  /** 这一批里逐条写的前置（下游可以是这一批里的，前置也可以是已有的任务）。不成立就整批不建。 */
  prerequisites: PrerequisiteEdge[] = [],
  /**
   * 要跟这批任务同一笔提交的写（派活单：认领那一问、分组、队列，dispatch-plan-launch.ts；串到队尾 / 串成队列：
   * queue-membership-guard.ts `joinQueueOnCreate`）。`before` 在插任务之前、`after` 在之后，都在同一个事务里，整笔
   * 排在队列认领链上（见上）；任一步抛错整笔回滚，一条都不留。只能用传进来的事务写，别碰根 `db`，也别再等那条链。
   */
  atomic?: {
    before?: (transaction: TaskTransaction) => Promise<void>;
    after?: (transaction: TaskTransaction) => Promise<void>;
    /** 那一笔提交成功的那一刻（之后的读回、广播再抛错，调用方据此知道任务已经建好了）。 */
    onCommitted?: () => void;
  },
): Promise<Task[]> {
  if (rows.length === 0) return [];
  for (const row of rows) {
    const agentType = row.agentType ?? "claude";
    const command = validateCliCommand(agentType, row.body ?? "");
    if (command && row.mode && row.mode !== "single" && !(agentType === "claude" && command.name === "compact")) throw new CliCommandValidationError("原生命令仅支持普通单任务");
    if (isPlanToggle(agentType, command)) throw new CliCommandValidationError(PLAN_TOGGLE_NOT_A_RUN);
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
  // 创建来源先定下来：调用方没给 = 服务端自己建的（系统）。下面两步认的都是落库的这一份。
  const sourced = rows.map((row) => ({
    ...row,
    creationOrigin: row.creationOrigin === undefined ? JSON.stringify({ kind: "system" }) : row.creationOrigin,
  }));
  // 收在谁名下（判据见 task-dispatch.ts）：显式给的优先，否则按创建来源认。
  const dispatchedBy = await resolveDispatchedBy(sourced);
  // 没指明交给谁、又收在某条任务名下的：交给那条任务「派出去的活交给谁」的默认值（task-dispatch.ts）。
  const assigned = await withDispatchDefaults(sourced, dispatchedBy);
  // 建出来就带的审查预约：先核一遍（指定了却找不到整批不建，早退），落库那笔事务里再定一遍才作数（review-on-create.ts）。
  await resolveCreateReviews(assigned);
  let reviewSlots: CreateReviewSlot[] = [];
  const normalizedRows = await Promise.all(assigned.map(async (row): Promise<typeof tasks.$inferInsert & { id: string }> => {
    const requested = row.useWorktree ?? worktreeDefaultByProject.get(row.projectId) ?? false;
    const useWorktree = requested && projectHealthLight(repoByProject.get(row.projectId)).isRepo;
    const { workflowId, review: _review, ...rest } = row;
    return {
      ...rest,
      dispatchedBy: dispatchedBy.get(row.id) ?? null,
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
      // 收在别的任务名下的：跟那棵派活树的整棵归档互斥，归档了的任务名下不再长没归档的（team-admission.ts）。
      // 本身就是归档态落库的（接力导入一条已归档的任务）不算「长出来」。
      const dispatchers = new Set(normalizedRows.flatMap((row) => (row.dispatchedBy && !row.archived ? [row.dispatchedBy] : [])));
      const joined = await joinDispatchChain([...dispatchers]);
      try {
        await insertAdmitted();
      } finally {
        joined();
      }
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
      // 合入目标要等分支计划算出来才判得了（prerequisite-store.ts），所以排在它后面、落库前面。
      // 判环与落边在整张图上排队（prerequisite-store.ts `withPrerequisiteGraph`）；不带前置的照旧直接落。
      // 任务行、预约槽、前置边**始终同一笔事务**（分开落时预约一失败，报错之后库里留着一条没预约的任务）。带 `atomic`
      // 的再把调用方那几笔放进来、整笔排在认领链上（见上）。锁序是图 → 认领链：链上的人不会回头等图。
      const write = async (transaction: TaskTransaction) => {
        await atomic?.before?.(transaction);
        await transaction.insert(tasks).values(normalizedRows);
        reviewSlots = await resolveCreateReviews(assigned, transaction);
        if (reviewSlots.length) await transaction.insert(freeWorkflowStates).values(reservationRows(reviewSlots, now()));
        await insertPrerequisiteEdges(prerequisites, transaction);
        await atomic?.after?.(transaction);
      };
      const land = async () => {
        await assertPrerequisiteEdges(prerequisites, normalizedRows.map(edgeTaskOf));
        if (!atomic) return db.transaction(write, { behavior: "immediate" });
        await serializeQueueClaims(() => db.transaction(write, { behavior: "immediate" }));
        atomic.onCommitted?.();
      };
      await (prerequisites.length ? withPrerequisiteGraph(land) : land());
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
  if (reviewSlots.length) await announceCreateReviews(reviewSlots);
  return created;
}

/** 串进队列那一笔事务里能用的读写(createTasks 的 `atomic.after`,queue-membership-guard.ts)。 */
export type QueueJoinWriter = Pick<typeof db, "select" | "insert">;

const edgeTaskOf = (row: typeof tasks.$inferInsert & { id: string }): EdgeTask => ({
  id: row.id, projectId: row.projectId, title: row.title, mode: row.mode ?? "single", parentId: row.parentId ?? null,
  reviewOf: row.reviewOf ?? null, status: row.status ?? "backlog", archived: !!row.archived, useWorktree: !!row.useWorktree,
  mergeTargetBranch: row.mergeTargetBranch ?? null, acceptedTargetBranch: row.acceptedTargetBranch ?? null,
  baseTaskId: row.baseTaskId ?? null, stage: row.stage ?? null,
});

export async function publishTaskUpdated(taskId: string): Promise<Task | null> {
  const row = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!row) return null;
  const task = (await enrichTasks([row]))[0]!;
  bus.publish({ type: "task.updated", task });
  return task;
}

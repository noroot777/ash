import type { AgentType, Task, TaskStatus, TaskWorkspaceDiscardResult } from "@ash/shared";
import { AGENT_TYPES, isUserSettableStatus, TASK_BATCH_LIMIT } from "@ash/shared";
import { isReasoningEffortSupported, normalizeReasoningEffort, reasoningEffortsFor } from "@ash/shared/cli-presets";
import { inheritExecutorOverrides, sameExecutor } from "@ash/shared/executors";
import { normalizeWorkflowDef } from "@ash/shared/workflow";
import { TASK_WORKFLOW_MODES } from "@ash/shared/free-workflow";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Hono } from "hono";
import { db } from "./db/index.js";
import { agents, freeReviewRounds, freeReviewRuns, freeWorkflowEvents, freeWorkflowStates, groups, noteTasks, projects, queueItems, schedules, scheduledMessages, sessions, tasks, teamInbound } from "./db/schema.js";
import { handoffBlockReason } from "./handoff-guard.js";
import { detectTaskWorkspace, discardTaskWorkspace } from "./workspace-cleanup.js";
import { followUpsFor } from "./task-follow-up.js";
import { advanceQueue } from "./scheduler.js";
import { setTaskStatus } from "./status.js";
import { isTurnClaimed } from "./runs.js";
import { isAcceptingTask } from "./acceptance-lock.js";
import { createTasks, enrichTasks, publishTaskUpdated, toTaskListItem } from "./task-store.js";
import { attachmentsPrompt, id, now, taskBody } from "./util.js";
import { actorOf } from "./auth/context.js";
import { canSeeProject, visibleProjectIds, visibleTaskIds } from "./auth/visibility.js";
import { ownerIdOf } from "./auth/context.js";
import { inheritOwner } from "./auth/run-env.js";

// 任务行删除时连关联状态一起收：自由审查链(run/round)、预约槽、事件、排队/定时消息、
// 随手记回链。没有 FK cascade,只删任务行会留下孤儿——审查实测:等答复的审查在任务
// 删除后永远停在 reviewing,答复消息永远 pending(投递时任务已不存在)。
export async function deleteTaskAssociations(taskId: string): Promise<void> {
  const runIds = (await db.select({ id: freeReviewRuns.id }).from(freeReviewRuns)
    .where(eq(freeReviewRuns.taskId, taskId))).map((run) => run.id);
  if (runIds.length) await db.delete(freeReviewRounds).where(inArray(freeReviewRounds.runId, runIds));
  await db.delete(freeReviewRuns).where(eq(freeReviewRuns.taskId, taskId));
  await db.delete(freeWorkflowStates).where(eq(freeWorkflowStates.taskId, taskId));
  await db.delete(freeWorkflowEvents).where(eq(freeWorkflowEvents.taskId, taskId));
  await db.delete(scheduledMessages).where(eq(scheduledMessages.taskId, taskId));
  await db.delete(teamInbound).where(eq(teamInbound.taskId, taskId)); // 调度台还没送出的入站消息
  await db.delete(noteTasks).where(eq(noteTasks.taskId, taskId));
  // 会话行、定时计划、队列位也一起收：孤儿 cron 每个 tick 都会被扫到再查不到任务，
  // 队列残位会顶住后续推进（审查实测：删除后 sessionRows/scheduleRows 各剩 1）。
  await db.delete(sessions).where(eq(sessions.taskId, taskId));
  await db.delete(schedules).where(eq(schedules.taskId, taskId));
  await db.delete(queueItems).where(eq(queueItems.taskId, taskId));
  // 团队派活自建的内部组（groups.owner_task_id=本任务）：GET /groups 默认过滤掉它们，
  // 留下来就是永远不可见也没入口清理的孤儿（审查实测：删 lead 后两个内部组原样保留）。
  await db.delete(groups).where(eq(groups.ownerTaskId, taskId));
}

export function mountTaskRoutes(api: Hono): void {
  // 一次最多问这么多任务的追问 / 正文（判据和常量本体在 shared 的 TASK_BATCH_LIMIT）：
  // 追问每个都要摸一次盘，别让一个手抖的请求把整个进程钉在 I/O 上。
  // **超了返 400，不截断** —— 静默少返几行会被前端渲染成「还没读到」，一条永远不会
  // 消失的假状态；请求方分批才是对的做法。
  const overBatchLimit = (ids: string[]) =>
    ids.length > TASK_BATCH_LIMIT
      ? { error: `一次最多问 ${TASK_BATCH_LIMIT} 个任务，请分批`, limit: TASK_BATCH_LIMIT, requested: ids.length }
      : null;
  const agentTypeForExecutor = async (executorId?: string | null): Promise<AgentType | null> => {
    if (!executorId) return null;
    const row = (await db.select({ type: agents.type }).from(agents).where(eq(agents.id, executorId))).at(0);
    return row ? (row.type as AgentType) : null;
  };

// ── tasks ───────────────────────────────────────────────────────────────
// 列表**不带正文**（TaskListItem）：一千多行任务里正文占了响应的一半，而没有一处列表
// UI 用得上它。正文由 `GET /tasks/:id` 单取。这条路由是全应用最大的一份响应，且每次
// 开页面 + 每次 SSE 重连都要整份重拉，省下来的是首屏和断线恢复的直接成本。
// 任务的可见性**跟项目走**(§八):看得见项目就看得见项目里的全部任务,不论是谁的活。
api.get("/tasks", async (c) => {
  const visible = await visibleProjectIds(actorOf(c));
  const all = await db.select().from(tasks);
  const rows = visible === null ? all : all.filter((t) => visible.has(t.projectId));
  return c.json((await enrichTasks(rows)).map(toTaskListItem));
});

// 侧边栏铺开时才拉：一批任务各自「我发的最后一条追问」（读的是会话 .md，不是库）。
// 用 POST 是因为要一次带上几十个 id，塞进 query 会顶到 URL 长度上限。
api.post("/tasks/follow-ups", async (c) => {
  const body = await c.req.json<{ taskIds?: unknown }>().catch(() => ({ taskIds: [] }));
  const ids = Array.isArray(body.taskIds) ? body.taskIds.filter((id): id is string => typeof id === "string") : [];
  const over = overBatchLimit(ids);
  if (over) return c.json(over, 400);
  return c.json(await followUpsFor(await visibleTaskIds(actorOf(c), ids)));
});

// 正文批量取。跟上面那条同一个触发点（侧边栏铺开的「原始需求」列），同一套 id 上限，
// 只是这份数据在库里而不在会话文件里，所以另开一条而不是塞进 follow-ups —— 后者按
// 定义只有「追问过的任务」才有行，而正文是每个任务都有的。
//
// 列表接口（GET /tasks）不再带正文，所以需要正文的表面各自按需取：铺开走这条，详情
// 面走 GET /tasks/:id。
api.post("/tasks/bodies", async (c) => {
  const body = await c.req.json<{ taskIds?: unknown }>().catch(() => ({ taskIds: [] }));
  const ids = Array.isArray(body.taskIds) ? body.taskIds.filter((id): id is string => typeof id === "string") : [];
  if (!ids.length) return c.json([]);
  const over = overBatchLimit(ids);
  if (over) return c.json(over, 400);
  const visible = await visibleProjectIds(actorOf(c));
  const rows = (await db
    .select({ taskId: tasks.id, body: tasks.body, projectId: tasks.projectId })
    .from(tasks)
    .where(inArray(tasks.id, ids)))
    .filter((row) => visible === null || visible.has(row.projectId));
  return c.json(rows.map((row) => ({ taskId: row.taskId, body: row.body ?? "" })));
});

api.get("/tasks/:id", async (c) => {
  const rows = await db.select().from(tasks).where(eq(tasks.id, c.req.param("id")));
  const r = rows.at(0);
  // 看不见的任务与不存在的任务**回同一句话**:否则挨个 id 试就能问出「这个任务存在,
  // 只是不是我的项目」。
  if (!r || !(await canSeeProject(actorOf(c), r.projectId))) return c.json({ error: "not found" }, 404);
  return c.json((await enrichTasks([r]))[0]);
});

api.post("/tasks", async (c) => {
  const b = await c.req.json<Partial<Task> & {
    projectId: string;
    title: string;
    attachments?: string[];
    appendToQueue?: string; // 可选:把新任务追加到指定 queue 的尾部
    workflowId?: string | null; // 挑哪条起手式;省略则按项目→全局默认解析
  }>();
  const workflowMode = b.workflowMode ?? "preset";
  if (!(TASK_WORKFLOW_MODES as readonly string[]).includes(workflowMode)) {
    return c.json({ error: "workflowMode 只能是 free 或 preset" }, 400);
  }
  if (workflowMode === "free" && ((b.mode ?? "single") !== "single" || b.parentId != null || b.reviewOf != null)) {
    return c.json({ error: "自由工作流只适用于普通单任务" }, 409);
  }
  if (workflowMode === "free" && (b.workflow != null || b.workflowId != null)) {
    return c.json({ error: "自由工作流不能同时携带起手式" }, 400);
  }
  // 新建面板允许**就地改这条线**（挑一个起手式再动两下），改完的那份直接随任务提交，
  // 不用先在库里存一条。收下来的仍然只是一份快照,跟 workflowId 那条路殊途同归。
  let inlineWorkflow: string | null = null;
  if (b.workflow !== undefined && b.workflow !== null) {
    const parsed = normalizeWorkflowDef(b.workflow);
    if ("error" in parsed) return c.json({ error: `workflow 不合法:${parsed.error}` }, 400);
    inlineWorkflow = JSON.stringify(parsed.def);
  }
  const derivationMode = b.mode === "team" || b.mode === "duet";
  if (derivationMode && b.parentId !== undefined && b.parentId !== null) {
    return c.json(
      { error: "派生执行者或审查任务不能再创建团队/讨论任务", parentId: b.parentId },
      409,
    );
  }
  if (derivationMode && b.originTaskId) {
    const source = (
      await db
        .select({ parentId: tasks.parentId, reviewOf: tasks.reviewOf })
        .from(tasks)
        .where(eq(tasks.id, b.originTaskId))
    ).at(0);
    if (source && (source.parentId !== null || source.reviewOf !== null)) {
      return c.json(
        { error: "派生执行者或审查任务不能再创建团队/讨论任务", originTaskId: b.originTaskId },
        409,
      );
    }
  }
  const ts = now();
  const taskId = id();
  const executorType = await agentTypeForExecutor(b.executorId);
  if (executorType && b.agentType && b.agentType !== executorType) {
    return c.json({ error: `executorId 属于 ${executorType},但 agentType 是 ${b.agentType}`, executorId: b.executorId }, 400);
  }
  const rawTeam = b.team;
  if (rawTeam?.review !== undefined && typeof rawTeam.review !== "boolean") {
    return c.json({ error: "team.review 必须是 boolean" }, 400);
  }
  if (rawTeam?.reviewerAgentType !== undefined && !AGENT_TYPES.includes(rawTeam.reviewerAgentType)) {
    return c.json({ error: "team.reviewerAgentType 不是有效 agent 类型" }, 400);
  }
  const teamLeadType = rawTeam ? await agentTypeForExecutor(rawTeam.leadExecutorId) : null;
  const teamWorkerType = rawTeam ? await agentTypeForExecutor(rawTeam.workerExecutorId) : null;
  const teamReviewerType = rawTeam ? await agentTypeForExecutor(rawTeam.reviewerExecutorId) : null;
  if (rawTeam && teamLeadType && rawTeam.lead !== teamLeadType) {
    return c.json({ error: `team.leadExecutorId 属于 ${teamLeadType},但 team.lead 是 ${rawTeam.lead}`, executorId: rawTeam.leadExecutorId }, 400);
  }
  if (rawTeam && teamWorkerType && rawTeam.worker !== teamWorkerType) {
    return c.json({ error: `team.workerExecutorId 属于 ${teamWorkerType},但 team.worker 是 ${rawTeam.worker}`, executorId: rawTeam.workerExecutorId }, 400);
  }
  if (rawTeam && teamReviewerType && (rawTeam.reviewerAgentType ?? rawTeam.worker) !== teamReviewerType) {
    return c.json({ error: `team.reviewerExecutorId 属于 ${teamReviewerType},但 reviewerAgentType 是 ${rawTeam.reviewerAgentType ?? rawTeam.worker}`, executorId: rawTeam.reviewerExecutorId }, 400);
  }
  const teamConfig = rawTeam
    ? {
        lead: rawTeam.lead,
        worker: rawTeam.worker,
        leadExecutorId: rawTeam.leadExecutorId ?? null,
        workerExecutorId: rawTeam.workerExecutorId ?? null,
        leadModel: rawTeam.leadModel || null,
        leadReasoningEffort: rawTeam.leadReasoningEffort || null,
        workerModel: rawTeam.workerModel || null,
        workerReasoningEffort: rawTeam.workerReasoningEffort || null,
        review: rawTeam.review !== false,
        reviewerAgentType: rawTeam.reviewerAgentType,
        reviewerExecutorId: rawTeam.reviewerExecutorId ?? null,
        reviewerModel: rawTeam.reviewerModel || null,
        reviewerReasoningEffort: rawTeam.reviewerReasoningEffort || null,
      }
    : null;
  const row = {
    id: taskId,
    projectId: b.projectId,
    groupId: b.groupId ?? null,
    parentId: b.parentId ?? null,
    title: b.title,
    body: taskBody(b.body, taskId) + attachmentsPrompt(b.attachments),
    mode: b.mode ?? "single",
    status: (b.status && isUserSettableStatus(b.status) ? b.status : "backlog") as TaskStatus,
    labels: JSON.stringify(b.labels ?? []),
    // dependsOn / resumeDependsOn 字段保留为 []。新模型用 queue_items
    // 表达顺序依赖;input 上的这俩字段已不再接受。
    dependsOn: "[]",
    resumeDependsOn: "[]",
    agentType: b.agentType ?? (teamConfig ? teamConfig.lead : executorType) ?? null,
    executorId: b.executorId ?? null,
    model: b.model || null,
    reasoningEffort: b.reasoningEffort || null,
    autoTitle: b.autoTitle ?? false,
    duet: b.duet ? JSON.stringify(b.duet) : null,
    // mode:"team" 的调度者/默认执行者类型(跟 duet 对称)。别漏 —— 漏了就静默退回
    // TEAM_DEFAULTS,用户在启动器上挑的那两个旋钮全白挑。
    team: teamConfig ? JSON.stringify(teamConfig) : null,
    scheduleId: null,
    createdAt: ts,
    updatedAt: ts,
    // undefined is resolved centrally from AppSettings; explicit true/false is
    // preserved, and createTasks still forces false for non-repo projects.
    useWorktree: b.useWorktree,
    worktreeBase: b.worktreeBase ?? null,
    originTaskId: b.originTaskId ?? null,
    // createTasks 把它换成 tasks.workflow 里的快照（起手式是快照不是引用）。
    // 就地改过的线已经是快照了,直接落 workflow,createTasks 不会再去库里查。
    workflowId: b.workflowId ?? null,
    workflow: inlineWorkflow,
    workflowMode,
    // 「谁的活」(§八):归属决定用谁的执行器/供应商/CLI 环境跑,以及统计算在谁头上。
    // 派生任务(团队执行者/审查/就地验证)继承父任务,那条路在各自的创建点上。
    ownerUserId: (await inheritOwner(b.parentId)) ?? ownerIdOf(actorOf(c)),
  };
  // 可选:追加到现有 queue 的尾部。要求:queue 已存在,且新 task 跟
  // queue 已有任务的 groupId 一致(违反就 400,不静默)。
  let appendPosition: number | null = null;
  if (b.appendToQueue) {
    const existing = await db
      .select()
      .from(queueItems)
      .where(eq(queueItems.queueId, b.appendToQueue))
      .orderBy(asc(queueItems.position));
    if (existing.length === 0) {
      return c.json({ error: `queue ${b.appendToQueue} 不存在` }, 400);
    }
    const firstTask = (
      await db.select().from(tasks).where(eq(tasks.id, existing[0].taskId))
    ).at(0);
    if (firstTask && (firstTask.groupId ?? null) !== (row.groupId ?? null)) {
      return c.json(
        {
          error: `跨 group 不允许:queue 属于 group ${firstTask.groupId},新任务属于 ${row.groupId}`,
        },
        400,
      );
    }
    appendPosition = existing.length;
  }
  const [created] = await createTasks([row], b.appendToQueue && appendPosition !== null
    ? async () => {
        await db.insert(queueItems).values({
          taskId,
          queueId: b.appendToQueue!,
          position: appendPosition!,
          createdAt: ts,
        });
      }
    : undefined);
  if (b.appendToQueue) {
    // 追加到队尾后立刻推进:若前序全 done,新 task 应立刻起跑
    void advanceQueue(b.appendToQueue);
  }
  return c.json(created!, 201);
});

// Partial update: title/body/status/pinnedAt/labels/groupId/agentType/executorId/model/reasoningEffort/mode/duet.
api.patch("/tasks/:id", async (c) => {
  const tid = c.req.param("id");
  const existing = (await db.select().from(tasks).where(eq(tasks.id, tid))).at(0);
  if (!existing) return c.json({ error: "not found" }, 404);
  // Archived = frozen/read-only. Editing (incl. status) is refused until the task
  // is unarchived (which goes through the dedicated endpoint, not PATCH).
  if (existing.archived) return c.json({ error: "任务已归档，先取消归档再编辑", archived: true }, 409);
  const b = await c.req.json<Partial<Task>>();
  // 运行中的 PATCH 既可能来自真人界面，也可能来自 agent 的 patch_task。真人客户端显式
  // 标记 user-action；MCP 则携带发起任务 id + 回合 token。校验的是「发起者当前仍是这
  // 一回合」，因此团队调度者可以跨任务改执行者，而被“引导会话”结束的旧单飞回合会被拒。
  let updateWhere: SQL = eq(tasks.id, tid);
  if ((existing.status === "running" || existing.status === "queued") && c.req.header("x-ash-user-action") !== "1") {
    const sourceTaskId = c.req.header("x-ash-source-task-id")?.trim() ?? "";
    const turnToken = c.req.header("x-ash-turn-token")?.trim() ?? "";
    if (sourceTaskId) {
      const source = (await db.select({
        mode: tasks.mode,
        status: tasks.status,
        activeTurnToken: tasks.activeTurnToken,
      }).from(tasks).where(eq(tasks.id, sourceTaskId))).at(0);
      if (!source) return c.json({ error: "PATCH 的发起任务不存在，已拒绝写入" }, 409);
      if (source.mode === "team") {
        if (source.status !== "running" && source.status !== "idle") {
          return c.json({ error: "团队调度者当前不在线，PATCH 已拒绝写入" }, 409);
        }
        updateWhere = and(
          eq(tasks.id, tid),
          eq(tasks.status, existing.status),
          sql`exists (select 1 from tasks as source_task where source_task.id = ${sourceTaskId} and source_task.mode = 'team' and source_task.status in ('running', 'idle'))`,
        )!;
      } else {
        if (source.status !== "running" || !source.activeTurnToken || turnToken !== source.activeTurnToken) {
          return c.json({ error: "PATCH 来自已结束的回合，已拒绝写入当前会话" }, 409);
        }
        updateWhere = and(
          eq(tasks.id, tid),
          eq(tasks.status, existing.status),
          sql`exists (select 1 from tasks as source_task where source_task.id = ${sourceTaskId} and source_task.status = 'running' and source_task.active_turn_token = ${source.activeTurnToken})`,
        )!;
      }
    } else {
      // 兼容已启动、尚未带 source-task-id 的本任务 MCP：仍须用目标任务的当前 token。
      if (!turnToken) {
        return c.json({
          error: "运行中的任务缺少 ash 回合身份；外部 MCP 客户端不能修改运行中任务，请等任务空闲后再试",
        }, 409);
      }
      if (!existing.activeTurnToken || turnToken !== existing.activeTurnToken) {
        return c.json({ error: "PATCH 来自已结束的回合，已拒绝写入当前会话" }, 409);
      }
      updateWhere = and(
        eq(tasks.id, tid),
        eq(tasks.status, existing.status),
        eq(tasks.activeTurnToken, existing.activeTurnToken),
      )!;
    }
  }
  // running/queued/awaiting_review are system-owned — refuse manual changes so a
  // human can't desync the state (e.g. mark a task "running" when nothing runs).
  if (b.status !== undefined && !isUserSettableStatus(b.status)) {
    return c.json({ error: "该状态由系统管理，不能手动设置", status: b.status }, 409);
  }
  // 反向守卫(2026-07-21 事故):对 running/queued 任务 PATCH status 只改数据库、
  // 不停进程 —— canceled 会立即推进队列(串行变并行),而活着的 agent 稍后调
  // complete_task 吃 409,结算再把 canceled 覆盖成 failed,一错三连。要打断
  // 运行中的任务必须走 POST /tasks/:id/stop(杀整棵进程树、由 run loop 结算)。
  if (b.status !== undefined && (existing.status === "running" || existing.status === "queued")) {
    return c.json(
      { error: "任务正在 running/queued，不能直接改状态——要停止/取消请用 stop_task（POST /tasks/:id/stop），它会终止整棵进程树并结算为 canceled", status: existing.status },
      409,
    );
  }
  // 接力出去的任务改 status 一律拦:改成 backlog/done 都会让「历史存档」重新参与
  // 队列推进或验收判定,与对端正在跑的那份分叉。其它字段(标题/标签/置顶)照常可改。
  if (b.status !== undefined) {
    const handedOff = handoffBlockReason(existing.handoff);
    if (handedOff) return c.json({ error: handedOff, handoff: true }, 409);
  }
  if (
    b.pinnedAt !== undefined &&
    b.pinnedAt !== null &&
    (!Number.isSafeInteger(b.pinnedAt) || b.pinnedAt < 0)
  ) {
    return c.json({ error: "pinnedAt 必须是非负整数时间戳或 null" }, 400);
  }
  if (
    b.starredAt !== undefined &&
    b.starredAt !== null &&
    (!Number.isSafeInteger(b.starredAt) || b.starredAt < 0)
  ) {
    return c.json({ error: "starredAt 必须是非负整数时间戳或 null" }, 400);
  }
  // UI 只给顶层任务画星标入口:child/worker 一旦被标上就成了看不见也清不掉的隐形状态。
  // null(清除)放行 —— 老数据里已有的 child 星标得留一条从 API 清理的路。
  if (b.starredAt !== undefined && b.starredAt !== null && existing.parentId != null) {
    return c.json({ error: "星标只支持顶层任务，执行者/子任务不能设置 starredAt" }, 400);
  }
  const patch: Record<string, unknown> = {};
  // 显式改名 = 这就是标题。不关掉 autoTitle 的话，一个还没跑过的任务被改名后，首轮
  // 起跑的自动命名（auto-title.ts）会把它悄悄覆盖回去 —— 智能体用 patch_task 改名尤其
  // 容易撞上。同一次请求里明说 autoTitle 的以那个为准（下一行照常覆盖）。
  if (b.title !== undefined) {
    patch.title = b.title;
    patch.autoTitle = false;
  }
  if (b.body !== undefined) patch.body = b.body;
  if (b.autoTitle !== undefined) patch.autoTitle = b.autoTitle;
  if (b.pinnedAt !== undefined) patch.pinnedAt = b.pinnedAt;
  if (b.starredAt !== undefined) patch.starredAt = b.starredAt;
  if (b.labels !== undefined) patch.labels = JSON.stringify(b.labels);
  if (b.groupId !== undefined) patch.groupId = b.groupId;
  const requestedExecutorId = b.executorId === "" ? null : b.executorId;
  const executorType = await agentTypeForExecutor(requestedExecutorId);
  if (executorType && b.agentType && b.agentType !== executorType) {
    return c.json({ error: `executorId 属于 ${executorType},但 agentType 是 ${b.agentType}`, executorId: requestedExecutorId }, 400);
  }
  if (b.agentType !== undefined) {
    patch.agentType = b.agentType;
    if (b.executorId === undefined) patch.executorId = null;
  }
  if (b.executorId !== undefined) {
    patch.executorId = requestedExecutorId ?? null;
    if (executorType && b.agentType === undefined) patch.agentType = executorType;
  }
  // 换执行器 = 旧的 model/思考强度覆盖作废（那套模型名多半在新 CLI 上根本不存在）。
  // 同一次 PATCH 里显式给了新值就用新值，没给就自动清空 —— 与创建路径同一条口径
  // （inheritExecutorOverrides，shared/src/executor-overrides.ts）。
  const beforeExecutor = { executorId: existing.executorId, agentType: existing.agentType as AgentType | null };
  const afterExecutor = {
    executorId: (patch.executorId !== undefined ? (patch.executorId as string | null) : existing.executorId) ?? null,
    agentType: ((patch.agentType !== undefined ? patch.agentType : existing.agentType) ?? null) as AgentType | null,
  };
  const patchedOverrides = inheritExecutorOverrides({
    from: beforeExecutor,
    to: afterExecutor,
    model: b.model,
    reasoningEffort: b.reasoningEffort,
    defaultModel: existing.model,
    defaultReasoningEffort: existing.reasoningEffort,
  });
  const executorChanged = !sameExecutor(beforeExecutor, afterExecutor);
  const finalType = afterExecutor.agentType;
  const normalizedEffort = finalType
    ? normalizeReasoningEffort(finalType, patchedOverrides.model, patchedOverrides.reasoningEffort)
    : patchedOverrides.reasoningEffort;
  if (
    finalType
    && b.reasoningEffort !== undefined
    && b.reasoningEffort
    && !isReasoningEffortSupported(finalType, patchedOverrides.model, b.reasoningEffort)
  ) {
    const allowed = reasoningEffortsFor(finalType, patchedOverrides.model);
    return c.json({
      error: `${finalType} 模型 ${patchedOverrides.model ?? "（跟随执行器）"} 不支持思考强度 ${b.reasoningEffort}`,
      allowedReasoningEfforts: allowed,
    }, 400);
  }
  if (b.model !== undefined || executorChanged) patch.model = patchedOverrides.model;
  if (b.reasoningEffort !== undefined || b.model !== undefined || executorChanged) patch.reasoningEffort = normalizedEffort;
  if (b.mode !== undefined) patch.mode = b.mode;
  if (b.duet !== undefined) patch.duet = b.duet ? JSON.stringify(b.duet) : null;
  // 注意:dependsOn / resumeDependsOn 不再可编辑:
  // 改顺序请用 /queues/:id/* 端点;调整队列归属请用 remove + insert/append。
  // resumePrompt：让用户编辑 agent 留下的续跑指令（写得不好就改、不想续跑就传空
  // 串清空）。"" / null 都映射为 null —— 跟 settleTaskStatus 检查保持一致。
  if (b.resumePrompt !== undefined) {
    patch.resumePrompt = b.resumePrompt && String(b.resumePrompt).trim() ? String(b.resumePrompt) : null;
  }
  // updatedAt 在产品里是「最后活动时间」:同组排序、24 小时折叠、未读完成/失败事件键、
  // 铺开态时间列都读它。星标是与活动正交的手动软记号 —— 只动 starredAt 的 PATCH 不推进
  // updatedAt,否则给旧任务点星会让它跳到组首、解除折叠、把已读终态伪装成新事件。
  // task.updated 事件照发(下方 publishTaskUpdated),前端仍实时回流。
  const starOnly = "starredAt" in patch && Object.keys(patch).length === 1 && b.status === undefined;
  if (!starOnly) patch.updatedAt = now();
  const written = await db.update(tasks).set(patch).where(updateWhere).returning({ id: tasks.id });
  if (!written.length) return c.json({ error: "任务或发起回合已经变化，PATCH 未写入" }, 409);
  // Status goes through the shared helper so manual changes maintain the run-time
  // columns (startedAt/endedAt) and broadcast them just like a real run does.
  // setTaskStatus 内部在 done/canceled 时会自动触发 queue 推进(DESIGN §3),
  // 所以这里不需要再手动 wake 下游。
  if (b.status !== undefined) {
    await setTaskStatus(tid, b.status);
  }
  const updated = await publishTaskUpdated(tid);
  return c.json(updated!);
});

// 这个任务在磁盘/仓库里还留着什么(worktree 目录、ash/<id8> 分支)。删除
// 确认框在打开时先问一次:有残留才提示「要不要连它们一起删」,没有就是一句普通
// 的确认。任务不在 worktree 模式下跑过也照查 —— useWorktree 后来被关掉、目录和
// 分支却还在,是最容易被漏掉的那种残留。
// children 一并探测：团队/duet 删除会连 children 行一起删，它们的 worktree/分支若不在
// 这里露脸，确认框就不会带清理参数，删完变成数据库里查无此任务的孤儿资源（审查实测：
// 父任务双 null、isolated child 有脏 worktree，请求根本不带清理参数）。
api.get("/tasks/:id/workspace", async (c) => {
  const tid = c.req.param("id");
  const t = (await db.select().from(tasks).where(eq(tasks.id, tid))).at(0);
  if (!t) return c.json({ error: "not found" }, 404);
  const project = (await db.select().from(projects).where(eq(projects.id, t.projectId))).at(0);
  const own = await detectTaskWorkspace(project?.repoPath, tid);
  const childRows = await db.select().from(tasks).where(eq(tasks.parentId, tid));
  const children = (await Promise.all(childRows.map(async (child) => ({
    taskId: child.id,
    title: child.title,
    ...(await detectTaskWorkspace(project?.repoPath, child.id)),
  })))).filter((entry) => entry.path || entry.branch);
  return c.json({ ...own, ...(children.length ? { children } : {}) });
});


// 删除任务。`worktree=1` / `branch=1` 表示用户在确认框里勾了「连 worktree 和分支
// 一起删」,`force=1` 是看过第一次失败之后的再来一次(--force / -D)。
//
// 顺序刻意是「先删任务行,再清 git」:删任务是用户的主要意图,git 那边失败(worktree
// 脏、分支未合并)不该把它一起挡回去 —— 结果原样回给 UI,由用户决定强制删还是留着。
api.delete("/tasks/:id", async (c) => {
  const tid = c.req.param("id");
  const existing = (await db.select().from(tasks).where(eq(tasks.id, tid))).at(0);
  // 正在执行的任务不能整行删掉：进程还活着、turn 还占着，删行会让回合结算写向不存在的
  // 任务（审查实测：claimTurn 到 status 落库的窗口里 DELETE 直接 200）。turn 锁一并看，
  // 常驻调度台 idle 时不受影响（status 不匹配、turn 未占）。
  if (existing && (existing.status === "running" || existing.status === "queued" || isTurnClaimed(tid))) {
    return c.json({ error: "任务正在执行，请先停止再删除", status: existing.status }, 409);
  }
  // 验收（含尾段发布命令）期间删除任务行：命令还在跑、结算还要写这一行（审查实测：
  // 删除返回 200、尾段继续写、验收最后还报成功）。
  if (existing && isAcceptingTask(tid)) {
    return c.json({ error: "任务正在验收中，结束后再删除" }, 409);
  }
  // 团队：执行者跟着 lead 活。任何 child 在飞就拒删（否则活着的 worker 失去父任务，
  // 还可能连带清掉它正在用的共享工作区）；都停了则连 children 行一并删，不留悬空 parentId。
  const children = existing ? await db.select().from(tasks).where(eq(tasks.parentId, tid)) : [];
  // child 的验收锁也要传播:执行者的发布尾段还在跑时删掉整个团队,结算会写向不存在
  // 的任务行(审查实测:child beginAccepting 后删除 lead 返回 200)。
  const busyChild = children.find(
    (child) => child.status === "running" || child.status === "queued"
      || isTurnClaimed(child.id) || isAcceptingTask(child.id),
  );
  if (busyChild) {
    return c.json({
      error: `执行者「${busyChild.title}」正在执行，请先停止团队再删除`,
      childId: busyChild.id,
      status: busyChild.status,
    }, 409);
  }
  const project = existing
    ? (await db.select().from(projects).where(eq(projects.id, existing.projectId))).at(0)
    : undefined;
  const wantWorktree = c.req.query("worktree") === "1";
  const wantBranch = c.req.query("branch") === "1";
  // children 的 Git 工作区必须与它们的行一起处理：只删行的话，独立 worktree/分支会变成
  // 数据库里查无此任务的孤儿资源，leftover 检测（按父任务 id）也看不到（审查实测）。
  const childCleanups: (TaskWorkspaceDiscardResult & { taskId: string })[] = [];
  for (const child of children) {
    await deleteTaskAssociations(child.id);
    await db.delete(tasks).where(eq(tasks.id, child.id));
    if (project && child.useWorktree && (wantWorktree || wantBranch)) {
      childCleanups.push({
        taskId: child.id,
        ...await discardTaskWorkspace(project.repoPath, child.id, {
          worktree: wantWorktree,
          branch: wantBranch,
          force: c.req.query("force") === "1",
        }),
      });
    }
  }
  await deleteTaskAssociations(tid);
  await db.delete(tasks).where(eq(tasks.id, tid));
  let cleanup: TaskWorkspaceDiscardResult | null = null;
  if (project && (wantWorktree || wantBranch)) {
    cleanup = await discardTaskWorkspace(project.repoPath, tid, {
      worktree: wantWorktree,
      branch: wantBranch,
      force: c.req.query("force") === "1",
    });
  }
  // 清理之后仍然剩下的东西:没勾选、或勾了但 git 拒绝。UI 据此决定要不要继续追问。
  // children 的残留一并报（它们的行已删，之后没有别的入口能发现这些资源）。
  const leftover = project ? await detectTaskWorkspace(project.repoPath, tid) : null;
  const childLeftovers = project
    ? (await Promise.all(children.map(async (child) => ({
        taskId: child.id,
        leftover: await detectTaskWorkspace(project.repoPath, child.id),
      })))).filter((entry) => entry.leftover && (entry.leftover.path || entry.leftover.branch))
    : [];
  return c.json({
    deleted: true, leftover, cleanup,
    // 连删的全部行（父 + children）：前端按它同步本地任务集合——只摘父 id 会把
    // children 留成刷新前的幽灵任务（审查实测）。
    deletedTaskIds: [tid, ...children.map((child) => child.id)],
    ...(childCleanups.length ? { childCleanups } : {}),
    ...(childLeftovers.length ? { childLeftovers } : {}),
  });
});

}

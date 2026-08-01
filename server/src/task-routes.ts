import type { AgentType, BatchCreateTasksBody, BatchTaskInput, Group, Task, TaskStatus, TaskWorkspaceDiscardResult } from "@harness/shared";
import { AGENT_TYPES, isUserSettableStatus } from "@harness/shared";
import { inheritExecutorOverrides, pickExecutor, sameExecutor } from "@harness/shared/executors";
import { asc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { db } from "./db/index.js";
import { agents, groups, noteTasks, projects, queueItems, tasks } from "./db/schema.js";
import { repoKey } from "./git.js";
import { detectTaskWorkspace, discardTaskWorkspace } from "./workspace-cleanup.js";
import { advanceQueue, pauseGroup, runGroup } from "./scheduler.js";
import { setTaskStatus } from "./status.js";
import { createTasks, enrichTasks, publishTaskUpdated } from "./task-store.js";
import { attachmentsPrompt, id, now } from "./util.js";

export function mountTaskRoutes(api: Hono): void {
  const agentTypeForExecutor = async (executorId?: string | null): Promise<AgentType | null> => {
    if (!executorId) return null;
    const row = (await db.select({ type: agents.type }).from(agents).where(eq(agents.id, executorId))).at(0);
    return row ? (row.type as AgentType) : null;
  };
  const taskBody = (body: string | undefined, taskId: string): string =>
    (body ?? "").replaceAll("{{TASK_ID}}", taskId);

// ── tasks ───────────────────────────────────────────────────────────────
api.get("/tasks", async (c) => {
  const rows = await db.select().from(tasks);
  return c.json(await enrichTasks(rows));
});

api.get("/tasks/:id", async (c) => {
  const rows = await db.select().from(tasks).where(eq(tasks.id, c.req.param("id")));
  const r = rows.at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  return c.json((await enrichTasks([r]))[0]);
});

api.post("/tasks", async (c) => {
  const b = await c.req.json<Partial<Task> & {
    projectId: string;
    title: string;
    attachments?: string[];
    appendToQueue?: string; // 可选:把新任务追加到指定 queue 的尾部
  }>();
  const derivationMode = b.mode === "team" || b.mode === "debate";
  if (derivationMode && b.parentId !== undefined && b.parentId !== null) {
    return c.json(
      { error: "派生执行者或审查任务不能再创建团队/辩论任务", parentId: b.parentId },
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
        { error: "派生执行者或审查任务不能再创建团队/辩论任务", originTaskId: b.originTaskId },
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
    priority: b.priority ?? "none",
    labels: JSON.stringify(b.labels ?? []),
    // dependsOn / resumeDependsOn 字段保留为 []。新模型用 queue_items
    // 表达顺序依赖(DESIGN-scheduling.md);input 上的这俩字段已不再接受。
    dependsOn: "[]",
    resumeDependsOn: "[]",
    agentType: b.agentType ?? (teamConfig ? teamConfig.lead : executorType) ?? null,
    executorId: b.executorId ?? null,
    model: b.model || null,
    reasoningEffort: b.reasoningEffort || null,
    autoTitle: b.autoTitle ?? false,
    debate: b.debate ? JSON.stringify(b.debate) : null,
    // mode:"team" 的调度者/默认执行者类型(跟 debate 对称)。别漏 —— 漏了就静默退回
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

// Partial update: title/body/status/pinnedAt/priority/labels/groupId/agentType/executorId/model/reasoningEffort/mode/debate.
api.patch("/tasks/:id", async (c) => {
  const tid = c.req.param("id");
  const existing = (await db.select().from(tasks).where(eq(tasks.id, tid))).at(0);
  if (!existing) return c.json({ error: "not found" }, 404);
  // Archived = frozen/read-only. Editing (incl. status) is refused until the task
  // is unarchived (which goes through the dedicated endpoint, not PATCH).
  if (existing.archived) return c.json({ error: "任务已归档，先取消归档再编辑", archived: true }, 409);
  const b = await c.req.json<Partial<Task>>();
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
  if (
    b.pinnedAt !== undefined &&
    b.pinnedAt !== null &&
    (!Number.isSafeInteger(b.pinnedAt) || b.pinnedAt < 0)
  ) {
    return c.json({ error: "pinnedAt 必须是非负整数时间戳或 null" }, 400);
  }
  const patch: Record<string, unknown> = { updatedAt: now() };
  if (b.title !== undefined) patch.title = b.title;
  if (b.body !== undefined) patch.body = b.body;
  if (b.autoTitle !== undefined) patch.autoTitle = b.autoTitle;
  if (b.pinnedAt !== undefined) patch.pinnedAt = b.pinnedAt;
  if (b.priority !== undefined) patch.priority = b.priority;
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
  if (b.model !== undefined || executorChanged) patch.model = patchedOverrides.model;
  if (b.reasoningEffort !== undefined || executorChanged) patch.reasoningEffort = patchedOverrides.reasoningEffort;
  if (b.mode !== undefined) patch.mode = b.mode;
  if (b.debate !== undefined) patch.debate = b.debate ? JSON.stringify(b.debate) : null;
  // 注意:dependsOn / resumeDependsOn 不再可编辑(DESIGN-scheduling.md):
  // 改顺序请用 /queues/:id/* 端点;调整队列归属请用 remove + insert/append。
  // resumePrompt：让用户编辑 agent 留下的续跑指令（写得不好就改、不想续跑就传空
  // 串清空）。"" / null 都映射为 null —— 跟 settleTaskStatus 检查保持一致。
  if (b.resumePrompt !== undefined) {
    patch.resumePrompt = b.resumePrompt && String(b.resumePrompt).trim() ? String(b.resumePrompt) : null;
  }
  await db.update(tasks).set(patch).where(eq(tasks.id, tid));
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

// 这个任务在磁盘/仓库里还留着什么(worktree 目录、harness/<id8> 分支)。删除
// 确认框在打开时先问一次:有残留才提示「要不要连它们一起删」,没有就是一句普通
// 的确认。任务不在 worktree 模式下跑过也照查 —— useWorktree 后来被关掉、目录和
// 分支却还在,是最容易被漏掉的那种残留。
api.get("/tasks/:id/workspace", async (c) => {
  const tid = c.req.param("id");
  const t = (await db.select().from(tasks).where(eq(tasks.id, tid))).at(0);
  if (!t) return c.json({ error: "not found" }, 404);
  const project = (await db.select().from(projects).where(eq(projects.id, t.projectId))).at(0);
  return c.json(await detectTaskWorkspace(project?.repoPath, tid));
});

// 删除任务。`worktree=1` / `branch=1` 表示用户在确认框里勾了「连 worktree 和分支
// 一起删」,`force=1` 是看过第一次失败之后的再来一次(--force / -D)。
//
// 顺序刻意是「先删任务行,再清 git」:删任务是用户的主要意图,git 那边失败(worktree
// 脏、分支未合并)不该把它一起挡回去 —— 结果原样回给 UI,由用户决定强制删还是留着。
api.delete("/tasks/:id", async (c) => {
  const tid = c.req.param("id");
  const existing = (await db.select().from(tasks).where(eq(tasks.id, tid))).at(0);
  const project = existing
    ? (await db.select().from(projects).where(eq(projects.id, existing.projectId))).at(0)
    : undefined;
  const wantWorktree = c.req.query("worktree") === "1";
  const wantBranch = c.req.query("branch") === "1";
  await db.delete(noteTasks).where(eq(noteTasks.taskId, tid));
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
  const leftover = project ? await detectTaskWorkspace(project.repoPath, tid) : null;
  return c.json({ deleted: true, leftover, cleanup });
});

// ── groups (transient batch containers, §3) ─────────────────────────────────
// List groups, optionally scoped to a project by `projectId` or — agent-friendly —
// by `repoPath` (canonical match, same as POST /groups). repoPath that resolves to
// no project yields an empty list (never creates anything). Shape is plain Group
// rows; the MCP layer enriches with a task rollup for "which group to run".
api.get("/groups", async (c) => {
  const pid = c.req.query("projectId");
  const repo = c.req.query("repoPath");
  const ownerTaskId = c.req.query("ownerTaskId");
  // 团队任务派活时自建的内部组(owner_task_id 非空)不在这里露脸 —— 它们是 §Team
  // 的内部结构(团队视图自己会展示执行者),混进用户的分组列表只会当噪音。
  // includeInternal=1 给调试/排查用。
  const includeInternal = c.req.query("includeInternal") === "1";
  let rows = await db.select().from(groups);
  if (ownerTaskId) rows = rows.filter((g) => g.ownerTaskId === ownerTaskId);
  else if (!includeInternal) rows = rows.filter((g) => !g.ownerTaskId);
  if (pid) rows = rows.filter((g) => g.projectId === pid);
  if (repo) {
    const key = repoKey(repo);
    const projIds = new Set(
      (await db.select().from(projects)).filter((p) => repoKey(p.repoPath) === key).map((p) => p.id),
    );
    rows = rows.filter((g) => projIds.has(g.projectId));
  }
  return c.json(rows);
});

// Run an entire group. Fresh starts honor dependsOn; paused checkpoint resumes
// honor resumeDependsOn. Running also clears a group pause, so the same button
// doubles as "继续/resume".
api.post("/groups/:id/run", async (c) => {
  const gid = c.req.param("id");
  const g = (await db.select().from(groups).where(eq(groups.id, gid))).at(0);
  if (!g) return c.json({ error: "not found" }, 404);
  if (g.paused) await db.update(groups).set({ paused: false }).where(eq(groups.id, gid));
  void runGroup(gid);
  return c.json({ started: true }, 202);
});

// Pause a group = halt the whole group now. The scheduler stops launching tasks
// that haven't started, the waiting (queued) tasks are parked back to backlog,
// AND any in-flight task is stopped too (its agent subprocess is killed → the run
// loop settles it as `paused`, NOT `canceled` — canceled 会被队列透明跳过,恢复时
// 就错启下一个了). Resuming the group (运行/继续) re-runs the parked tasks and
// resumes the paused one from its own CLI session — so pause loses no progress,
// it just freezes everything.
api.post("/groups/:id/pause", async (c) => {
  const gid = c.req.param("id");
  const g = (await db.select().from(groups).where(eq(groups.id, gid))).at(0);
  if (!g) return c.json({ error: "not found" }, 404);
  await pauseGroup(gid); // 与团队的「停止全组」共用同一份实现(scheduler.ts)
  const updated = (await db.select().from(groups).where(eq(groups.id, gid))).at(0)!;
  return c.json(updated);
});

// Batch-create single-mode tasks into an EXISTING group, agent-facing (§ interfaces).
// `chain:true` creates a queue with these tasks in array order (DESIGN-scheduling.md);
// arbitrary pairwise dependsOn between siblings is no longer supported (use chain
// or split into multiple batches). projectId 从 group 继承。可选 run 立即触发 runGroup。
api.post("/groups/:groupId/tasks/batch", async (c) => {
  const groupId = c.req.param("groupId");
  const g = (await db.select().from(groups).where(eq(groups.id, groupId))).at(0);
  if (!g) return c.json({ error: "group not found" }, 404);

  const b = await c.req.json<BatchCreateTasksBody>();
  const specs: BatchTaskInput[] = Array.isArray(b.tasks) ? b.tasks : [];
  if (specs.length === 0) return c.json({ error: "tasks 不能为空" }, 400);
  const profileTypes = new Map(
    (await db.select({ id: agents.id, type: agents.type }).from(agents)).map((a) => [a.id, a.type as AgentType] as const),
  );

  // Validate every agent type up front (task-level or inherited default) so we
  // fail the whole batch cleanly instead of half-inserting.
  //
  // 冲突只认「同一处显式给出的两者」(同一个 spec 里的 executorId + agentType,或
  // defaults 里的那对)。任务自己的 agentType 撞上**继承来的** defaults.executorId
  // 不是矛盾,而是「这个任务换类型」—— 按类型默认执行器降级,与 team dispatch 同口径。
  const defaultsExecutorType = b.defaults?.executorId ? profileTypes.get(b.defaults.executorId) : undefined;
  if (defaultsExecutorType && b.defaults?.agentType && defaultsExecutorType !== b.defaults.agentType) {
    return c.json({ error: `defaults.executorId 属于 ${defaultsExecutorType},但 defaults.agentType 是 ${b.defaults.agentType}`, executorId: b.defaults.executorId }, 400);
  }
  for (const [i, s] of specs.entries()) {
    const executorType = s.executorId ? profileTypes.get(s.executorId) : undefined;
    const at = s.agentType ?? b.defaults?.agentType ?? executorType ?? defaultsExecutorType;
    if (at && !AGENT_TYPES.includes(at)) {
      return c.json({ error: `tasks[${i}].agentType 未知: ${at}`, allowed: AGENT_TYPES }, 400);
    }
    if (executorType && s.agentType && s.agentType !== executorType) {
      return c.json({ error: `tasks[${i}].executorId 属于 ${executorType},但 agentType 是 ${s.agentType}`, executorId: s.executorId }, 400);
    }
  }

  // 拒绝 legacy 字段:本版本不再接受 dependsOn / resumeDependsOn(DESIGN-scheduling.md)。
  // 想串行就用 chain:true,想跨组依赖就用 queue API。
  for (const [i, s] of specs.entries()) {
    if (s.dependsOn?.length || s.resumeDependsOn?.length) {
      return c.json(
        {
          error: `tasks[${i}].dependsOn / resumeDependsOn 已废弃,请用 chain:true 表达顺序,或用 /queues/* 端点细调`,
        },
        400,
      );
    }
  }

  // chain:true 在 parallel group 上是自相矛盾(DESIGN §1.3:parallel group 无 queue)。
  if (b.chain && specs.length > 1 && g.mode === "parallel") {
    return c.json(
      {
        error: "chain:true 不能用于 parallel group:并行容器装不了串行队列。要串行请把 group 设为 serial,或不要传 chain。",
      },
      400,
    );
  }

  // Pre-generate ids (chain 用得到).
  const ids = specs.map(() => id());

  const firstLine = (body?: string) =>
    (body ?? "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 30) ?? "";

  // Distinct, increasing timestamps — UI 排序时序稳定。
  const base = Date.now();
  // 批次 defaults 里的 model/reasoningEffort 属于 defaults 那个执行器；任务自己换了
  // 执行器就不该继承（inheritExecutorOverrides 单点，与 team dispatch / PATCH 共用）。
  const defaultsRef = {
    executorId: b.defaults?.executorId ?? null,
    agentType: (b.defaults?.agentType ?? defaultsExecutorType ?? null) as AgentType | null,
  };
  const rows = specs.map((s, i) => {
    const explicitTitle = (s.title ?? "").trim();
    const ts = new Date(base + i).toISOString();
    const pick = pickExecutor({
      executorId: s.executorId,
      agentType: s.agentType,
      fallback: defaultsRef,
      typeOf: (eid) => profileTypes.get(eid),
    });
    const overrides = inheritExecutorOverrides({
      from: defaultsRef,
      to: pick,
      model: s.model,
      reasoningEffort: s.reasoningEffort,
      defaultModel: b.defaults?.model,
      defaultReasoningEffort: b.defaults?.reasoningEffort,
    });
    return {
      id: ids[i],
      projectId: g.projectId,
      groupId,
      parentId: null as string | null,
      title: explicitTitle || firstLine(s.body) || `任务 ${i + 1}`,
      body: taskBody(s.body, ids[i]),
      mode: "single",
      status: "backlog",
      priority: s.priority ?? b.defaults?.priority ?? "none",
      labels: JSON.stringify(s.labels ?? b.defaults?.labels ?? []),
      dependsOn: "[]", // 字段保留为空(legacy)
      resumeDependsOn: "[]",
      agentType: pick.agentType,
      executorId: pick.executorId,
      model: overrides.model,
      reasoningEffort: overrides.reasoningEffort,
      autoTitle: !explicitTitle, // no explicit title → let the first run name it
      debate: null as string | null,
      scheduleId: null as string | null,
      createdAt: ts,
      updatedAt: ts,
      // Task-level choice wins over batch defaults; if both are omitted,
      // createTasks resolves the global setting and enforces the git-repo guard.
      useWorktree: s.useWorktree !== undefined ? s.useWorktree : b.defaults?.useWorktree,
      worktreeBase:
        s.worktreeBase !== undefined ? s.worktreeBase : b.defaults?.worktreeBase ?? null,
    };
  });

  // chain:true → 创建一个 queue,把这批 task 按数组顺序加入(serial group 才走到这里)
  const queueId = b.chain && specs.length > 1 ? id() : null;
  const created = await createTasks(rows, queueId
    ? async () => {
        const qts = now();
        await db.insert(queueItems).values(
          ids.map((tid, i) => ({ taskId: tid, queueId, position: i, createdAt: qts })),
        );
      }
    : undefined);

  if (b.run) void runGroup(groupId);
  return c.json(
    { groupId, run: !!b.run, tasks: created },
    201,
  );
});

// Edit a group (name / parallel-serial).
api.patch("/groups/:id", async (c) => {
  const gid = c.req.param("id");
  const existing = (await db.select().from(groups).where(eq(groups.id, gid))).at(0);
  if (!existing) return c.json({ error: "not found" }, 404);
  const b = await c.req.json<Partial<Group>>();
  const patch: Record<string, unknown> = {};
  if (b.name !== undefined) {
    if (!b.name.trim()) return c.json({ error: "name required" }, 400);
    patch.name = b.name.trim();
  }
  if (b.mode !== undefined) patch.mode = b.mode;
  if (Object.keys(patch).length) await db.update(groups).set(patch).where(eq(groups.id, gid));
  const updated = (await db.select().from(groups).where(eq(groups.id, gid))).at(0)!;
  return c.json(updated);
});

// Delete a group. Tasks are NOT deleted — they're just ungrouped (groupId null).
api.delete("/groups/:id", async (c) => {
  const gid = c.req.param("id");
  await db.update(tasks).set({ groupId: null, updatedAt: now() }).where(eq(tasks.groupId, gid));
  await db.delete(groups).where(eq(groups.id, gid));
  return c.json({ deleted: true });
});

}

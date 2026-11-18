import type { AgentType, BatchCreateTasksBody, BatchTaskInput, Group, Task } from "@ash/shared";
import { AGENT_TYPES } from "@ash/shared";
import { CliCommandValidationError } from "@ash/shared/cli-commands";
import { inheritExecutorOverrides, pickExecutor } from "@ash/shared/executors";
import { createWorkflowMode } from "@ash/shared/free-workflow";
import { parseCreateReviewChoice, type CreateReviewChoice } from "@ash/shared/review-on-create";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { db } from "./db/index.js";
import { groups, projects, tasks } from "./db/schema.js";
import { serializeQueueClaims } from "./queue-claim-chain.js";
import { joinQueueOnCreate } from "./queue-membership-guard.js";
import { republishGroupWaits } from "./pending-wait.js";
import { repoKey } from "./git.js";
import { pauseGroup, runGroupInBackground } from "./scheduler.js";
import { writingGroupMembership } from "./launch-capacity.js";
import { createTasks } from "./task-store.js";
import { ReviewOnCreateError } from "./review-on-create.js";
import { id, taskBody } from "./util.js";
import { actorOf, ownerIdOf } from "./auth/context.js";
import { visibleProjectIds, visibleTaskIds } from "./auth/visibility.js";
import { batchPrerequisiteEdges, prerequisiteRefusal } from "./prerequisite-routes.js";
import { republishPrerequisiteView } from "./prerequisite-view.js";
import { executorScopeForOwner } from "./auth/owned-executors.js";
import { requestTaskCreationOrigin } from "./task-creation-origin.js";

// ── groups (transient batch containers, §3) ─────────────────────────────────
// 从 task-routes.ts 拆出的分组路由:列表/运行/暂停/批量建任务/编辑/删除。
export function mountGroupRoutes(api: Hono): void {

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
  const visible = await visibleProjectIds(actorOf(c));
  let rows = (await db.select().from(groups)).filter((g) => visible === null || visible.has(g.projectId));
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
  if (g.paused) {
    await db.update(groups).set({ paused: false }).where(eq(groups.id, gid));
    // 托盘上「分组已暂停」那几条要改口(pending-wait.ts)。
    void republishGroupWaits(gid).catch((err) => console.error(`[ash] republishGroupWaits(${gid}) failed:`, err));
  }
  void runGroupInBackground(gid);
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
// `chain:true` creates a queue with these tasks in array order;
// arbitrary pairwise dependsOn between siblings is no longer supported (use chain
// or split into multiple batches). projectId 从 group 继承。可选 run 立即触发 runGroup。
api.post("/groups/:groupId/tasks/batch", async (c) => {
  const groupId = c.req.param("groupId");
  const g = (await db.select().from(groups).where(eq(groups.id, groupId))).at(0);
  if (!g) return c.json({ error: "group not found" }, 404);

  const b = await c.req.json<BatchCreateTasksBody>();
  const specs: BatchTaskInput[] = Array.isArray(b.tasks) ? b.tasks : [];
  if (specs.length === 0) return c.json({ error: "tasks 不能为空" }, 400);
  // 「谁的活」(§八):批量入口没有父任务可继承,这一批全归调用方。
  const batchOwner = ownerIdOf(actorOf(c));
  // 执行器是个人面资源(§八):scope 锚在**归属人**(这条路上恰好就是调用方),看不见的 id
  // 归一成 null 走类型默认执行器降级 —— 与悬空 id 同一条口径(第 2 轮审查 P1)。
  // 锚在归属人而不是图省事按操作人:哪天这条路支持了 parentId,按操作人过滤会无声地
  // 变成错的 —— 建任务那条正是这么出的事(第 4 轮审查 P1)。
  const scope = await executorScopeForOwner(batchOwner);

  // Validate every agent type up front (task-level or inherited default) so we
  // fail the whole batch cleanly instead of half-inserting.
  //
  // 冲突只认「同一处显式给出的两者」(同一个 spec 里的 executorId + agentType,或
  // defaults 里的那对)。任务自己的 agentType 撞上**继承来的** defaults.executorId
  // 不是矛盾,而是「这个任务换类型」—— 按类型默认执行器降级,与 team dispatch 同口径。
  // `?? null`:defaults 是这批任务的兜底本身,「没配」和「配成空」在这里同义。
  const defaultsExecutorId = scope.keep(b.defaults?.executorId) ?? null;
  const defaultsExecutorType = scope.typeOf(defaultsExecutorId);
  if (defaultsExecutorType && b.defaults?.agentType && defaultsExecutorType !== b.defaults.agentType) {
    return c.json({ error: `defaults.executorId 属于 ${defaultsExecutorType},但 defaults.agentType 是 ${b.defaults.agentType}`, executorId: b.defaults.executorId }, 400);
  }
  for (const [i, s] of specs.entries()) {
    const executorType = scope.typeOf(scope.keep(s.executorId));
    const at = s.agentType ?? b.defaults?.agentType ?? executorType ?? defaultsExecutorType;
    if (at && !AGENT_TYPES.includes(at)) {
      return c.json({ error: `tasks[${i}].agentType 未知: ${at}`, allowed: AGENT_TYPES }, 400);
    }
    if (executorType && s.agentType && s.agentType !== executorType) {
      return c.json({ error: `tasks[${i}].executorId 属于 ${executorType},但 agentType 是 ${s.agentType}`, executorId: s.executorId }, 400);
    }
  }

  // 这一批每个任务走哪种工作方式。判据与 `POST /tasks` 是同一份（`createWorkflowMode`）：
  // 批量这条路建出来的全是顶层单任务，所以一律是自由工作流；要 preset 或带起手式的整批打回，
  // 不半插进去。
  for (const [i, s] of specs.entries()) {
    const resolved = createWorkflowMode({
      workflowMode: s.workflowMode ?? b.defaults?.workflowMode,
      workflowId: s.workflowId !== undefined ? s.workflowId : b.defaults?.workflowId ?? null,
    });
    if ("error" in resolved) return c.json({ error: `tasks[${i}]: ${resolved.error}` }, resolved.status);
  }

  // 建出来就带的审查预约(review-on-create.ts):任务自己的那一格优先,再看 defaults;都没给 = 不带
  // (MCP 那一侧缺省落成 "default",别的调用方不变)。形状不对整批打回。
  const reviews: (CreateReviewChoice | undefined)[] = [];
  for (const [i, s] of specs.entries()) {
    const review = parseCreateReviewChoice(s.review !== undefined ? s.review : b.defaults?.review, `tasks[${i}].review`);
    if (review && typeof review === "object" && "error" in review) return c.json({ error: review.error }, 400);
    reviews.push(review);
  }

  // 拒绝 legacy 字段:本版本不再接受 dependsOn / resumeDependsOn。
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
  // 前置：按 key 认同一批里的、认不出的当已有任务（prerequisite-routes.ts）。已有的要看得见。
  const prerequisites = batchPrerequisiteEdges(specs, ids, !!b.stack);
  if (typeof prerequisites === "string") return c.json({ error: prerequisites }, 400);
  const visible = new Set(await visibleTaskIds(actorOf(c), prerequisites.existing));
  const hidden = prerequisites.existing.find((taskId) => !visible.has(taskId));
  if (hidden) return c.json({ error: `前置任务 ${hidden} 不存在（同一批里的请用 key 指）` }, 404);

  const firstLine = (body?: string) =>
    (body ?? "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 30) ?? "";

  // Distinct, increasing timestamps — UI 排序时序稳定。
  const base = Date.now();
  // 批次 defaults 里的 model/reasoningEffort 属于 defaults 那个执行器；任务自己换了
  // 执行器就不该继承（inheritExecutorOverrides 单点，与 team dispatch / PATCH 共用）。
  const defaultsRef = {
    executorId: defaultsExecutorId,
    agentType: (b.defaults?.agentType ?? defaultsExecutorType ?? null) as AgentType | null,
  };
  const creationOrigin = await requestTaskCreationOrigin(c);
  const rows = specs.map((s, i) => {
    const explicitTitle = (s.title ?? "").trim();
    const ts = new Date(base + i).toISOString();
    const pick = pickExecutor({
      // 不能 `?? null`:任务没带 executorId 时要让 pickExecutor 看见 undefined,
      // 它才会整份继承 defaultsRef(连同 defaults.model / reasoningEffort)。
      executorId: scope.keep(s.executorId),
      agentType: s.agentType,
      fallback: defaultsRef,
      typeOf: (eid) => scope.typeOf(eid),
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
      creationOrigin,
      projectId: g.projectId,
      groupId,
      parentId: null as string | null,
      title: explicitTitle || firstLine(s.body) || `任务 ${i + 1}`,
      body: taskBody(s.body, ids[i]),
      mode: "single",
      status: "backlog",
      labels: JSON.stringify(s.labels ?? b.defaults?.labels ?? []),
      dependsOn: "[]", // 字段保留为空(legacy)
      resumeDependsOn: "[]",
      agentType: pick.agentType,
      executorId: pick.executorId,
      model: overrides.model,
      reasoningEffort: overrides.reasoningEffort,
      autoTitle: !explicitTitle, // no explicit title → let the first run name it
      duet: null as string | null,
      scheduleId: null as string | null,
      createdAt: ts,
      updatedAt: ts,
      // Task-level choice wins over batch defaults; if both are omitted,
      // createTasks resolves the global setting and enforces the git-repo guard.
      useWorktree: s.useWorktree !== undefined ? s.useWorktree : b.defaults?.useWorktree,
      worktreeBase:
        s.worktreeBase !== undefined ? s.worktreeBase : b.defaults?.worktreeBase ?? null,
      mergeTargetBranch: s.mergeTargetBranch ?? b.defaults?.mergeTargetBranch ?? null,
      workflowMode: "free",
      ownerUserId: batchOwner,
      review: reviews[i],
    };
  });

  // chain:true → 创建一个 queue,把这批 task 按数组顺序加入(serial group 才走到这里)
  const queueId = b.chain && specs.length > 1 ? id() : null;
  let created: Task[];
  try {
    // 任务行与队列成员同一笔事务在链上落库(createTasks 的 `atomic.after`):先插行后串队的话,
    // 中间那一拍里另一处分组运行就能把队尾那几条当独立任务先起了。
    created = await createTasks(rows, undefined, undefined, [], prerequisites.edges,
      queueId ? { after: joinQueueOnCreate(queueId, ids, { existing: false }) } : undefined);
  } catch (error) {
    if (error instanceof CliCommandValidationError || error instanceof ReviewOnCreateError) return c.json({ error: error.message }, 400);
    const refused = prerequisiteRefusal(error);
    if (refused) return c.json(refused.body, refused.status);
    throw error;
  }
  // 已有的前置那边也多了「谁建在它上面」。
  if (prerequisites.existing.length) await republishPrerequisiteView(prerequisites.existing);

  if (b.run) void runGroupInBackground(groupId);
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
  // 摘出分组 = 改 groupId,归属写方进队列认领链(queue-claim-chain.ts);摘出与删组同一笔事务,
  // 链上改分组的那一笔(groupMoveRefusal 重验目标组还在)就不会落在两者之间、把任务挂回一个刚删掉的组。
  // 跟 task-refs.ts 同一口径:摘出不碰 updatedAt。
  // 摘出来的成员里可能有正占着执行回合的：同组名额按分组数，这一笔要让数名额的那一边看得见（launch-capacity.ts）。
  await serializeQueueClaims(() => writingGroupMembership(() => db.transaction(async (tx) => {
    await tx.update(tasks).set({ groupId: null }).where(eq(tasks.groupId, gid));
    await tx.delete(groups).where(eq(groups.id, gid));
  })));
  return c.json({ deleted: true });
});

}

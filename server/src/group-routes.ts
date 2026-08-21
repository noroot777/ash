import type { AgentType, BatchCreateTasksBody, BatchTaskInput, Group } from "@ash/shared";
import { AGENT_TYPES } from "@ash/shared";
import { inheritExecutorOverrides, pickExecutor } from "@ash/shared/executors";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { db } from "./db/index.js";
import { agents, groups, projects, queueItems, tasks } from "./db/schema.js";
import { repoKey } from "./git.js";
import { pauseGroup, runGroup } from "./scheduler.js";
import { createTasks } from "./task-store.js";
import { id, now, taskBody } from "./util.js";

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
      workflowId: s.workflowId !== undefined ? s.workflowId : b.defaults?.workflowId ?? null,
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

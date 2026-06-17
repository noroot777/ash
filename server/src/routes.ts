import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join, basename } from "node:path";
import { RUNS_DIR, DATA_DIR } from "./paths.js";
import type {
  Project,
  ProjectView,
  Group,
  Task,
  Session,
  TaskStatus,
} from "@harness/shared";
import { canStartTask, isUserSettableStatus, AGENT_TYPES } from "@harness/shared";
import { db } from "./db/index.js";
import { projects, groups, tasks, sessions, schedules, agents } from "./db/schema.js";
import { bus } from "./bus.js";
import { id, now } from "./util.js";
import { runTask, continueTask } from "./orchestrator.js";
import { runGroup } from "./scheduler.js";
import { runDebate, resumeDebate, resumeAtGate } from "./debate/index.js";
import { resolveGate } from "./debate/gates.js";
import { detectLocalAgents } from "./detect.js";
import { projectHealthLight, projectHealthFull, removeWorktree } from "./git.js";
import { resumeCommandFor } from "./executors/spawn.js";
import type { GateAction, AgentType, BatchCreateTasksBody, BatchTaskInput } from "@harness/shared";

export const api = new Hono();

// ── health ───────────────────────────────────────────────────────────────
api.get("/health", (c) => c.json({ ok: true, ts: now() }));

// ── agents (executor registry, §5) ───────────────────────────────────────────
const toAgent = (r: typeof agents.$inferSelect) => ({
  id: r.id,
  name: r.name,
  type: r.type,
  target: JSON.parse(r.target),
  model: r.model ?? undefined,
  extraArgs: JSON.parse(r.extraArgs),
  isDefault: r.isDefault,
});

api.get("/agents", async (c) => c.json((await db.select().from(agents)).map(toAgent)));

// Detect which agent CLIs are installed on the local machine (§5).
api.get("/agents/detect", async (c) => c.json(await detectLocalAgents()));

api.post("/agents", async (c) => {
  const b = await c.req.json<any>();
  const row = {
    id: id(),
    name: b.name,
    type: b.type,
    target: JSON.stringify(b.target ?? { kind: "local" }),
    model: b.model ?? null,
    extraArgs: JSON.stringify(b.extraArgs ?? []),
    isDefault: !!b.isDefault,
  };
  // a type has at most one default
  if (row.isDefault) await db.update(agents).set({ isDefault: false }).where(eq(agents.type, row.type));
  await db.insert(agents).values(row);
  return c.json(toAgent(row as typeof agents.$inferSelect), 201);
});

api.patch("/agents/:id", async (c) => {
  const aid = c.req.param("id");
  const existing = (await db.select().from(agents).where(eq(agents.id, aid))).at(0);
  if (!existing) return c.json({ error: "not found" }, 404);
  const b = await c.req.json<any>();
  const patch: Record<string, unknown> = {};
  if (b.name !== undefined) patch.name = b.name;
  if (b.model !== undefined) patch.model = b.model || null;
  if (b.target !== undefined) patch.target = JSON.stringify(b.target);
  if (b.extraArgs !== undefined) patch.extraArgs = JSON.stringify(b.extraArgs);
  if (b.isDefault === true) {
    await db.update(agents).set({ isDefault: false }).where(eq(agents.type, existing.type));
    patch.isDefault = true;
  }
  await db.update(agents).set(patch).where(eq(agents.id, aid));
  const updated = (await db.select().from(agents).where(eq(agents.id, aid))).at(0)!;
  return c.json(toAgent(updated));
});

api.delete("/agents/:id", async (c) => {
  await db.delete(agents).where(eq(agents.id, c.req.param("id")));
  return c.json({ deleted: true });
});

// ── row -> domain mappers (parse json columns) ─────────────────────────────
const toTask = (r: typeof tasks.$inferSelect): Task => ({
  id: r.id,
  projectId: r.projectId,
  groupId: r.groupId,
  parentId: r.parentId,
  title: r.title,
  body: r.body,
  mode: r.mode as Task["mode"],
  status: r.status as TaskStatus,
  priority: r.priority as Task["priority"],
  labels: JSON.parse(r.labels),
  dependsOn: JSON.parse(r.dependsOn),
  agentType: (r.agentType as Task["agentType"]) ?? undefined,
  autoTitle: r.autoTitle,
  debate: r.debate ? JSON.parse(r.debate) : undefined,
  scheduleId: r.scheduleId,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const toSession = (r: typeof sessions.$inferSelect): Session => ({
  ...r,
  role: r.role as Session["role"],
  agentType: r.agentType as Session["agentType"],
  // Recompute the copy-paste resume command from the session's own fields, so it
  // always reflects the current format (old rows stored a now-outdated string).
  resumeCommand: r.cliSessionId
    ? resumeCommandFor(r.agentType, r.target, r.cwd ?? r.worktreePath ?? ".", r.cliSessionId)
    : r.resumeCommand,
});

// ── projects ───────────────────────────────────────────────────────────────
// repoPath health is computed, never persisted (§ path-awareness). The list
// uses the cheap sync check; per-id and path-check endpoints do the full git probe.
const toProject = (r: typeof projects.$inferSelect): ProjectView => ({
  ...r,
  health: projectHealthLight(r.repoPath),
});

api.get("/projects", async (c) =>
  c.json((await db.select().from(projects)).map(toProject)),
);

api.post("/projects", async (c) => {
  const b = await c.req.json<{ name: string; repoPath: string }>();
  if (!b.name?.trim()) return c.json({ error: "name required" }, 400);
  const row = { id: id(), name: b.name.trim(), repoPath: b.repoPath ?? "", createdAt: now() };
  await db.insert(projects).values(row);
  return c.json(toProject(row), 201);
});

// Find-or-create a project by repoPath — idempotent, agent-friendly. Lets an agent
// go straight from a repo path to a stable projectId without first listing/creating
// (call it every time without worrying about duplicates). name defaults to the
// repo's directory name. Ambiguous (repoPath used by >1 project) → 409, so the
// caller falls back to an explicit projectId. 200 = existing, 201 = created.
api.post("/projects/resolve", async (c) => {
  const b = await c.req.json<{ repoPath: string; name?: string }>();
  const repoPath = b.repoPath?.trim();
  if (!repoPath) return c.json({ error: "repoPath required" }, 400);
  const hits = (await db.select().from(projects)).filter((p) => p.repoPath === repoPath);
  if (hits.length > 1) return c.json({ error: "repoPath 匹配到多个项目，请改用 projectId", repoPath }, 409);
  if (hits.length === 1) return c.json(toProject(hits[0]), 200);
  const name = b.name?.trim() || basename(repoPath.replace(/\/+$/, "")) || "project";
  const row = { id: id(), name, repoPath, createdAt: now() };
  await db.insert(projects).values(row);
  return c.json(toProject(row), 201);
});

api.patch("/projects/:id", async (c) => {
  const pid = c.req.param("id");
  const existing = (await db.select().from(projects).where(eq(projects.id, pid))).at(0);
  if (!existing) return c.json({ error: "not found" }, 404);
  const b = await c.req.json<Partial<Project>>();
  const patch: Record<string, unknown> = {};
  if (b.name !== undefined) {
    if (!b.name.trim()) return c.json({ error: "name required" }, 400);
    patch.name = b.name.trim();
  }
  if (b.repoPath !== undefined) patch.repoPath = b.repoPath;
  if (Object.keys(patch).length) await db.update(projects).set(patch).where(eq(projects.id, pid));
  const updated = (await db.select().from(projects).where(eq(projects.id, pid))).at(0)!;
  return c.json(toProject(updated));
});

// Full delete: cascade tasks → their sessions/schedules/run-artifacts/worktrees,
// then groups, then the project. Refuses while any task is live (§ safety).
api.delete("/projects/:id", async (c) => {
  const pid = c.req.param("id");
  const ptasks = await db.select().from(tasks).where(eq(tasks.projectId, pid));
  const live = ptasks.find((t) => t.status === "running" || t.status === "queued");
  if (live) return c.json({ error: "项目有正在运行/排队的任务，无法删除", taskId: live.id }, 409);
  const project = (await db.select().from(projects).where(eq(projects.id, pid))).at(0);
  for (const t of ptasks) {
    await db.delete(sessions).where(eq(sessions.taskId, t.id));
    await db.delete(schedules).where(eq(schedules.taskId, t.id));
    rmSync(join(RUNS_DIR, t.id), { recursive: true, force: true });
    rmSync(join(DATA_DIR, "scratch", t.id), { recursive: true, force: true });
    if (project?.repoPath) await removeWorktree(project.repoPath, t.id);
  }
  await db.delete(tasks).where(eq(tasks.projectId, pid));
  await db.delete(groups).where(eq(groups.projectId, pid));
  await db.delete(projects).where(eq(projects.id, pid));
  return c.json({ deleted: true });
});

// Health probes: by id (settings panel) and by raw path (validate unsaved input).
api.get("/projects/:id/health", async (c) => {
  const p = (await db.select().from(projects).where(eq(projects.id, c.req.param("id")))).at(0);
  if (!p) return c.json({ error: "not found" }, 404);
  return c.json(await projectHealthFull(p.repoPath));
});

api.post("/projects/check", async (c) => {
  const b = await c.req.json<{ repoPath: string }>();
  return c.json(await projectHealthFull(b.repoPath));
});

// ── groups ───────────────────────────────────────────────────────────────
// Create a group inside a project — the entry point an agent calls first to get
// a groupId for the batch endpoint. The project is resolved by `projectId` or,
// more agent-friendly, by `repoPath` (agents know the repo, not the internal id).
// We validate it exists so a group is never orphaned under a bad project id.
api.post("/groups", async (c) => {
  const b = await c.req.json<Partial<Group> & { projectId?: string; name: string; repoPath?: string }>();
  if (!b.name?.trim()) return c.json({ error: "name required" }, 400);
  if (b.mode && b.mode !== "parallel" && b.mode !== "serial") {
    return c.json({ error: `mode 非法: ${b.mode}（只能是 parallel | serial）` }, 400);
  }

  let project;
  if (b.projectId) {
    project = (await db.select().from(projects).where(eq(projects.id, b.projectId))).at(0);
    if (!project) return c.json({ error: "project not found", projectId: b.projectId }, 404);
  } else if (b.repoPath) {
    const hits = (await db.select().from(projects)).filter((p) => p.repoPath === b.repoPath);
    if (hits.length === 0) return c.json({ error: "没有匹配 repoPath 的项目（可先调用 POST /api/projects/resolve 建项目）", repoPath: b.repoPath }, 404);
    if (hits.length > 1) return c.json({ error: "repoPath 匹配到多个项目，请改用 projectId", repoPath: b.repoPath }, 409);
    project = hits[0];
  } else {
    return c.json({ error: "需要 projectId 或 repoPath 来定位项目" }, 400);
  }

  const row = {
    id: id(),
    projectId: project.id,
    name: b.name.trim(),
    mode: b.mode ?? "parallel",
    useWorktree: b.useWorktree ?? true,
    createdAt: now(),
  };
  await db.insert(groups).values(row);
  return c.json(row, 201);
});

// ── tasks ───────────────────────────────────────────────────────────────
api.get("/tasks", async (c) => {
  const rows = await db.select().from(tasks);
  return c.json(rows.map(toTask));
});

api.get("/tasks/:id", async (c) => {
  const rows = await db.select().from(tasks).where(eq(tasks.id, c.req.param("id")));
  const r = rows.at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  return c.json(toTask(r));
});

api.post("/tasks", async (c) => {
  const b = await c.req.json<Partial<Task> & { projectId: string; title: string }>();
  const ts = now();
  const row = {
    id: id(),
    projectId: b.projectId,
    groupId: b.groupId ?? null,
    parentId: b.parentId ?? null,
    title: b.title,
    body: b.body ?? "",
    mode: b.mode ?? "single",
    status: (b.status && isUserSettableStatus(b.status) ? b.status : "backlog") as TaskStatus,
    priority: b.priority ?? "none",
    labels: JSON.stringify(b.labels ?? []),
    dependsOn: JSON.stringify(b.dependsOn ?? []),
    agentType: b.agentType ?? null,
    autoTitle: b.autoTitle ?? false,
    debate: b.debate ? JSON.stringify(b.debate) : null,
    scheduleId: null,
    createdAt: ts,
    updatedAt: ts,
  };
  await db.insert(tasks).values(row);
  return c.json(toTask(row as typeof tasks.$inferSelect), 201);
});

// Partial update: title/body/status/priority/labels/groupId/agentType/mode/debate.
api.patch("/tasks/:id", async (c) => {
  const tid = c.req.param("id");
  const existing = (await db.select().from(tasks).where(eq(tasks.id, tid))).at(0);
  if (!existing) return c.json({ error: "not found" }, 404);
  const b = await c.req.json<Partial<Task>>();
  // running/queued/awaiting_review are system-owned — refuse manual changes so a
  // human can't desync the state (e.g. mark a task "running" when nothing runs).
  if (b.status !== undefined && !isUserSettableStatus(b.status)) {
    return c.json({ error: "该状态由系统管理，不能手动设置", status: b.status }, 409);
  }
  const patch: Record<string, unknown> = { updatedAt: now() };
  if (b.title !== undefined) patch.title = b.title;
  if (b.body !== undefined) patch.body = b.body;
  if (b.autoTitle !== undefined) patch.autoTitle = b.autoTitle;
  if (b.status !== undefined) patch.status = b.status;
  if (b.priority !== undefined) patch.priority = b.priority;
  if (b.labels !== undefined) patch.labels = JSON.stringify(b.labels);
  if (b.groupId !== undefined) patch.groupId = b.groupId;
  if (b.agentType !== undefined) patch.agentType = b.agentType;
  if (b.mode !== undefined) patch.mode = b.mode;
  if (b.debate !== undefined) patch.debate = b.debate ? JSON.stringify(b.debate) : null;
  await db.update(tasks).set(patch).where(eq(tasks.id, tid));
  if (b.status !== undefined) bus.publish({ type: "task.status", taskId: tid, status: b.status });
  const updated = (await db.select().from(tasks).where(eq(tasks.id, tid))).at(0)!;
  return c.json(toTask(updated));
});

api.delete("/tasks/:id", async (c) => {
  await db.delete(tasks).where(eq(tasks.id, c.req.param("id")));
  return c.json({ deleted: true });
});

// ── groups (transient batch containers, §3) ─────────────────────────────────
api.get("/groups", async (c) => {
  const pid = c.req.query("projectId");
  const rows = pid
    ? await db.select().from(groups).where(eq(groups.projectId, pid))
    : await db.select().from(groups);
  return c.json(rows);
});

// Run an entire group honoring parallel/serial + dependsOn (§1/§3).
api.post("/groups/:id/run", async (c) => {
  const gid = c.req.param("id");
  const g = (await db.select().from(groups).where(eq(groups.id, gid))).at(0);
  if (!g) return c.json({ error: "not found" }, 404);
  void runGroup(gid);
  return c.json({ started: true }, 202);
});

// Batch-create single-mode tasks into an EXISTING group, agent-facing (§ interfaces).
// The caller passes a list of tasks; we pre-generate their ids so dependency edges
// can reference siblings *by local key* (the real ids don't exist at call time),
// and `chain:true` is sugar that wires A→B→C→D in array order. projectId is
// inherited from the group. Optionally fires the group (runGroup) right after.
api.post("/groups/:groupId/tasks/batch", async (c) => {
  const groupId = c.req.param("groupId");
  const g = (await db.select().from(groups).where(eq(groups.id, groupId))).at(0);
  if (!g) return c.json({ error: "group not found" }, 404);

  const b = await c.req.json<BatchCreateTasksBody>();
  const specs: BatchTaskInput[] = Array.isArray(b.tasks) ? b.tasks : [];
  if (specs.length === 0) return c.json({ error: "tasks 不能为空" }, 400);

  // Validate every agent type up front (task-level or inherited default) so we
  // fail the whole batch cleanly instead of half-inserting.
  for (const [i, s] of specs.entries()) {
    const at = s.agentType ?? b.defaults?.agentType;
    if (at && !AGENT_TYPES.includes(at)) {
      return c.json({ error: `tasks[${i}].agentType 未知: ${at}`, allowed: AGENT_TYPES }, 400);
    }
  }

  // Pre-generate ids; map each declared local key → its id for dependency resolution.
  const ids = specs.map(() => id());
  const keyToId = new Map<string, string>();
  specs.forEach((s, i) => { if (s.key) keyToId.set(s.key, ids[i]); });

  const firstLine = (body?: string) =>
    (body ?? "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 30) ?? "";

  // Distinct, increasing timestamps so serial-mode ordering (sorted by createdAt)
  // is stable too — not only the parallel-mode dependsOn path.
  const base = Date.now();
  const rows = specs.map((s, i) => {
    const explicitTitle = (s.title ?? "").trim();
    // dependsOn: sibling key → its id; otherwise treat as an existing task id.
    const deps = new Set((s.dependsOn ?? []).map((d) => keyToId.get(d) ?? d));
    if (b.chain && i > 0) deps.add(ids[i - 1]);
    const ts = new Date(base + i).toISOString();
    return {
      id: ids[i],
      projectId: g.projectId,
      groupId,
      parentId: null as string | null,
      title: explicitTitle || firstLine(s.body) || `任务 ${i + 1}`,
      body: s.body ?? "",
      mode: "single",
      status: "backlog",
      priority: s.priority ?? b.defaults?.priority ?? "none",
      labels: JSON.stringify(s.labels ?? b.defaults?.labels ?? []),
      dependsOn: JSON.stringify([...deps]),
      agentType: (s.agentType ?? b.defaults?.agentType ?? null) as AgentType | null,
      autoTitle: !explicitTitle, // no explicit title → let the first run name it
      debate: null as string | null,
      scheduleId: null as string | null,
      createdAt: ts,
      updatedAt: ts,
    };
  });

  await db.insert(tasks).values(rows);
  if (b.run) void runGroup(groupId);
  return c.json(
    { groupId, run: !!b.run, tasks: rows.map((r) => toTask(r as typeof tasks.$inferSelect)) },
    201,
  );
});

// Edit a group (name / parallel-serial / worktree isolation).
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
  if (b.useWorktree !== undefined) patch.useWorktree = b.useWorktree;
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

// ── sessions (traceability credentials, §13) ───────────────────────────────
api.get("/tasks/:id/sessions", async (c) => {
  const rows = await db.select().from(sessions).where(eq(sessions.taskId, c.req.param("id")));
  return c.json(rows.map(toSession));
});

// Persisted output of a session (for reloads; live output comes via SSE).
api.get("/sessions/:id/output", async (c) => {
  const sid = c.req.param("id");
  const row = (await db.select().from(sessions).where(eq(sessions.id, sid))).at(0);
  if (!row) return c.json({ error: "not found" }, 404);
  try {
    const text = await readFile(join(RUNS_DIR, row.taskId, `${sid}.md`), "utf8");
    return c.text(text);
  } catch {
    return c.text("");
  }
});

// Persisted debate transcript (rebuilds the timeline on reload, §12).
api.get("/tasks/:id/debate", async (c) => {
  try {
    const raw = await readFile(join(RUNS_DIR, c.req.param("id"), "transcript.jsonl"), "utf8");
    const turns = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    return c.json(turns);
  } catch {
    return c.json([]);
  }
});

// ── run a task (§1/§12) ─────────────────────────────────────────────────────
api.post("/tasks/:id/run", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  // Guard the state machine: only settled, non-terminal-success tasks may start.
  if (!canStartTask(r.status as TaskStatus)) return c.json({ error: "任务当前状态不可运行", status: r.status }, 409);
  // Fire-and-forget; progress streams over /api/events.
  if (r.mode === "debate") void runDebate(taskId);
  else void runTask(taskId);
  return c.json({ started: true }, 202);
});

// Reply to a single task: resume its CLI session with the user's message so an
// agent that stopped to ask can be answered and keep going (same session).
api.post("/tasks/:id/reply", async (c) => {
  const taskId = c.req.param("id");
  const b = await c.req.json<{ text: string }>();
  if (!b.text?.trim()) return c.json({ error: "empty" }, 400);
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.mode !== "single") return c.json({ error: "仅单任务支持回复" }, 409);
  if (r.status === "running" || r.status === "queued") return c.json({ error: "任务进行中" }, 409);
  void continueTask(taskId, b.text.trim());
  return c.json({ started: true }, 202);
});

// Retry a failed debate: re-run only the failed (last) turn, then continue —
// instead of re-running the whole debate. Single tasks just re-run.
api.post("/tasks/:id/retry", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.status !== "failed") return c.json({ error: "只有失败的任务可以重试", status: r.status }, 409);
  if (r.mode === "debate") void resumeDebate(taskId);
  else void runTask(taskId);
  return c.json({ started: true }, 202);
});

// ── HITL gate decision (§7) — 放行 / 打回 / 注入意见 / 提问 ───────────────────
api.post("/tasks/:id/gate", async (c) => {
  const taskId = c.req.param("id");
  const action = await c.req.json<GateAction>();
  if (resolveGate(taskId, action)) return c.json({ ok: true });
  // No in-memory gate (e.g. the server restarted). If the task is still awaiting
  // a decision, resume the debate from the gate and apply the action.
  const t = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (t?.status === "awaiting_review" && t.mode === "debate") {
    void resumeAtGate(taskId, action);
    return c.json({ ok: true, resumed: true });
  }
  return c.json({ error: "no open gate for this task" }, 409);
});

// ── schedules (§9) — one schedule per task ──────────────────────────────────
api.get("/tasks/:id/schedule", async (c) => {
  const row = (await db.select().from(schedules).where(eq(schedules.taskId, c.req.param("id")))).at(0);
  return c.json(row ?? null);
});

api.put("/tasks/:id/schedule", async (c) => {
  const taskId = c.req.param("id");
  const b = await c.req.json<{ kind: "once" | "cron"; at?: string | null; cron?: string | null; enabled?: boolean }>();
  const existing = (await db.select().from(schedules).where(eq(schedules.taskId, taskId))).at(0);
  const row = {
    id: existing?.id ?? id(),
    taskId,
    kind: b.kind,
    at: b.at ?? null,
    cron: b.cron ?? null,
    enabled: b.enabled ?? true,
    lastRunAt: null,
    createdAt: existing?.createdAt ?? now(),
  };
  if (existing) await db.update(schedules).set(row).where(eq(schedules.id, existing.id));
  else await db.insert(schedules).values(row);
  await db.update(tasks).set({ scheduleId: row.id, updatedAt: now() }).where(eq(tasks.id, taskId));
  return c.json(row);
});

api.delete("/tasks/:id/schedule", async (c) => {
  await db.delete(schedules).where(eq(schedules.taskId, c.req.param("id")));
  await db.update(tasks).set({ scheduleId: null, updatedAt: now() }).where(eq(tasks.id, c.req.param("id")));
  return c.json({ deleted: true });
});

// ── SSE stream (§12) ───────────────────────────────────────────────────────
api.get("/events", (c) =>
  streamSSE(c, async (stream) => {
    const unsub = bus.subscribe((ev) => {
      stream.writeSSE({ data: JSON.stringify(ev) }).catch(() => {});
    });
    stream.onAbort(() => {
      unsub();
    });
    try {
      while (!stream.aborted) {
        await stream.writeSSE({ event: "ping", data: "1" });
        await stream.sleep(15000);
      }
    } catch {
      /* client disconnected mid-write — expected on page refresh */
    } finally {
      unsub();
    }
  }),
);

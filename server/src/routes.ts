import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Project,
  Group,
  Task,
  Session,
  TaskStatus,
} from "@harness/shared";
import { db } from "./db/index.js";
import { projects, groups, tasks, sessions } from "./db/schema.js";
import { bus } from "./bus.js";
import { id, now } from "./util.js";
import { runTask } from "./orchestrator.js";
import { runGroup } from "./scheduler.js";

export const api = new Hono();

// ── health ───────────────────────────────────────────────────────────────
api.get("/health", (c) => c.json({ ok: true, ts: now() }));

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
  debate: r.debate ? JSON.parse(r.debate) : undefined,
  scheduleId: r.scheduleId,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const toSession = (r: typeof sessions.$inferSelect): Session => ({
  ...r,
  role: r.role as Session["role"],
  agentType: r.agentType as Session["agentType"],
});

// ── projects ───────────────────────────────────────────────────────────────
api.get("/projects", async (c) => c.json((await db.select().from(projects)) as Project[]));

api.post("/projects", async (c) => {
  const b = await c.req.json<{ name: string; repoPath: string }>();
  const row: Project = { id: id(), name: b.name, repoPath: b.repoPath, createdAt: now() };
  await db.insert(projects).values(row);
  return c.json(row, 201);
});

// ── groups ───────────────────────────────────────────────────────────────
api.post("/groups", async (c) => {
  const b = await c.req.json<Partial<Group> & { projectId: string; name: string }>();
  const row = {
    id: id(),
    projectId: b.projectId,
    name: b.name,
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
    status: "backlog" as TaskStatus,
    priority: b.priority ?? "none",
    labels: JSON.stringify(b.labels ?? []),
    dependsOn: JSON.stringify(b.dependsOn ?? []),
    agentType: b.agentType ?? null,
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
  const patch: Record<string, unknown> = { updatedAt: now() };
  if (b.title !== undefined) patch.title = b.title;
  if (b.body !== undefined) patch.body = b.body;
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
    const text = await readFile(join("./data/runs", row.taskId, `${sid}.md`), "utf8");
    return c.text(text);
  } catch {
    return c.text("");
  }
});

// ── run a task (§1/§12) ─────────────────────────────────────────────────────
api.post("/tasks/:id/run", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  // Fire-and-forget; progress streams over /api/events.
  void runTask(taskId);
  return c.json({ started: true }, 202);
});

// ── SSE stream (§12) ───────────────────────────────────────────────────────
api.get("/events", (c) =>
  streamSSE(c, async (stream) => {
    const unsub = bus.subscribe((ev) => {
      stream.writeSSE({ data: JSON.stringify(ev) }).catch(() => {});
    });
    let alive = true;
    stream.onAbort(() => {
      alive = false;
      unsub();
    });
    while (alive) {
      await stream.writeSSE({ event: "ping", data: "1" });
      await stream.sleep(15000);
    }
  }),
);

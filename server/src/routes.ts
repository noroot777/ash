import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RUNS_DIR } from "./paths.js";
import type {
  Project,
  Group,
  Task,
  Session,
  TaskStatus,
} from "@harness/shared";
import { db } from "./db/index.js";
import { projects, groups, tasks, sessions, schedules, agents } from "./db/schema.js";
import { bus } from "./bus.js";
import { id, now } from "./util.js";
import { runTask } from "./orchestrator.js";
import { runGroup } from "./scheduler.js";
import { runDebate } from "./debate/index.js";
import { resolveGate } from "./debate/gates.js";
import { detectLocalAgents } from "./detect.js";
import type { GateAction } from "@harness/shared";

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
    status: (b.status ?? "backlog") as TaskStatus,
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
  // Fire-and-forget; progress streams over /api/events.
  if (r.mode === "debate") void runDebate(taskId);
  else void runTask(taskId);
  return c.json({ started: true }, 202);
});

// ── HITL gate decision (§7) — 放行 / 打回 / 注入意见 / 提问 ───────────────────
api.post("/tasks/:id/gate", async (c) => {
  const taskId = c.req.param("id");
  const action = await c.req.json<GateAction>();
  const ok = resolveGate(taskId, action);
  if (!ok) return c.json({ error: "no open gate for this task" }, 409);
  return c.json({ ok: true });
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

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eq, inArray } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, basename, extname, resolve, sep } from "node:path";
import { RUNS_DIR, DATA_DIR, UPLOADS_DIR } from "./paths.js";
import type {
  Project,
  ProjectView,
  Group,
  Task,
  Session,
  TaskStatus,
} from "@harness/shared";
import { canStartTask, canArchive, isUserSettableStatus, AGENT_TYPES, maxBytesFor, attachmentKind } from "@harness/shared";
import { db } from "./db/index.js";
import { projects, groups, tasks, sessions, schedules, scheduledMessages, agents } from "./db/schema.js";
import { bus } from "./bus.js";
import { id, now, attachmentsPrompt, runsTiming } from "./util.js";
import { resumeOrRunTask, continueTask } from "./orchestrator.js";
import { setTaskStatus } from "./status.js";
import { stopTask } from "./runs.js";
import { runGroup } from "./scheduler.js";
import { runDebate, resumeDebate, resumeAtGate } from "./debate/index.js";
import { resolveGate } from "./debate/gates.js";
import { detectLocalAgents } from "./detect.js";
import { projectHealthLight, projectHealthFull, tidyRepoPath, repoKey } from "./git.js";
import { resumeCommandFor } from "./executors/spawn.js";
import type { GateAction, AgentType, BatchCreateTasksBody, BatchTaskInput, ScheduledMessage, ScheduledMessageStatus } from "@harness/shared";

export const api = new Hono();

// ── health ───────────────────────────────────────────────────────────────
api.get("/health", (c) => c.json({ ok: true, ts: now() }));

const LOCAL_OPEN_ROOTS = (process.env.HARNESS_LOCAL_OPEN_ROOTS ??
  "/Users/fjh/code/daily-report/videos:/Users/fjh/code/harness/review")
  .split(":")
  .map((p) => resolve(p))
  .filter(Boolean);

const isLoopbackHost = (host: string | null): boolean => {
  const value = (host ?? "").toLowerCase();
  if (value.startsWith("[::1]")) return true;
  const h = value.split(":")[0];
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
};

const isAllowedLocalPath = (path: string): boolean =>
  LOCAL_OPEN_ROOTS.some((root) => path === root || path.startsWith(root + sep));

api.all("/open-local", async (c) => {
  if (!isLoopbackHost(c.req.header("host") ?? null)) {
    return c.text("open-local is only available through localhost/127.0.0.1", 403);
  }
  const raw = c.req.query("path") ?? "";
  const target = resolve(raw);
  if (!raw || !isAllowedLocalPath(target) || !existsSync(target)) {
    return c.text("local path is missing, outside the allowlist, or does not exist", 400);
  }
  const child = spawn("open", [target], { detached: true, stdio: "ignore" });
  child.unref();
  return c.html(
    `<!doctype html><meta charset=utf-8><title>Opened</title>` +
      `<body style="font:14px -apple-system,system-ui,sans-serif;padding:20px">已打开：<code>${target}</code></body>`,
  );
});

// ── attachment uploads (pasted into the composer / reply box) ────────────────
// Agents take text on stdin, not binaries — so we persist the pasted image/file
// and hand its absolute path to the agent (it reads it with the Read tool). See
// attachmentsPrompt. ANY type is accepted; size caps mirror Claude Code / Codex
// (vision images ≤5MB, any other file ≤20MB — maxBytesFor).
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/json": "json",
};
const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

// Keep stored filenames to a single safe path segment and bounded length.
const sanitizeName = (name: string): string =>
  (name || "").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._-]+/, "").slice(-80);

// Accept a base64 data URL of any type, persist it, return the absolute path (for
// the prompt) plus a url (preview thumbnail) and the kind (image vs file → which
// chip the web shows). The agent-facing filename keeps the original name when the
// client sent one, prefixed with an id so concurrent pastes never collide.
api.post("/uploads", async (c) => {
  const { dataUrl, name } = await c.req.json<{ dataUrl?: string; name?: string }>();
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl ?? "");
  if (!m) return c.json({ error: "需要 data:<mime>;base64 格式的数据" }, 400);
  const mime = m[1];
  const bytes = Buffer.from(m[2], "base64");
  const cap = maxBytesFor(mime);
  if (bytes.length > cap) {
    return c.json(
      { error: `文件过大：${(bytes.length / 1048576).toFixed(1)}MB，上限 ${Math.round(cap / 1048576)}MB`, max: cap },
      413,
    );
  }
  const display = sanitizeName(name ?? "") || `pasted.${MIME_EXT[mime] ?? "bin"}`;
  mkdirSync(UPLOADS_DIR, { recursive: true });
  const file = `${id()}-${display}`;
  writeFileSync(join(UPLOADS_DIR, file), bytes);
  return c.json({
    id: file,
    path: join(UPLOADS_DIR, file),
    url: `/api/uploads/${file}`,
    name: display,
    kind: attachmentKind(mime),
  });
});

// Serve a stored attachment back (thumbnail preview). basename() strips any path
// so `..` can't escape UPLOADS_DIR. Non-previewable types fall back to octet-stream.
api.get("/uploads/:file", async (c) => {
  const file = basename(c.req.param("file"));
  try {
    const body = await readFile(join(UPLOADS_DIR, file));
    return c.body(body, 200, { "content-type": EXT_MIME[extname(file).toLowerCase()] ?? "application/octet-stream" });
  } catch {
    return c.json({ error: "not found" }, 404);
  }
});

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
  startedAt: r.startedAt,
  endedAt: r.endedAt,
  archived: r.archived,
  archivedAt: r.archivedAt,
});

// Attach execution-time fields (activeMs/liveSince) to task rows. The session
// lookup is batched (one query for the whole list) so listing tasks stays O(1)
// queries; see util.runsTiming for the accounting.
async function enrichTiming(rows: (typeof tasks.$inferSelect)[]): Promise<Task[]> {
  if (rows.length === 0) return [];
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
  return rows.map((r) => ({ ...toTask(r), ...runsTiming(byTask.get(r.id) ?? []) }));
}

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

const toScheduledMessage = (r: typeof scheduledMessages.$inferSelect): ScheduledMessage => ({
  ...r,
  attachments: JSON.parse(r.attachments),
  agent: (r.agent as AgentType) ?? null,
  status: r.status as ScheduledMessageStatus,
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
  const row = { id: id(), name: b.name.trim(), repoPath: tidyRepoPath(b.repoPath), createdAt: now() };
  await db.insert(projects).values(row);
  return c.json(toProject(row), 201);
});

// Find-or-create a project by repoPath — idempotent, agent-friendly. Lets an agent
// go straight from a repo path to a stable projectId without first listing/creating
// (call it every time without worrying about duplicates). Matching is by canonical
// path key (repoKey), so `~/code/foo`, `/Users/me/code/foo`, and a trailing slash
// all resolve to the same project. name defaults to the repo's directory name.
// 200 = existing (matched or adopted), 201 = created, 409 = ambiguous.
api.post("/projects/resolve", async (c) => {
  const b = await c.req.json<{ repoPath: string; name?: string }>();
  const repoPath = tidyRepoPath(b.repoPath);
  if (!repoPath) return c.json({ error: "repoPath required" }, 400);
  const key = repoKey(repoPath);
  const all = await db.select().from(projects);

  // 1) Canonical path match — the happy path, fully idempotent across path spellings.
  const pathHits = all.filter((p) => repoKey(p.repoPath) === key);
  if (pathHits.length > 1) return c.json({ error: "repoPath 匹配到多个项目，请改用 projectId", repoPath }, 409);
  if (pathHits.length === 1) return c.json(toProject(pathHits[0]), 200);

  // 2) No path match: adopt a path-less project with the same name — the common
  //    case where the user created the project in the UI by name only (no repoPath).
  //    Backfill its repoPath so it becomes the stable target, instead of spawning a
  //    confusing same-name duplicate. Ambiguous (>1 such project) → 409.
  const name = b.name?.trim() || basename(repoPath) || "project";
  const orphans = all.filter((p) => !repoKey(p.repoPath) && p.name === name);
  if (orphans.length > 1) return c.json({ error: "有多个同名且未设路径的项目，请在界面里设置路径或改用 projectId", name }, 409);
  if (orphans.length === 1) {
    await db.update(projects).set({ repoPath }).where(eq(projects.id, orphans[0].id));
    const adopted = (await db.select().from(projects).where(eq(projects.id, orphans[0].id))).at(0)!;
    return c.json(toProject(adopted), 200);
  }

  // 3) Genuinely new project.
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
  if (b.repoPath !== undefined) patch.repoPath = tidyRepoPath(b.repoPath);
  if (Object.keys(patch).length) await db.update(projects).set(patch).where(eq(projects.id, pid));
  const updated = (await db.select().from(projects).where(eq(projects.id, pid))).at(0)!;
  return c.json(toProject(updated));
});

// Full delete: cascade tasks → their sessions/schedules/run-artifacts, then
// groups, then the project. Refuses while any task is live (§ safety).
api.delete("/projects/:id", async (c) => {
  const pid = c.req.param("id");
  const ptasks = await db.select().from(tasks).where(eq(tasks.projectId, pid));
  const live = ptasks.find((t) => t.status === "running" || t.status === "queued");
  if (live) return c.json({ error: "项目有正在运行/排队的任务，无法删除", taskId: live.id }, 409);
  for (const t of ptasks) {
    await db.delete(sessions).where(eq(sessions.taskId, t.id));
    await db.delete(schedules).where(eq(schedules.taskId, t.id));
    rmSync(join(RUNS_DIR, t.id), { recursive: true, force: true });
    rmSync(join(DATA_DIR, "scratch", t.id), { recursive: true, force: true });
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
// Locate a project by explicit id or by canonical repoPath key. Returns the row,
// or a {status, body} to surface verbatim. Shared by POST /groups and
// /groups/resolve so both resolve the project identically.
async function locateProject(
  b: { projectId?: string; repoPath?: string },
): Promise<{ project: typeof projects.$inferSelect } | { status: 400 | 404 | 409; body: Record<string, unknown> }> {
  if (b.projectId) {
    const p = (await db.select().from(projects).where(eq(projects.id, b.projectId))).at(0);
    return p ? { project: p } : { status: 404, body: { error: "project not found", projectId: b.projectId } };
  }
  if (b.repoPath) {
    const key = repoKey(b.repoPath);
    const hits = (await db.select().from(projects)).filter((p) => repoKey(p.repoPath) === key);
    if (hits.length === 0) return { status: 404, body: { error: "没有匹配 repoPath 的项目（可先调用 POST /api/projects/resolve 建项目）", repoPath: b.repoPath } };
    if (hits.length > 1) return { status: 409, body: { error: "repoPath 匹配到多个项目，请改用 projectId", repoPath: b.repoPath } };
    return { project: hits[0] };
  }
  return { status: 400, body: { error: "需要 projectId 或 repoPath 来定位项目" } };
}

api.post("/groups", async (c) => {
  const b = await c.req.json<Partial<Group> & { projectId?: string; name: string; repoPath?: string }>();
  if (!b.name?.trim()) return c.json({ error: "name required" }, 400);
  if (b.mode && b.mode !== "parallel" && b.mode !== "serial") {
    return c.json({ error: `mode 非法: ${b.mode}（只能是 parallel | serial）` }, 400);
  }

  const loc = await locateProject(b);
  if ("status" in loc) return c.json(loc.body, loc.status);

  const row = {
    id: id(),
    projectId: loc.project.id,
    name: b.name.trim(),
    mode: b.mode ?? "parallel",
    paused: false,
    createdAt: now(),
  };
  await db.insert(groups).values(row);
  return c.json(row, 201);
});

// Find-or-create a group by (project, name) — the group analog of
// /projects/resolve, so an orchestrator (MCP create_task_chain / a skill) reuses
// an existing batch container instead of spawning a duplicate on every run. A
// name that already exists twice in one project is a hard 409 — we never guess.
// On reuse the existing group's mode is KEPT (the caller's mode is
// only a default for a fresh group), so resolving never silently flips a group
// you set to serial back to parallel.
api.post("/groups/resolve", async (c) => {
  const b = await c.req.json<Partial<Group> & { projectId?: string; name: string; repoPath?: string }>();
  if (!b.name?.trim()) return c.json({ error: "name required" }, 400);
  if (b.mode && b.mode !== "parallel" && b.mode !== "serial") {
    return c.json({ error: `mode 非法: ${b.mode}（只能是 parallel | serial）` }, 400);
  }

  const loc = await locateProject(b);
  if ("status" in loc) return c.json(loc.body, loc.status);

  const name = b.name.trim();
  const existing = (await db.select().from(groups).where(eq(groups.projectId, loc.project.id))).filter((g) => g.name === name);
  if (existing.length > 1) {
    return c.json({ error: "同项目下有多个同名分组，请改用 groupId 指定要用哪个", name, ids: existing.map((g) => g.id) }, 409);
  }
  if (existing.length === 1) return c.json(existing[0], 200); // reuse as-is (mode untouched)

  const row = {
    id: id(),
    projectId: loc.project.id,
    name,
    mode: b.mode ?? "parallel",
    paused: false,
    createdAt: now(),
  };
  await db.insert(groups).values(row);
  return c.json(row, 201);
});

// ── tasks ───────────────────────────────────────────────────────────────
api.get("/tasks", async (c) => {
  const rows = await db.select().from(tasks);
  return c.json(await enrichTiming(rows));
});

api.get("/tasks/:id", async (c) => {
  const rows = await db.select().from(tasks).where(eq(tasks.id, c.req.param("id")));
  const r = rows.at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  return c.json((await enrichTiming([r]))[0]);
});

api.post("/tasks", async (c) => {
  const b = await c.req.json<Partial<Task> & { projectId: string; title: string; attachments?: string[] }>();
  const ts = now();
  const row = {
    id: id(),
    projectId: b.projectId,
    groupId: b.groupId ?? null,
    parentId: b.parentId ?? null,
    title: b.title,
    body: (b.body ?? "") + attachmentsPrompt(b.attachments),
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
  return c.json((await enrichTiming([row as typeof tasks.$inferSelect]))[0], 201);
});

// Partial update: title/body/status/priority/labels/groupId/agentType/mode/debate.
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
  const patch: Record<string, unknown> = { updatedAt: now() };
  if (b.title !== undefined) patch.title = b.title;
  if (b.body !== undefined) patch.body = b.body;
  if (b.autoTitle !== undefined) patch.autoTitle = b.autoTitle;
  if (b.priority !== undefined) patch.priority = b.priority;
  if (b.labels !== undefined) patch.labels = JSON.stringify(b.labels);
  if (b.groupId !== undefined) patch.groupId = b.groupId;
  if (b.agentType !== undefined) patch.agentType = b.agentType;
  if (b.mode !== undefined) patch.mode = b.mode;
  if (b.debate !== undefined) patch.debate = b.debate ? JSON.stringify(b.debate) : null;
  await db.update(tasks).set(patch).where(eq(tasks.id, tid));
  // Status goes through the shared helper so manual changes maintain the run-time
  // columns (startedAt/endedAt) and broadcast them just like a real run does.
  if (b.status !== undefined) await setTaskStatus(tid, b.status);
  const updated = (await db.select().from(tasks).where(eq(tasks.id, tid))).at(0)!;
  return c.json((await enrichTiming([updated]))[0]);
});

api.delete("/tasks/:id", async (c) => {
  await db.delete(tasks).where(eq(tasks.id, c.req.param("id")));
  return c.json({ deleted: true });
});

// ── groups (transient batch containers, §3) ─────────────────────────────────
// List groups, optionally scoped to a project by `projectId` or — agent-friendly —
// by `repoPath` (canonical match, same as POST /groups). repoPath that resolves to
// no project yields an empty list (never creates anything). Shape is plain Group
// rows; the MCP layer enriches with a task rollup for "which group to run".
api.get("/groups", async (c) => {
  const pid = c.req.query("projectId");
  const repo = c.req.query("repoPath");
  let rows = await db.select().from(groups);
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

// Run an entire group honoring parallel/serial + dependsOn (§1/§3). Running also
// clears a pause, so the same button doubles as "继续/resume".
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
// loop settles it as `canceled`, which is resumable). Resuming the group (运行/
// 继续) re-runs the parked tasks and picks the canceled one back up from its
// session — so pause loses no progress, it just freezes everything.
api.post("/groups/:id/pause", async (c) => {
  const gid = c.req.param("id");
  const g = (await db.select().from(groups).where(eq(groups.id, gid))).at(0);
  if (!g) return c.json({ error: "not found" }, 404);
  await db.update(groups).set({ paused: true }).where(eq(groups.id, gid));
  const members = await db.select().from(tasks).where(eq(tasks.groupId, gid));
  for (const t of members) {
    if (t.status === "queued") await setTaskStatus(t.id, "backlog"); // park not-yet-started
    else if (t.status === "running") stopTask(t.id); // kill in-flight → run loop settles it canceled
  }
  const updated = (await db.select().from(groups).where(eq(groups.id, gid))).at(0)!;
  return c.json(updated);
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
  // chain 串成的依赖链会让任务严格串行，即使分组是 parallel——这正是「设了并行却没并行」
  // 的根因。命中这种自相矛盾的组合时回个提示，让调用方（含 MCP/skill）能察觉。
  const warning =
    b.chain && specs.length > 1 && g.mode === "parallel"
      ? "本批用 chain 串成了依赖链：即使分组是 parallel，这些任务也会按链严格串行。要真正并行执行请去掉 chain（或把分组设为 serial 表达同样的串行意图）。"
      : undefined;
  return c.json(
    { groupId, run: !!b.run, ...(warning ? { warning } : {}), tasks: await enrichTiming(rows as (typeof tasks.$inferSelect)[]) },
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
  if (r.archived) return c.json({ error: "任务已归档，先取消归档再运行", archived: true }, 409);
  // Guard the state machine: only settled, non-terminal-success tasks may start.
  if (!canStartTask(r.status as TaskStatus)) return c.json({ error: "任务当前状态不可运行", status: r.status }, 409);
  // Honor dependsOn even for single-task run: if a listed dep still exists and
  // hasn't reached `done`, refuse — user should clear the edge or wait, not
  // silently skip the dependency. Dangling ids (dep deleted) are ignored.
  const deps = JSON.parse(r.dependsOn) as string[];
  if (deps.length) {
    const depRows = await db.select().from(tasks).where(inArray(tasks.id, deps));
    const blockedBy = depRows.filter((d) => d.status !== "done").map((d) => d.id);
    if (blockedBy.length) {
      return c.json(
        { error: "任务存在未完成的依赖，先撤销依赖或等其完成", blockedBy },
        409,
      );
    }
  }
  // Fire-and-forget; progress streams over /api/events.
  if (r.mode === "debate") void runDebate(taskId);
  else void resumeOrRunTask(taskId, { reason: "run" });
  return c.json({ started: true }, 202);
});

// Manually stop a running task: kill its live agent subprocess(es). The run loop
// then settles the task as `canceled` (re-runnable / continuable). 409 if nothing
// is actually running for it.
api.post("/tasks/:id/stop", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (!stopTask(taskId)) return c.json({ error: "任务没有在运行的进程可停止", status: r.status }, 409);
  return c.json({ stopped: true });
});

// Reply to a single task: resume its CLI session with the user's message so an
// agent that stopped to ask can be answered and keep going (same session).
// With `sendAt` (a future ISO time), the reply is queued as a scheduled_message
// and delivered later by the scheduler (schedules.ts) instead of fired now.
api.post("/tasks/:id/reply", async (c) => {
  const taskId = c.req.param("id");
  const b = await c.req.json<{ text?: string; attachments?: string[]; agent?: AgentType; sendAt?: string }>();
  if (!b.text?.trim() && !b.attachments?.length) return c.json({ error: "empty" }, 400);
  if (b.agent && !AGENT_TYPES.includes(b.agent)) return c.json({ error: "未知的 agent", agent: b.agent }, 400);
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.archived) return c.json({ error: "任务已归档，先取消归档再回复", archived: true }, 409);
  if (r.mode !== "single") return c.json({ error: "仅单任务支持回复" }, 409);
  // Scheduled send: persist and let the scheduler deliver it when due + idle.
  // Allowed even while the task is running — it fires in the future, not now.
  if (b.sendAt) {
    const when = new Date(b.sendAt);
    if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now())
      return c.json({ error: "定时时间必须是将来的有效时间" }, 400);
    const row = {
      id: id(),
      taskId,
      text: (b.text ?? "").trim(),
      attachments: JSON.stringify(b.attachments ?? []),
      agent: b.agent ?? null,
      sendAt: when.toISOString(),
      status: "pending" as const,
      createdAt: now(),
      sentAt: null,
    };
    await db.insert(scheduledMessages).values(row);
    return c.json({ scheduled: true, message: toScheduledMessage(row) }, 202);
  }
  if (r.status === "running" || r.status === "queued") return c.json({ error: "任务进行中" }, 409);
  void continueTask(taskId, (b.text ?? "").trim(), { attachments: b.attachments, agent: b.agent });
  return c.json({ started: true }, 202);
});

// List a task's pending scheduled messages (soonest first).
api.get("/tasks/:id/scheduled-messages", async (c) => {
  const rows = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.taskId, c.req.param("id"))))
    .filter((m) => m.status === "pending")
    .sort((a, b) => a.sendAt.localeCompare(b.sendAt));
  return c.json(rows.map(toScheduledMessage));
});

// Cancel a pending scheduled message (by message id).
api.delete("/scheduled-messages/:mid", async (c) => {
  const mid = c.req.param("mid");
  const m = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, mid))).at(0);
  if (!m) return c.json({ error: "not found" }, 404);
  if (m.status !== "pending") return c.json({ error: "只能取消待发送的消息", status: m.status }, 409);
  await db.update(scheduledMessages).set({ status: "canceled" }).where(eq(scheduledMessages.id, mid));
  return c.json({ canceled: true });
});

// Retry a failed debate: re-run only the failed (last) turn, then continue —
// instead of re-running the whole debate. Single tasks just re-run.
api.post("/tasks/:id/retry", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.archived) return c.json({ error: "任务已归档，先取消归档再重试", archived: true }, 409);
  if (r.status !== "failed") return c.json({ error: "只有失败的任务可以重试", status: r.status }, 409);
  if (r.mode === "debate") void resumeDebate(taskId);
  else void resumeOrRunTask(taskId, { reason: "retry" });
  return c.json({ started: true }, 202);
});

// ── archive / unarchive ──────────────────────────────────────────────────────
// Archiving is orthogonal to status (a separate `archived` flag, not an 8th
// status): a settled terminal task (done/failed/canceled) is frozen and tucked
// away into the archive view. It does NOT go through setTaskStatus — the status
// is preserved so unarchiving restores it. Both endpoints are idempotent (already
// in the target state → just return the task) so a double-click never errors.
api.post("/tasks/:id/archive", async (c) => {
  const r = (await db.select().from(tasks).where(eq(tasks.id, c.req.param("id")))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.archived) return c.json((await enrichTiming([r]))[0]); // idempotent
  if (!canArchive(r.status as TaskStatus)) {
    return c.json({ error: "只有已完成/失败/已取消的任务可以归档", status: r.status }, 409);
  }
  const ts = now();
  await db.update(tasks).set({ archived: true, archivedAt: ts, updatedAt: ts }).where(eq(tasks.id, r.id));
  return c.json((await enrichTiming([(await db.select().from(tasks).where(eq(tasks.id, r.id))).at(0)!]))[0]);
});

api.post("/tasks/:id/unarchive", async (c) => {
  const r = (await db.select().from(tasks).where(eq(tasks.id, c.req.param("id")))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (!r.archived) return c.json((await enrichTiming([r]))[0]); // idempotent
  await db.update(tasks).set({ archived: false, archivedAt: null, updatedAt: now() }).where(eq(tasks.id, r.id));
  return c.json((await enrichTiming([(await db.select().from(tasks).where(eq(tasks.id, r.id))).at(0)!]))[0]);
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
  const t = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (t?.archived) return c.json({ error: "任务已归档，不能设置定时", archived: true }, 409);
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

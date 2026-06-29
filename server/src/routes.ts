import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eq, inArray, and, lt, asc } from "drizzle-orm";
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
  Issue,
  IssueComment,
  IssueStatus,
  AiBackend,
  Priority,
  LlmProvider,
  LlmProtocol,
} from "@harness/shared";
import { canSingleRun, canArchive, isUserSettableStatus, AGENT_TYPES, maxBytesFor, attachmentKind } from "@harness/shared";
import { db } from "./db/index.js";
import { projects, groups, tasks, sessions, schedules, scheduledMessages, agents, issues, issueComments, llmProviders, queueItems } from "./db/schema.js";
import { bus } from "./bus.js";
import { id, now, attachmentsPrompt, runsTiming } from "./util.js";
import { resumeOrRunTask, continueTask } from "./orchestrator.js";
import { parseIssue } from "./agentOnce.js";
import { listModels } from "./llm.js";
import { setTaskStatus } from "./status.js";
import { stopTask } from "./runs.js";
import { runGroup, advanceQueue } from "./scheduler.js";
import { runDebate, resumeDebate, resumeAtGate } from "./debate/index.js";
import { resolveGate } from "./debate/gates.js";
import { detectLocalAgents } from "./detect.js";
import { projectHealthLight, projectHealthFull, tidyRepoPath, repoKey, listBranches, detectTaskWorktree, removeWorktree, taskCommits } from "./git.js";
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
  resumeDependsOn: JSON.parse(r.resumeDependsOn),
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
  useWorktree: r.useWorktree,
  worktreeBase: r.worktreeBase,
  issueId: r.issueId ?? null,
  resumePrompt: r.resumePrompt ?? null,
});

const taskBody = (body: string | undefined, taskId: string): string =>
  (body ?? "").replaceAll("{{TASK_ID}}", taskId);

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
  // 顺手把 queue 归属(queueId / queuePosition)也批查出来,前端 UI 要用
  const qItems = await db
    .select()
    .from(queueItems)
    .where(inArray(queueItems.taskId, rows.map((r) => r.id)));
  const qByTask = new Map(qItems.map((q) => [q.taskId, q] as const));
  return rows.map((r) => {
    const q = qByTask.get(r.id);
    return {
      ...toTask(r),
      ...runsTiming(byTask.get(r.id) ?? []),
      queueId: q?.queueId ?? null,
      queuePosition: q?.position ?? null,
    };
  });
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
  const row = { id: id(), name: b.name.trim(), repoPath: tidyRepoPath(b.repoPath), apiKeys: null, createdAt: now() };
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
  const row = { id: id(), name, repoPath, apiKeys: null, createdAt: now() };
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

// List the project's local git branches plus the current HEAD — drives the
// new-task form's "base 分支" picker. Empty `{ branches: [], current: null }`
// when the path isn't a git repo, so the UI can degrade to a text field.
api.get("/projects/:id/branches", async (c) => {
  const p = (await db.select().from(projects).where(eq(projects.id, c.req.param("id")))).at(0);
  if (!p) return c.json({ error: "not found" }, 404);
  return c.json(await listBranches(p.repoPath));
});

// One-click worktree cleanup — invoked from the delete-task confirmation when a
// harness-managed worktree was detected. Wraps `git worktree remove [--force]
// <path>`; failure (e.g. uncommitted changes) returns the raw git stderr so the
// UI can offer a "强制清理" retry. harness still does NOT touch branches.
api.post("/projects/:id/worktrees/remove", async (c) => {
  const p = (await db.select().from(projects).where(eq(projects.id, c.req.param("id")))).at(0);
  if (!p) return c.json({ error: "not found" }, 404);
  const b = await c.req.json<{ path: string; force?: boolean }>();
  if (!b?.path) return c.json({ error: "path required" }, 400);
  try {
    await removeWorktree(p.repoPath, b.path, !!b.force);
    return c.json({ removed: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
  }
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
  const b = await c.req.json<Partial<Task> & {
    projectId: string;
    title: string;
    attachments?: string[];
    appendToQueue?: string; // 可选:把新任务追加到指定 queue 的尾部
  }>();
  const ts = now();
  const taskId = id();
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
    agentType: b.agentType ?? null,
    autoTitle: b.autoTitle ?? false,
    debate: b.debate ? JSON.stringify(b.debate) : null,
    scheduleId: null,
    createdAt: ts,
    updatedAt: ts,
    useWorktree: b.useWorktree ?? false,
    worktreeBase: b.worktreeBase ?? null,
  };
  await db.insert(tasks).values(row);
  // 可选:追加到现有 queue 的尾部。要求:queue 已存在,且新 task 跟
  // queue 已有任务的 groupId 一致(违反就 400,不静默)。
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
    await db.insert(queueItems).values({
      taskId,
      queueId: b.appendToQueue,
      position: existing.length,
      createdAt: ts,
    });
  }
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
  const updated = (await db.select().from(tasks).where(eq(tasks.id, tid))).at(0)!;
  return c.json((await enrichTiming([updated]))[0]);
});

api.delete("/tasks/:id", async (c) => {
  const tid = c.req.param("id");
  const existing = (await db.select().from(tasks).where(eq(tasks.id, tid))).at(0);
  // Before dropping the row, snapshot any worktree harness created for this
  // task — the client uses this to surface a "清理 worktree" confirmation (path
  // + branch) plus a one-click cleanup button. harness never auto-removes.
  let worktreeHint: { path: string; branch: string } | null = null;
  if (existing?.useWorktree) {
    const project = (await db.select().from(projects).where(eq(projects.id, existing.projectId))).at(0);
    if (project) worktreeHint = detectTaskWorktree(project.repoPath, tid);
  }
  await db.delete(tasks).where(eq(tasks.id, tid));
  return c.json({ deleted: true, worktreeHint });
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

  // Validate every agent type up front (task-level or inherited default) so we
  // fail the whole batch cleanly instead of half-inserting.
  for (const [i, s] of specs.entries()) {
    const at = s.agentType ?? b.defaults?.agentType;
    if (at && !AGENT_TYPES.includes(at)) {
      return c.json({ error: `tasks[${i}].agentType 未知: ${at}`, allowed: AGENT_TYPES }, 400);
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
  const rows = specs.map((s, i) => {
    const explicitTitle = (s.title ?? "").trim();
    const ts = new Date(base + i).toISOString();
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
      agentType: (s.agentType ?? b.defaults?.agentType ?? null) as AgentType | null,
      autoTitle: !explicitTitle, // no explicit title → let the first run name it
      debate: null as string | null,
      scheduleId: null as string | null,
      createdAt: ts,
      updatedAt: ts,
      // Batch path (MCP/agent-facing) doesn't take per-task worktree opts yet —
      // those tasks run in the project's main tree. Web/mobile new-task forms
      // are the only opt-in surface for now.
      useWorktree: false,
      worktreeBase: null as string | null,
    };
  });

  await db.insert(tasks).values(rows);

  // chain:true → 创建一个 queue,把这批 task 按数组顺序加入(serial group 才走到这里)
  if (b.chain && specs.length > 1) {
    const queueId = id();
    const qts = now();
    await db.insert(queueItems).values(
      ids.map((tid, i) => ({
        taskId: tid,
        queueId,
        position: i,
        createdAt: qts,
      })),
    );
  }

  if (b.run) void runGroup(groupId);
  return c.json(
    { groupId, run: !!b.run, tasks: await enrichTiming(rows as (typeof tasks.$inferSelect)[]) },
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
  // 单条手动 Run：允许 backlog / canceled / failed / paused。canceled 在这里
  // 允许是因为用户明确点了 Run，跟 queue 推进里 canceled 透明跳过是两回事。
  if (!canSingleRun(r.status as TaskStatus)) return c.json({ error: "任务当前状态不可运行", status: r.status }, 409);
  // 队列前置检查：如果这个 task 在某个 queue 里，前面所有 item 必须是
  // done / canceled (透明) 才允许跑。否则单击 Run 等于绕过队列顺序。
  const myItem = (
    await db.select().from(queueItems).where(eq(queueItems.taskId, taskId))
  ).at(0);
  if (myItem) {
    const before = await db
      .select()
      .from(queueItems)
      .where(and(eq(queueItems.queueId, myItem.queueId), lt(queueItems.position, myItem.position)))
      .orderBy(asc(queueItems.position));
    if (before.length) {
      const beforeTasks = await db
        .select()
        .from(tasks)
        .where(inArray(tasks.id, before.map((i) => i.taskId)));
      const blockedBy = beforeTasks
        .filter((t) => !t.archived && t.status !== "done" && t.status !== "canceled")
        .map((t) => t.id);
      if (blockedBy.length) {
        return c.json(
          { error: "队列前面还有未完成的任务，先把它们处理完或把本任务移出队列", blockedBy },
          409,
        );
      }
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

// 检查点续跑：agent 在执行中调用，写下「下次继续时该喂给我的指令」。任务这一回合
// 自然退出（agent 调完它就 return 了）后，settleTaskStatus 会因为 resumePrompt
// 非空把状态落到 paused 而不是 done；scheduler 在依赖满足后会把 resumePrompt 当作
// user 消息丢回 continueTask，清空字段、resume 同一 CLI 会话。**不**修改 status,
// 让任务自然走完当前回合再结算 —— 避免 agent 主调 pause 后还想再输出几句却被截断。
// 只接受 running 任务(agent 必须自己在跑才能合法地说"我到检查点了")。
api.post("/tasks/:id/pause", async (c) => {
  const taskId = c.req.param("id");
  const b = await c.req.json<{ resumePrompt?: string }>().catch(() => ({}) as { resumePrompt?: string });
  const rp = (b.resumePrompt ?? "").trim();
  if (!rp) return c.json({ error: "resumePrompt 不能为空 —— 否则 resume 时没东西喂给 agent" }, 400);
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.status !== "running") return c.json({ error: "只能在任务正在运行时设置检查点", status: r.status }, 409);
  await db.update(tasks).set({ resumePrompt: rp, updatedAt: now() }).where(eq(tasks.id, taskId));
  return c.json({ paused: true, willSettleAs: "paused" });
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

// ── issues (planning/discussion layer upstream of tasks) ─────────────────────
const toIssue = (r: typeof issues.$inferSelect): Issue => ({
  id: r.id,
  projectId: r.projectId,
  title: r.title,
  body: r.body,
  sourceText: r.sourceText,
  status: r.status as IssueStatus,
  priority: r.priority as Priority,
  labels: JSON.parse(r.labels),
  attachments: JSON.parse(r.attachments),
  aiBackend: r.aiBackend ? (JSON.parse(r.aiBackend) as AiBackend) : null,
  parsed: r.parsed,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  closedAt: r.closedAt,
});

const toComment = (r: typeof issueComments.$inferSelect): IssueComment => ({
  id: r.id,
  issueId: r.issueId,
  author: JSON.parse(r.author),
  body: r.body,
  attachments: JSON.parse(r.attachments),
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

// Full context handed to the agent on execution: title + structured body + the
// WHOLE discussion thread — so it sees how the consensus was reached.
function issueContext(issue: typeof issues.$inferSelect, comments: (typeof issueComments.$inferSelect)[]): string {
  const lines = [`事项：「${issue.title}」`, "", issue.body || "(无描述)"];
  if (comments.length) {
    lines.push("", "— 讨论 —");
    for (const cm of comments) {
      let who = "我";
      try {
        const a = JSON.parse(cm.author);
        if (a?.kind === "agent") who = `@${a.agentType}`;
      } catch {
        /* default 我 */
      }
      lines.push(`${who}: ${cm.body}`);
    }
  }
  lines.push("", "（这是从上面这条事项转来的任务，请据此完成。）");
  // Gather every pasted/picked file across the issue + thread so the agent can Read them.
  const files: string[] = [];
  const collect = (raw: string) => {
    try {
      for (const p of JSON.parse(raw) as string[]) if (p && !files.includes(p)) files.push(p);
    } catch {
      /* ignore malformed */
    }
  };
  collect(issue.attachments);
  for (const cm of comments) collect(cm.attachments);
  return lines.join("\n") + attachmentsPrompt(files);
}

api.get("/issues", async (c) => {
  const pid = c.req.query("projectId");
  const status = c.req.query("status");
  let rows = await db.select().from(issues);
  if (pid) rows = rows.filter((i) => i.projectId === pid);
  if (status) rows = rows.filter((i) => i.status === status);
  return c.json(rows.map(toIssue));
});

api.get("/issues/:id", async (c) => {
  const r = (await db.select().from(issues).where(eq(issues.id, c.req.param("id")))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  return c.json(toIssue(r));
});

// Create an issue from raw text. Parsing is SYNCHRONOUS (the web shows 「识别中…」
// until this resolves): the AI structures the text AND infers the project. A
// pinned `projectId` from the composer overrides inference; failure degrades to
// raw text (parsed:false) so the call always lands a usable issue.
api.post("/issues", async (c) => {
  const b = await c.req.json<{ text?: string; backend?: AiBackend | null; projectId?: string | null; attachments?: string[] }>();
  if (!b.text?.trim()) return c.json({ error: "text required" }, 400);
  const projs = await db.select().from(projects);
  // For the direct-LLM backend, resolve the chosen connection (with its key) and
  // hand it to parseIssue; CLI backends ignore this.
  let apiProvider: { protocol: LlmProtocol; baseUrl: string; apiKey: string; model: string } | undefined;
  if (b.backend?.kind === "api") {
    const row = (await db.select().from(llmProviders).where(eq(llmProviders.id, b.backend.providerId))).at(0);
    if (row) apiProvider = { protocol: row.protocol as LlmProtocol, baseUrl: row.baseUrl, apiKey: row.apiKey, model: row.model };
  }
  const parsed = await parseIssue(b.text.trim(), {
    backend: b.backend ?? null,
    projects: projs.map((p) => ({ id: p.id, name: p.name, repoPath: p.repoPath })),
    apiProvider,
  });
  const projectId = b.projectId !== undefined ? b.projectId : parsed.projectId;
  const ts = now();
  const row = {
    id: id(),
    projectId,
    title: parsed.title,
    body: parsed.body,
    sourceText: b.text.trim(),
    status: "open",
    priority: parsed.priority,
    labels: JSON.stringify(parsed.labels),
    attachments: JSON.stringify(b.attachments ?? []),
    aiBackend: b.backend ? JSON.stringify(b.backend) : null,
    parsed: parsed.parsed,
    createdAt: ts,
    updatedAt: ts,
    closedAt: null as string | null,
  };
  await db.insert(issues).values(row);
  return c.json(toIssue(row as typeof issues.$inferSelect), 201);
});

api.patch("/issues/:id", async (c) => {
  const iid = c.req.param("id");
  const existing = (await db.select().from(issues).where(eq(issues.id, iid))).at(0);
  if (!existing) return c.json({ error: "not found" }, 404);
  const b = await c.req.json<Partial<Issue>>();
  const patch: Record<string, unknown> = { updatedAt: now() };
  if (b.title !== undefined) patch.title = b.title;
  if (b.body !== undefined) patch.body = b.body;
  if (b.priority !== undefined) patch.priority = b.priority;
  if (b.labels !== undefined) patch.labels = JSON.stringify(b.labels);
  if (b.attachments !== undefined) patch.attachments = JSON.stringify(b.attachments);
  if (b.projectId !== undefined) patch.projectId = b.projectId; // 归类(含从未归类指定项目)
  if (b.status !== undefined) {
    patch.status = b.status;
    patch.closedAt = b.status === "done" || b.status === "canceled" ? now() : null;
  }
  await db.update(issues).set(patch).where(eq(issues.id, iid));
  const updated = (await db.select().from(issues).where(eq(issues.id, iid))).at(0)!;
  return c.json(toIssue(updated));
});

api.delete("/issues/:id", async (c) => {
  const iid = c.req.param("id");
  await db.delete(issueComments).where(eq(issueComments.issueId, iid));
  await db.delete(issues).where(eq(issues.id, iid));
  return c.json({ deleted: true });
});

api.get("/issues/:id/comments", async (c) => {
  const rows = (await db.select().from(issueComments).where(eq(issueComments.issueId, c.req.param("id")))).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  return c.json(rows.map(toComment));
});

// Post a comment. Plain text = discussion. With `mention` (a CLI agentType) it
// ALSO executes: packs title + body + the whole thread into a task handed to that
// agent. Execution requires a project (refused on 未归类). API-model backends can
// parse but NOT execute — only CLI agent types are accepted here.
api.post("/issues/:id/comments", async (c) => {
  const iid = c.req.param("id");
  const issue = (await db.select().from(issues).where(eq(issues.id, iid))).at(0);
  if (!issue) return c.json({ error: "not found" }, 404);
  const b = await c.req.json<{ body?: string; mention?: AgentType; attachments?: string[]; useWorktree?: boolean }>();
  if (!b.body?.trim() && !b.attachments?.length) return c.json({ error: "empty" }, 400);
  if (b.mention) {
    if (!AGENT_TYPES.includes(b.mention)) return c.json({ error: "未知的 agent（执行只支持本地 CLI 智能体）", agent: b.mention }, 400);
    if (!issue.projectId) return c.json({ error: "事项还没归到项目，先归类再 @ 智能体执行" }, 409);
  }
  const ts = now();
  const crow = {
    id: id(),
    issueId: iid,
    author: JSON.stringify({ kind: "human" }), // 评论是人写的;@提及触发执行(副作用)
    body: (b.body ?? "").trim(),
    attachments: JSON.stringify(b.attachments ?? []),
    createdAt: ts,
    updatedAt: null as string | null,
  };
  await db.insert(issueComments).values(crow);

  let task: Task | undefined;
  if (b.mention && issue.projectId) {
    const comments = (await db.select().from(issueComments).where(eq(issueComments.issueId, iid))).sort((a, d) =>
      a.createdAt.localeCompare(d.createdAt),
    );
    const tid = id();
    // Worktree is OPT-IN (default off), mirroring the new-task form — the user
    // manages isolation themselves. Only when they tick 「worktree 隔离」 at @执行
    // (and the project is a git repo) does the derived task run on a clean branch;
    // that's also what enables the issue → commits linkage (GET /tasks/:id/commits).
    const proj = (await db.select().from(projects).where(eq(projects.id, issue.projectId))).at(0);
    const useWt = !!b.useWorktree && (proj ? projectHealthLight(proj.repoPath).isRepo : false);
    const trow = {
      id: tid,
      projectId: issue.projectId,
      groupId: null as string | null,
      parentId: null as string | null,
      title: issue.title,
      body: issueContext(issue, comments),
      mode: "single",
      status: "backlog",
      priority: issue.priority,
      labels: "[]",
      dependsOn: "[]",
      resumeDependsOn: "[]",
      agentType: b.mention as AgentType,
      autoTitle: false,
      debate: null as string | null,
      scheduleId: null as string | null,
      createdAt: ts,
      updatedAt: ts,
      useWorktree: useWt,
      worktreeBase: null as string | null,
      issueId: iid,
    };
    await db.insert(tasks).values(trow);
    await db.update(issues).set({ status: "in_progress", updatedAt: ts }).where(eq(issues.id, iid));
    void resumeOrRunTask(tid, { reason: "run" }); // 立即开跑,进度走 /api/events
    task = (await enrichTiming([trow as typeof tasks.$inferSelect]))[0];
  }
  return c.json({ comment: toComment(crow as typeof issueComments.$inferSelect), task }, 201);
});

// Edit a comment's text/attachments. Only the body + attachments change; author
// and createdAt stay. Editing never re-triggers execution (that's only @-mention
// on create) — it just corrects the discussion record.
api.patch("/issues/:id/comments/:cid", async (c) => {
  const cid = c.req.param("cid");
  const existing = (await db.select().from(issueComments).where(eq(issueComments.id, cid))).at(0);
  if (!existing || existing.issueId !== c.req.param("id")) return c.json({ error: "not found" }, 404);
  const b = await c.req.json<{ body?: string; attachments?: string[] }>();
  const patch: Record<string, unknown> = { updatedAt: now() };
  if (b.body !== undefined) patch.body = b.body.trim();
  if (b.attachments !== undefined) patch.attachments = JSON.stringify(b.attachments);
  await db.update(issueComments).set(patch).where(eq(issueComments.id, cid));
  const updated = (await db.select().from(issueComments).where(eq(issueComments.id, cid))).at(0)!;
  return c.json(toComment(updated));
});

api.delete("/issues/:id/comments/:cid", async (c) => {
  const cid = c.req.param("cid");
  const existing = (await db.select().from(issueComments).where(eq(issueComments.id, cid))).at(0);
  if (!existing || existing.issueId !== c.req.param("id")) return c.json({ error: "not found" }, 404);
  await db.delete(issueComments).where(eq(issueComments.id, cid));
  return c.json({ deleted: true });
});

// Tasks derived from an issue (the 派生执行 list / backlink target).
api.get("/issues/:id/tasks", async (c) => {
  const rows = await db.select().from(tasks).where(eq(tasks.issueId, c.req.param("id")));
  return c.json(await enrichTiming(rows));
});

// Commits a derived task produced on its isolated worktree branch — the concrete
// issue → code linkage. Empty when the task ran in place (no worktree).
api.get("/tasks/:id/commits", async (c) => {
  const tid = c.req.param("id");
  const t = (await db.select().from(tasks).where(eq(tasks.id, tid))).at(0);
  if (!t) return c.json({ error: "not found" }, 404);
  const project = (await db.select().from(projects).where(eq(projects.id, t.projectId))).at(0);
  const sess = (await db.select().from(sessions).where(eq(sessions.taskId, tid))).find((s) => s.worktreePath);
  if (!sess?.worktreePath || !project) return c.json({ branch: null, commits: [] });
  return c.json(await taskCommits(sess.worktreePath, project.repoPath, t.worktreeBase));
});

// ── direct-LLM connections (中转站, system-level) — for issue parsing only ────
const toProvider = (r: typeof llmProviders.$inferSelect): LlmProvider => ({
  id: r.id,
  name: r.name,
  protocol: r.protocol as LlmProtocol,
  baseUrl: r.baseUrl,
  model: r.model,
  hasKey: !!r.apiKey, // never return the key itself
  createdAt: r.createdAt,
});

api.get("/llm-providers", async (c) => c.json((await db.select().from(llmProviders)).map(toProvider)));

// Probe the available models for a connection. Used by the 设置 form to pick a
// default model. Accepts ad-hoc creds {protocol, baseUrl, apiKey} for the add
// form; if `id` is given and apiKey is omitted, the stored key is used (the key is
// never sent to the client, so editing an existing row reuses it).
api.post("/llm-providers/models", async (c) => {
  const b = await c.req.json<{ protocol?: LlmProtocol; baseUrl?: string; apiKey?: string; id?: string }>();
  let { protocol, baseUrl, apiKey } = b;
  if (b.id) {
    const row = (await db.select().from(llmProviders).where(eq(llmProviders.id, b.id))).at(0);
    if (row) {
      protocol = protocol ?? (row.protocol as LlmProtocol);
      baseUrl = baseUrl || row.baseUrl;
      if (!apiKey) apiKey = row.apiKey;
    }
  }
  try {
    const models = await listModels({
      protocol: protocol === "anthropic" ? "anthropic" : "openai",
      baseUrl: (baseUrl ?? "").trim(),
      apiKey: (apiKey ?? "").trim(),
    });
    return c.json({ models });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

api.post("/llm-providers", async (c) => {
  const b = await c.req.json<Partial<LlmProvider> & { apiKey?: string }>();
  if (!b.name?.trim() || !b.baseUrl?.trim()) return c.json({ error: "名称和网址(baseUrl)必填" }, 400);
  const row = {
    id: id(),
    name: b.name.trim(),
    protocol: b.protocol === "anthropic" ? "anthropic" : "openai",
    baseUrl: b.baseUrl.trim(),
    apiKey: (b.apiKey ?? "").trim(),
    model: (b.model ?? "").trim(),
    createdAt: now(),
  };
  await db.insert(llmProviders).values(row);
  return c.json(toProvider(row as typeof llmProviders.$inferSelect), 201);
});

api.patch("/llm-providers/:id", async (c) => {
  const pid = c.req.param("id");
  const existing = (await db.select().from(llmProviders).where(eq(llmProviders.id, pid))).at(0);
  if (!existing) return c.json({ error: "not found" }, 404);
  const b = await c.req.json<Partial<LlmProvider> & { apiKey?: string }>();
  const patch: Record<string, unknown> = {};
  if (b.name !== undefined) patch.name = b.name;
  if (b.protocol !== undefined) patch.protocol = b.protocol === "anthropic" ? "anthropic" : "openai";
  if (b.baseUrl !== undefined) patch.baseUrl = b.baseUrl;
  if (b.model !== undefined) patch.model = b.model;
  if (b.apiKey) patch.apiKey = b.apiKey; // 只在传了非空 key 时更新(留空=不动)
  await db.update(llmProviders).set(patch).where(eq(llmProviders.id, pid));
  const updated = (await db.select().from(llmProviders).where(eq(llmProviders.id, pid))).at(0)!;
  return c.json(toProvider(updated));
});

api.delete("/llm-providers/:id", async (c) => {
  await db.delete(llmProviders).where(eq(llmProviders.id, c.req.param("id")));
  return c.json({ deleted: true });
});

// ── queues (顺序依赖原语,DESIGN-scheduling.md §1) ─────────────────────────────
// queue 是有序的 task id 列表。前一个 done/canceled 后,后一个自动启动。
// 不变量:同一 queue 内所有 task 必须在同一个 group(或都无 group),应用层校验。

// 内部:把 (queueId, [..items..]) 重排成 position 0..N-1,保持 dense
async function repackQueue(queueId: string, orderedTaskIds: string[]): Promise<void> {
  const ts = now();
  // 先全删,再按新顺序插入(libsql 没有 batch txn 暴露,但 queue 通常很小)
  await db.delete(queueItems).where(eq(queueItems.queueId, queueId));
  if (orderedTaskIds.length === 0) return;
  await db.insert(queueItems).values(
    orderedTaskIds.map((tid, i) => ({
      taskId: tid,
      queueId,
      position: i,
      createdAt: ts,
    })),
  );
}

// 校验:queue 里所有 task 必须同 group(或都无 group)
async function assertSameGroup(queueId: string, candidateTaskId?: string): Promise<string | null> {
  const items = await db.select().from(queueItems).where(eq(queueItems.queueId, queueId));
  const taskIds = [...items.map((i) => i.taskId), ...(candidateTaskId ? [candidateTaskId] : [])];
  if (taskIds.length === 0) return null;
  const rows = await db.select().from(tasks).where(inArray(tasks.id, taskIds));
  const groups = new Set(rows.map((r) => r.groupId));
  if (groups.size > 1) {
    return `跨 group 不允许:queue ${queueId} 涉及多个 group ${[...groups].join(", ")}`;
  }
  return null;
}

// 列出某 queue 的内容(含每个 task 的状态)
api.get("/queues/:queueId", async (c) => {
  const qid = c.req.param("queueId");
  const items = await db
    .select()
    .from(queueItems)
    .where(eq(queueItems.queueId, qid))
    .orderBy(asc(queueItems.position));
  if (items.length === 0) return c.json({ error: "queue not found" }, 404);
  const rows = await db.select().from(tasks).where(inArray(tasks.id, items.map((i) => i.taskId)));
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const groupId = rows[0]?.groupId ?? null;
  return c.json({
    queueId: qid,
    groupId,
    items: items.map((i) => {
      const t = byId.get(i.taskId);
      return {
        taskId: i.taskId,
        position: i.position,
        title: t?.title ?? "",
        status: t?.status ?? null,
        archived: t?.archived ?? false,
      };
    }),
  });
});

// 整批 reorder:body 必须是 queue 完整成员的新顺序(防止漏掉或重复)
api.post("/queues/:queueId/reorder", async (c) => {
  const qid = c.req.param("queueId");
  const b = await c.req.json<{ taskIds?: string[] }>();
  const want = b.taskIds ?? [];
  if (!Array.isArray(want)) return c.json({ error: "taskIds 必须是数组" }, 400);

  const current = await db.select().from(queueItems).where(eq(queueItems.queueId, qid));
  if (current.length === 0) return c.json({ error: "queue not found" }, 404);

  const haveSet = new Set(current.map((i) => i.taskId));
  const wantSet = new Set(want);
  if (haveSet.size !== wantSet.size || [...haveSet].some((id) => !wantSet.has(id))) {
    return c.json(
      {
        error: "reorder 必须传 queue 的完整成员,不能漏或多",
        have: [...haveSet],
        got: [...wantSet],
      },
      400,
    );
  }

  // running task 不能被移走/前面新插队
  const taskRows = await db.select().from(tasks).where(inArray(tasks.id, want));
  const runningId = taskRows.find((t) => t.status === "running" || t.status === "queued")?.id;
  if (runningId) {
    const oldPos = current.find((i) => i.taskId === runningId)!.position;
    const newPos = want.indexOf(runningId);
    if (oldPos !== newPos) {
      return c.json({ error: `running/queued task ${runningId} 不能移动位置` }, 409);
    }
  }

  await repackQueue(qid, want);
  return c.json({ ok: true });
});

// 从 queue 移除一项(task 本身不删,只是脱离 queue → 成为独立 task)
api.post("/queues/:queueId/remove", async (c) => {
  const qid = c.req.param("queueId");
  const b = await c.req.json<{ taskId?: string }>();
  if (!b.taskId) return c.json({ error: "taskId required" }, 400);

  const items = await db
    .select()
    .from(queueItems)
    .where(eq(queueItems.queueId, qid))
    .orderBy(asc(queueItems.position));
  if (items.length === 0) return c.json({ error: "queue not found" }, 404);
  if (!items.some((i) => i.taskId === b.taskId)) {
    return c.json({ error: "task 不在此 queue 里" }, 404);
  }

  // running task 不能拔
  const tr = (await db.select().from(tasks).where(eq(tasks.id, b.taskId))).at(0);
  if (tr && (tr.status === "running" || tr.status === "queued")) {
    return c.json({ error: `task ${b.taskId} 正在跑,不能移出 queue` }, 409);
  }

  const next = items.filter((i) => i.taskId !== b.taskId).map((i) => i.taskId);
  await repackQueue(qid, next);
  // 移除后立刻推一下,看看后面的 task 是否能动了
  if (next.length > 0) void advanceQueue(qid);
  return c.json({ ok: true });
});

// 在指定位置插入(校验跨 group)
api.post("/queues/:queueId/insert", async (c) => {
  const qid = c.req.param("queueId");
  const b = await c.req.json<{ taskId?: string; position?: number }>();
  if (!b.taskId) return c.json({ error: "taskId required" }, 400);
  const pos = typeof b.position === "number" ? Math.max(0, b.position | 0) : -1;

  const items = await db
    .select()
    .from(queueItems)
    .where(eq(queueItems.queueId, qid))
    .orderBy(asc(queueItems.position));
  if (items.length === 0) return c.json({ error: "queue not found" }, 404);
  if (items.some((i) => i.taskId === b.taskId)) {
    return c.json({ error: "task 已在此 queue 里" }, 409);
  }

  // 候选 task 必须先存在
  const tr = (await db.select().from(tasks).where(eq(tasks.id, b.taskId))).at(0);
  if (!tr) return c.json({ error: "task not found" }, 404);

  // 候选 task 不能已在别的 queue 里(task_id PK 保证,但提前给个友好错误)
  const otherQueue = (
    await db.select().from(queueItems).where(eq(queueItems.taskId, b.taskId))
  ).at(0);
  if (otherQueue && otherQueue.queueId !== qid) {
    return c.json({ error: `task 已在另一个 queue ${otherQueue.queueId}` }, 409);
  }

  // 跨 group 校验
  const violation = await assertSameGroup(qid, b.taskId);
  if (violation) return c.json({ error: violation }, 400);

  const insertAt = pos < 0 || pos > items.length ? items.length : pos;
  const next = [
    ...items.slice(0, insertAt).map((i) => i.taskId),
    b.taskId,
    ...items.slice(insertAt).map((i) => i.taskId),
  ];
  await repackQueue(qid, next);
  return c.json({ ok: true });
});

// 新建一个 queue,用给定的 task ids
api.post("/queues", async (c) => {
  const b = await c.req.json<{ taskIds?: string[] }>();
  const want = b.taskIds ?? [];
  if (!Array.isArray(want) || want.length === 0) {
    return c.json({ error: "taskIds 不能为空" }, 400);
  }
  // 候选 task 都得存在
  const rows = await db.select().from(tasks).where(inArray(tasks.id, want));
  if (rows.length !== want.length) {
    return c.json({ error: "部分 taskId 不存在" }, 400);
  }
  // 同 group(或都无 group)
  const gs = new Set(rows.map((r) => r.groupId));
  if (gs.size > 1) return c.json({ error: "跨 group 不允许" }, 400);
  // 任何一个 task 已在其他 queue?
  const occupied = await db.select().from(queueItems).where(inArray(queueItems.taskId, want));
  if (occupied.length > 0) {
    return c.json(
      { error: `这些 task 已在其他 queue: ${occupied.map((o) => o.taskId).join(", ")}` },
      409,
    );
  }
  const qid = id();
  const ts = now();
  await db.insert(queueItems).values(
    want.map((tid, i) => ({ taskId: tid, queueId: qid, position: i, createdAt: ts })),
  );
  return c.json({ queueId: qid, taskIds: want }, 201);
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

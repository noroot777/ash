import { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { streamSSE } from "hono/streaming";
import { eq, inArray, asc } from "drizzle-orm";
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
import { canSingleRun, canArchive, isUserSettableStatus, AGENT_TYPES, maxBytesFor, attachmentKind, MAX_QUESTION_OPTIONS, MAX_QUESTION_OPTION_LEN } from "@harness/shared";
import { db } from "./db/index.js";
import { projects, groups, tasks, sessions, schedules, scheduledMessages, agents, issues, issueComments, llmProviders, queueItems } from "./db/schema.js";
import { bus } from "./bus.js";
import { id, now, attachmentsPrompt, runsTiming } from "./util.js";
import { resumeOrRunTask, continueTask, runTask } from "./orchestrator.js";
import { parseIssue, classifyMention, buildDiscussPrompt, runAgentOnce, DISCUSS_TIMEOUT_MS } from "./agentOnce.js";
import { listModels } from "./llm.js";
import { setTaskStatus } from "./status.js";
import { stopTask, confirmDone } from "./runs.js";
import { runGroup, advanceQueue, pauseGroup } from "./scheduler.js";
import { mountQueueRoutes, queueBlockers, repackQueue, isOvertaken, tailOrder } from "./queues.js";
import { haltTeam } from "./team/session.js";
import { dispatchWorkers, type DispatchSpec } from "./team/dispatch.js";
import { runDebate, resumeDebate, resumeAtGate } from "./debate/index.js";
import { resolveGate } from "./debate/gates.js";
import { detectLocalAgents } from "./detect.js";
import { searchAll } from "./search.js";
import { projectHealthLight, projectHealthFull, tidyRepoPath, repoKey, listBranches, detectTaskWorktree, removeWorktree, taskCommits } from "./git.js";
import { resumeCommandFor } from "./executors/spawn.js";
import { resolveExecutorFor } from "./executors/index.js";
import { forceKillCuaService, lastCuaResidualStatus, refreshCuaResidualStatus } from "./cua.js";
import type { GateAction, AgentType, BatchCreateTasksBody, BatchTaskInput, ScheduledMessage, ScheduledMessageStatus } from "@harness/shared";

export const api = new Hono();

// ── health ───────────────────────────────────────────────────────────────
api.get("/health", (c) => c.json({ ok: true, ts: now() }));

// ── search ───────────────────────────────────────────────────────────────
// Global search across tasks + session transcripts + issues (see search.ts).
// Sub-2-char queries return empty instead of erroring — the palette calls this
// on every keystroke.
api.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 2) return c.json([]);
  return c.json(await searchAll(q));
});

const LOCAL_OPEN_ROOTS = (process.env.HARNESS_LOCAL_OPEN_ROOTS ??
  "/Users/fjh/code/daily-report/videos:/Users/fjh/code/harness/review")
  .split(":")
  .map((p) => resolve(p))
  .filter(Boolean);

// open-local 信任的是「连接来源 IP」而非 Host 头(Host 可随意伪造):本机 loopback
// 或 Tailscale 网段(100.64.0.0/10 CGNAT + 其 IPv6 fd7a:115c:a1e0::/48)放行——
// tailnet 里全是自己的设备,从手机/别的电脑点开也应该能在 Mac 上打开文件。
const isTrustedRemote = (addr: string | undefined): boolean => {
  const a = (addr ?? "").replace(/^::ffff:/i, "");
  if (a === "127.0.0.1" || a === "::1") return true;
  if (a.toLowerCase().startsWith("fd7a:115c:a1e0:")) return true;
  const m = /^100\.(\d+)\./.exec(a);
  return m !== null && Number(m[1]) >= 64 && Number(m[1]) <= 127;
};

const isAllowedLocalPath = (path: string): boolean =>
  LOCAL_OPEN_ROOTS.some((root) => path === root || path.startsWith(root + sep));

api.all("/open-local", async (c) => {
  if (!isTrustedRemote(getConnInfo(c).remote.address)) {
    return c.text("只允许本机或 Tailscale 网内设备调用 open-local", 403);
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
  reasoningEffort: r.reasoningEffort ?? undefined,
  speed: r.speed ?? undefined,
  providerId: r.providerId ?? null,
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
    reasoningEffort: b.reasoningEffort || null,
    // 只落 "fast";"standard"/空 归一成 null(标准=不传参,单一表示)
    speed: b.speed === "fast" ? "fast" : null,
    providerId: b.providerId || null,
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
  if (b.reasoningEffort !== undefined) patch.reasoningEffort = b.reasoningEffort || null;
  if (b.speed !== undefined) patch.speed = b.speed === "fast" ? "fast" : null;
  if (b.providerId !== undefined) patch.providerId = b.providerId || null;
  if (b.isDefault === true) {
    await db.update(agents).set({ isDefault: false }).where(eq(agents.type, existing.type));
    patch.isDefault = true;
  }
  await db.update(agents).set(patch).where(eq(agents.id, aid));
  const updated = (await db.select().from(agents).where(eq(agents.id, aid))).at(0)!;
  return c.json(toAgent(updated));
});

api.delete("/agents/:id", async (c) => {
  const aid = c.req.param("id");
  await db.delete(agents).where(eq(agents.id, aid));
  await db.update(tasks).set({ executorId: null, updatedAt: now() }).where(eq(tasks.executorId, aid));
  return c.json({ deleted: true });
});

// ── row -> domain mappers (parse json columns) ─────────────────────────────
type AgentLabelRow = { id: string; name: string; type: string; isDefault: boolean };

const agentTypeForExecutor = async (executorId?: string | null): Promise<AgentType | null> => {
  if (!executorId) return null;
  const row = (await db.select({ type: agents.type }).from(agents).where(eq(agents.id, executorId))).at(0);
  return row ? (row.type as AgentType) : null;
};

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
  };
};

const toTask = (r: typeof tasks.$inferSelect, profiles: AgentLabelRow[] = []): Task => ({
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
  executorId: r.executorId ?? null,
  executorLabel: executorLabelFor(profiles, r.executorId, (r.agentType as AgentType) ?? null),
  autoTitle: r.autoTitle,
  debate: r.debate ? JSON.parse(r.debate) : undefined,
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
  issueId: r.issueId ?? null,
  resumePrompt: r.resumePrompt ?? null,
  question: r.question ?? null,
  questionOptions: r.questionOptions ? (JSON.parse(r.questionOptions) as string[]) : null,
});

const taskBody = (body: string | undefined, taskId: string): string =>
  (body ?? "").replaceAll("{{TASK_ID}}", taskId);

// Attach execution-time fields (activeMs/liveSince) to task rows. The session
// lookup is batched (one query for the whole list) so listing tasks stays O(1)
// queries; see util.runsTiming for the accounting.
async function enrichTiming(rows: (typeof tasks.$inferSelect)[]): Promise<Task[]> {
  if (rows.length === 0) return [];
  const profiles = await db
    .select({ id: agents.id, name: agents.name, type: agents.type, isDefault: agents.isDefault })
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
  // 顺手把 queue 归属(queueId / queuePosition)也批查出来,前端 UI 要用
  const qItems = await db
    .select()
    .from(queueItems)
    .where(inArray(queueItems.taskId, rows.map((r) => r.id)));
  const qByTask = new Map(qItems.map((q) => [q.taskId, q] as const));
  return rows.map((r) => {
    const q = qByTask.get(r.id);
    return {
      ...toTask(r, profiles),
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
    ? resumeCommandFor(r.agentType, r.target, r.cwd ?? r.worktreePath ?? ".", r.cliSessionId, r.relayEnv)
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
  const executorType = await agentTypeForExecutor(b.executorId);
  if (executorType && b.agentType && b.agentType !== executorType) {
    return c.json({ error: `executorId 属于 ${executorType},但 agentType 是 ${b.agentType}`, executorId: b.executorId }, 400);
  }
  const rawTeam = b.team;
  const teamLeadType = rawTeam ? await agentTypeForExecutor(rawTeam.leadExecutorId) : null;
  const teamWorkerType = rawTeam ? await agentTypeForExecutor(rawTeam.workerExecutorId) : null;
  if (rawTeam && teamLeadType && rawTeam.lead !== teamLeadType) {
    return c.json({ error: `team.leadExecutorId 属于 ${teamLeadType},但 team.lead 是 ${rawTeam.lead}`, executorId: rawTeam.leadExecutorId }, 400);
  }
  if (rawTeam && teamWorkerType && rawTeam.worker !== teamWorkerType) {
    return c.json({ error: `team.workerExecutorId 属于 ${teamWorkerType},但 team.worker 是 ${rawTeam.worker}`, executorId: rawTeam.workerExecutorId }, 400);
  }
  const teamConfig = rawTeam
    ? {
        lead: rawTeam.lead,
        worker: rawTeam.worker,
        leadExecutorId: rawTeam.leadExecutorId ?? null,
        workerExecutorId: rawTeam.workerExecutorId ?? null,
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
    autoTitle: b.autoTitle ?? false,
    debate: b.debate ? JSON.stringify(b.debate) : null,
    // mode:"team" 的指挥者/默认工人类型(跟 debate 对称)。别漏 —— 漏了就静默退回
    // TEAM_DEFAULTS,用户在启动器上挑的那两个旋钮全白挑。
    team: teamConfig ? JSON.stringify(teamConfig) : null,
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
    // 追加到队尾后立刻推进:若前序全 done,新 task 应立刻起跑
    void advanceQueue(b.appendToQueue);
  }
  return c.json((await enrichTiming([row as typeof tasks.$inferSelect]))[0], 201);
});

// Partial update: title/body/status/priority/labels/groupId/agentType/executorId/mode/debate.
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
  const patch: Record<string, unknown> = { updatedAt: now() };
  if (b.title !== undefined) patch.title = b.title;
  if (b.body !== undefined) patch.body = b.body;
  if (b.autoTitle !== undefined) patch.autoTitle = b.autoTitle;
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
  const ownerTaskId = c.req.query("ownerTaskId");
  // 团队任务派活时自建的内部组(owner_task_id 非空)不在这里露脸 —— 它们是 §Team
  // 的内部结构(团队视图自己会展示工人),混进用户的分组列表只会当噪音。
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
  for (const [i, s] of specs.entries()) {
    const executorId = s.executorId !== undefined ? s.executorId : b.defaults?.executorId;
    const executorType = executorId ? profileTypes.get(executorId) : undefined;
    const explicitType = s.agentType ?? b.defaults?.agentType;
    const at = explicitType ?? executorType;
    if (at && !AGENT_TYPES.includes(at)) {
      return c.json({ error: `tasks[${i}].agentType 未知: ${at}`, allowed: AGENT_TYPES }, 400);
    }
    if (executorType && explicitType && explicitType !== executorType) {
      return c.json({ error: `tasks[${i}].executorId 属于 ${executorType},但 agentType 是 ${explicitType}`, executorId }, 400);
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
    const executorId = s.executorId !== undefined ? s.executorId : b.defaults?.executorId ?? null;
    const agentType = s.agentType ?? b.defaults?.agentType ?? (executorId ? profileTypes.get(executorId) : null) ?? null;
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
      agentType: agentType as AgentType | null,
      executorId,
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
// 队列前置检查(queueBlockers)、queue 的增删改端点都在 ./queues.ts。

api.post("/tasks/:id/run", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.archived) return c.json({ error: "任务已归档，先取消归档再运行", archived: true }, 409);
  // 单条手动 Run：允许 backlog / canceled / failed / paused。canceled 在这里
  // 允许是因为用户明确点了 Run，跟 queue 推进里 canceled 透明跳过是两回事。
  if (!canSingleRun(r.status as TaskStatus)) return c.json({ error: "任务当前状态不可运行", status: r.status }, 409);
  const blockedBy = await queueBlockers(taskId);
  if (blockedBy.length) {
    return c.json(
      { error: "队列前面还有未完成的任务，先把它们处理完或把本任务移出队列", blockedBy },
      409,
    );
  }
  // Fire-and-forget; progress streams over /api/events.
  if (r.mode === "debate") void runDebate(taskId);
  else void resumeOrRunTask(taskId, { reason: "run" });
  return c.json({ started: true }, 202);
});

// 立即触发一轮全新运行 = 调度器到点 fire 的效果:永远 fresh(新 CLI 会话、重新
// 喂任务正文),绝不 resume 旧会话。「运行/重试」优先续会话,这里给「现在就跑
// 一班新的」一个显式入口——典型场景:cron 任务错过班次,手动补跑今天这班。
// done 也允许(定时本来就会重跑 done 任务);running/queued/审核中拒绝。
api.post("/tasks/:id/fire", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.archived) return c.json({ error: "任务已归档，先取消归档再触发", archived: true }, 409);
  if (r.status === "running" || r.status === "queued")
    return c.json({ error: "任务正在进行，等它结束再触发新一轮", status: r.status }, 409);
  if (r.status === "awaiting_review")
    return c.json({ error: "任务等待裁决中，先处理裁决再触发", status: r.status }, 409);
  const blockedBy = await queueBlockers(taskId);
  if (blockedBy.length) {
    return c.json(
      { error: "队列前面还有未完成的任务，先把它们处理完或把本任务移出队列", blockedBy },
      409,
    );
  }
  if (r.mode === "debate") void runDebate(taskId);
  else void runTask(taskId); // 全新一轮,永不 resume
  return c.json({ started: true, fresh: true }, 202);
});

// Manually stop a running task: kill its live agent subprocess(es). The run loop
// then settles the task as `canceled` (re-runnable / continuable). queued(还没
// spawn)或进程已丢(如 server 重启遗留)时直接落 canceled —— 这是取消任务的
// 唯一正道;PATCH status=canceled 对 running/queued 已被禁止。
api.post("/tasks/:id/stop", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (stopTask(taskId)) return c.json({ stopped: true });
  if (r.status === "queued" || r.status === "running") {
    await setTaskStatus(taskId, "canceled");
    return c.json({ stopped: true, note: "没有存活的 agent 进程,已直接标记为 canceled" });
  }
  return c.json({ error: "任务没有在运行的进程可停止", status: r.status }, 409);
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

// 完成确认(严格 done 协议,对称 /pause):agent 当且仅当确定任务目标已达成时
// 调用;settle 时消费这个标记才落 done,否则 exit 0 也按 failed 结算(exit 0
// 只证明进程正常退出,agent 报错后退出照样 exit 0 —— 假 done 会误推进队列)。
// 只接受 running 任务;标记是回合内的内存态(见 runs.ts confirmDone)。
api.post("/tasks/:id/complete", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.status !== "running") return c.json({ error: "只能在任务正在运行时确认完成", status: r.status }, 409);
  confirmDone(taskId);
  return c.json({ confirmed: true, willSettleAs: "done" });
});

// 提问(对称 /pause,§Team):agent 在执行中调用,写下「我被这个问题卡住了」。
// 工人:本回合自然退出后,settleTaskStatus 因 question 非空落 paused,且队列**不**
// 自动续跑(pickNextLaunchable 挡住);问题即时投递给团队指挥者,answer_question
// 的答复会清空 question 并带着答复 resume 同一 CLI 会话。
// 团队指挥者自己也能调 → 界面上就是「指挥者在等你答复」,答复喂回它的常驻会话。
// 没人管也能用:任务停在 paused,问题留在 task.question 等用户答复。
// 可选的 options = 候选答案:网页在问题下方渲染成按钮,点一下就是以该选项**原文**
// 走同一个 /answer —— 所以答复链路对「点按钮」和「自己打字」完全一样,选项只省打字。
// 只接受 running 任务;不修改 status,让回合自然走完再结算(同 pause 的理由)。
api.post("/tasks/:id/ask", async (c) => {
  const taskId = c.req.param("id");
  const b = await c.req
    .json<{ question?: string; options?: unknown }>()
    .catch(() => ({}) as { question?: string; options?: unknown });
  const q = (b.question ?? "").trim();
  if (!q) return c.json({ error: "question 不能为空" }, 400);
  if (b.options !== undefined && !Array.isArray(b.options))
    return c.json({ error: "options 必须是字符串数组" }, 400);
  // trim + 去空 + 去重后落库;超限明确报错,不静默截断(见 shared 常量处的理由)。
  const opts = [...new Set((b.options ?? []).map((o) => String(o ?? "").trim()).filter(Boolean))];
  if (opts.length > MAX_QUESTION_OPTIONS)
    return c.json({ error: `最多 ${MAX_QUESTION_OPTIONS} 个候选答案，收到 ${opts.length} 个` }, 400);
  const tooLong = opts.find((o) => o.length > MAX_QUESTION_OPTION_LEN);
  if (tooLong)
    return c.json(
      { error: `单个候选答案不超过 ${MAX_QUESTION_OPTION_LEN} 字，展开说明请写进 question：「${tooLong.slice(0, 30)}…」` },
      400,
    );
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.status !== "running") return c.json({ error: "只能在任务正在运行时提问", status: r.status }, 409);
  await db
    .update(tasks)
    .set({ question: q, questionOptions: opts.length ? JSON.stringify(opts) : null, updatedAt: now() })
    .where(eq(tasks.id, taskId));
  bus.publish({ type: "task.question", taskId, question: q, questionOptions: opts.length ? opts : null });
  return c.json({ asked: true, options: opts, willSettleAs: "paused" });
});

// 答复一个提问暂停中的任务(指挥者或用户都可调):清空 question,把答复作为
// 消息 resume 它的 CLI 会话继续跑。提问回合还没结算完(running/queued)时拒绝
// ——等它落 paused 再答,否则答复会被单飞锁静默丢掉。
// 例外:常驻指挥台(§Team)自己调 ask_question 问用户时,这道挡板不适用 —— 它正在
// 说话时也接得住(continueTask → deliverToLead 先 interrupt 再写 stdin),跟
// 「插话」走的是同一条路。挡住反而会让用户对着一个明明在线的指挥台干等。
api.post("/tasks/:id/answer", async (c) => {
  const taskId = c.req.param("id");
  const b = await c.req.json<{ answer?: string }>().catch(() => ({}) as { answer?: string });
  const a = (b.answer ?? "").trim();
  if (!a) return c.json({ error: "answer 不能为空" }, 400);
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (!r.question) return c.json({ error: "该任务没有待答复的问题", status: r.status }, 409);
  if (r.mode !== "team" && (r.status === "running" || r.status === "queued")) {
    return c.json({ error: "提问回合还没结束,等任务落 paused 再答复", status: r.status }, 409);
  }
  await db
    .update(tasks)
    .set({ question: null, questionOptions: null, updatedAt: now() })
    .where(eq(tasks.id, taskId));
  bus.publish({ type: "task.question", taskId, question: null, questionOptions: null });
  // 指挥台不说「完成任务」——它没有完成一说,只是拿到答案接着安排。
  const tail = r.mode === "team" ? "请据此接着安排。" : "请据此继续完成任务。";
  void continueTask(taskId, `【答复】你之前的提问:「${r.question}」\n\n${a}\n\n${tail}`);
  return c.json({ answered: true, resumed: true });
});

// ── §Team ───────────────────────────────────────────────────────────────────
// 派活:指挥者(mode:"team")调 MCP 的 dispatch 落到这里 —— 建 N 个工人任务 + 一个
// 内部组(serial 顺带串成队列),默认立刻起跑。
api.post("/tasks/:id/dispatch", async (c) => {
  const leadTaskId = c.req.param("id");
  type DispatchBody = { tasks?: DispatchSpec[]; mode?: "serial" | "parallel"; run?: boolean; batchName?: string };
  const b = await c.req.json<DispatchBody>().catch(() => ({}) as DispatchBody);
  const specs = (b.tasks ?? []).filter((s) => (s?.body ?? "").trim());
  if (!specs.length) return c.json({ error: "tasks 不能为空(每项至少要有 body)" }, 400);
  try {
    const r = await dispatchWorkers(leadTaskId, specs, { mode: b.mode, run: b.run, batchName: b.batchName });
    return c.json(
      { groupId: r.groupId, mode: r.mode, run: b.run !== false, tasks: await enrichTiming(r.tasks) },
      201,
    );
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// 停止全组:指挥台进程 + 所有在跑的工人一起停。工人走分组暂停(落 paused,占住
// 队列位置,恢复分组时从原会话续跑);指挥台落 idle(会话留着,再说话就接回)。
api.post("/tasks/:id/team/halt", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.mode !== "team") return c.json({ error: "只有团队任务能停止全组", mode: r.mode }, 400);
  await haltTeam(taskId);
  return c.json({ halted: true });
});

api.get("/tasks/:id/team/cua-status", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.mode !== "team") return c.json({ error: "只有团队任务有 team CUA 状态", mode: r.mode }, 400);
  const last = lastCuaResidualStatus("team", taskId);
  const current = await refreshCuaResidualStatus("team", taskId);
  return c.json({ taskId, current, last });
});

api.post("/tasks/:id/team/kill-cua", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.mode !== "team") return c.json({ error: "只有团队任务能强制清理 CUA", mode: r.mode }, 400);
  const result = await forceKillCuaService("team", taskId);
  return c.json({
    killed: result.killed,
    before: result.before,
    after: result.after,
    status: result.status,
    warning: result.sideEffect,
  });
});

// Reply to a single task: resume its CLI session with the user's message so an
// agent that stopped to ask can be answered and keep going (same session).
// With `sendAt` (a future ISO time), the reply is queued as a scheduled_message
// and delivered later by the scheduler (schedules.ts) instead of fired now.
// 团队(§Team)的「插话」也走这个端点,但两道给一次性会话设的挡板对它不适用:
// 指挥台是常驻进程,正在说话(running)时也接得住(continueTask → deliverToLead 直接
// 写进 stdin),这就是「发出去当前会话就接住、看着从没断线」的手感。
api.post("/tasks/:id/reply", async (c) => {
  const taskId = c.req.param("id");
  const b = await c.req.json<{ text?: string; attachments?: string[]; agent?: AgentType; sendAt?: string }>();
  if (!b.text?.trim() && !b.attachments?.length) return c.json({ error: "empty" }, 400);
  if (b.agent && !AGENT_TYPES.includes(b.agent)) return c.json({ error: "未知的 agent", agent: b.agent }, 400);
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.archived) return c.json({ error: "任务已归档，先取消归档再回复", archived: true }, 409);
  const isTeam = r.mode === "team";
  if (!isTeam && r.mode !== "single") return c.json({ error: "仅单任务支持回复" }, 409);
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
  if (!isTeam && (r.status === "running" || r.status === "queued")) return c.json({ error: "任务进行中" }, 409);
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

// 重新排队:队列里失败/取消的任务回到 backlog 等待,轮到它时被队列自动拉起
// (有会话就从中断处续跑)。跟「重试」的区别是不插队 —— 重试是立刻跑一遍。
//
// **被越过就排到队尾**:失败任务是被队列「透明跳过」的,后面的早就开跑了,原来
// 那个位置已经名存实亡;留在原位会让它抢在正在跑的那个前面(实测:05 失败 → 06
// 起跑 → 05 重新排队 → 两个一起跑)。反过来,如果后面根本没人跑过(整组还没
// 启动),就原位不动,尊重用户原本编排的顺序。
// 位置计算(isOvertaken/tailOrder)与状态改写在这里一次做完:前端曾用
// 「PATCH backlog + runGroup」两步拼,中间那一瞬间正是并跑窗口。
api.post("/tasks/:id/requeue", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.archived) return c.json({ error: "任务已归档，先取消归档再重新排队", archived: true }, 409);
  if (r.status === "running" || r.status === "queued")
    return c.json({ error: "任务正在进行，不需要重新排队", status: r.status }, 409);
  if (r.status !== "failed" && r.status !== "canceled")
    return c.json({ error: "只有失败/已取消的任务需要重新排队", status: r.status }, 409);

  const myItem = (await db.select().from(queueItems).where(eq(queueItems.taskId, taskId))).at(0);
  if (!myItem) return c.json({ error: "任务不在任何队列里，直接点运行即可" }, 400);
  const queueId = myItem.queueId;

  const items = await db
    .select()
    .from(queueItems)
    .where(eq(queueItems.queueId, queueId))
    .orderBy(asc(queueItems.position));
  const rows = await db.select().from(tasks).where(inArray(tasks.id, items.map((i) => i.taskId)));
  const byId = new Map(rows.map((x) => [x.id, x] as const));
  const ordered = items
    .map((i) => byId.get(i.taskId))
    .filter((t): t is typeof tasks.$inferSelect => !!t);

  const movedToEnd = isOvertaken(ordered, taskId);
  if (movedToEnd) await repackQueue(queueId, tailOrder(ordered.map((t) => t.id), taskId));

  await setTaskStatus(taskId, "backlog");
  // 前面若还有人在跑,advanceQueue 会被 selectNextInQueue 的守卫挡住,什么都不做。
  void advanceQueue(queueId);

  const updated = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
  const task = (await enrichTiming([updated]))[0];
  return c.json({ task, movedToEnd, position: task.queuePosition, queueSize: ordered.length });
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
  // 团队(§Team):归档才是「这件事结束了」—— 先停掉指挥台进程和所有在跑的工人,
  // 再把工人一并归档(不管它们各自停在什么状态:团队没了,散在列表里的工人只是
  // 噪音;取消归档时整支队伍一起回来)。
  if (r.mode === "team") {
    await haltTeam(r.id);
    const workers = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.parentId, r.id));
    for (const w of workers) {
      await db.update(tasks).set({ archived: true, archivedAt: ts, updatedAt: ts }).where(eq(tasks.id, w.id));
    }
  }
  await db.update(tasks).set({ archived: true, archivedAt: ts, updatedAt: ts }).where(eq(tasks.id, r.id));
  return c.json((await enrichTiming([(await db.select().from(tasks).where(eq(tasks.id, r.id))).at(0)!]))[0]);
});

api.post("/tasks/:id/unarchive", async (c) => {
  const r = (await db.select().from(tasks).where(eq(tasks.id, c.req.param("id")))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (!r.archived) return c.json((await enrichTiming([r]))[0]); // idempotent
  const ts = now();
  await db.update(tasks).set({ archived: false, archivedAt: null, updatedAt: ts }).where(eq(tasks.id, r.id));
  // 对称:团队回来了,它的工人也一起回来(归档时是整支队伍一起走的)
  if (r.mode === "team") {
    await db.update(tasks).set({ archived: false, archivedAt: null, updatedAt: ts }).where(eq(tasks.parentId, r.id));
  }
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
// 历史数据降级:老格式是 {kind:'cli',agentType} / {kind:'api',providerId},没有
// executorId。读到就当「没记过执行者」→ 解析退回默认执行者,不报错。
const parseBackend = (raw: string | null): AiBackend | null => {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<AiBackend>;
    return typeof v?.executorId === "string" ? { executorId: v.executorId } : null;
  } catch {
    return null;
  }
};

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
  aiBackend: parseBackend(r.aiBackend),
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
  status: (r.status as IssueComment["status"]) ?? null,
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
  const parsed = await parseIssue(b.text.trim(), {
    backend: b.backend ?? null,
    projects: projs.map((p) => ({ id: p.id, name: p.name, repoPath: p.repoPath })),
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
// runs an intent classifier: "execute" packs title + body + the whole thread
// into a task handed to that agent (worktree opt-in); "discuss" spawns a
// one-shot CLI (cwd=repoPath, soft-limited by prompt: 结论先行 / 压水分 / 别改
// 代码) and writes the reply back as an agent comment. Execution requires a
// project. API-model backends can parse but NOT execute — only CLI agent types
// are accepted here.
api.post("/issues/:id/comments", async (c) => {
  const iid = c.req.param("id");
  const issue = (await db.select().from(issues).where(eq(issues.id, iid))).at(0);
  if (!issue) return c.json({ error: "not found" }, 404);
  const b = await c.req.json<{ body?: string; mention?: AgentType; mentionTeam?: boolean; attachments?: string[]; useWorktree?: boolean }>();
  if (!b.body?.trim() && !b.attachments?.length) return c.json({ error: "empty" }, 400);
  if (b.mention) {
    if (!AGENT_TYPES.includes(b.mention)) return c.json({ error: "未知的 agent（只支持本地 CLI 智能体）", agent: b.mention }, 400);
    if (!issue.projectId) return c.json({ error: "事项还没归到项目，先归类再 @ 智能体" }, 409);
    // 「带一队」= 派一个团队任务,被 @ 的那个类型当指挥者 —— 它得支持常驻会话。
    // 在这儿挡住比等到 startTeam 里 throw 好:那时候任务已经建出来了,用户只看到一个
    // 刚生下来就 failed 的团队。
    if (b.mentionTeam) {
      const lead = await resolveExecutorFor({ type: b.mention }).catch(() => null);
      if (!lead?.openResident)
        return c.json({ error: `@${b.mention} 不支持常驻会话，当不了指挥者（换 @claude 带队）`, agent: b.mention }, 400);
    }
  }
  const ts = now();
  const crow = {
    id: id(),
    issueId: iid,
    author: JSON.stringify({ kind: "human" }), // 评论是人写的;@提及触发意图分类(讨论/执行)
    body: (b.body ?? "").trim(),
    attachments: JSON.stringify(b.attachments ?? []),
    createdAt: ts,
    updatedAt: null as string | null,
    status: null as string | null,
  };
  await db.insert(issueComments).values(crow);

  let task: Task | undefined;
  let agentComment: IssueComment | undefined;

  if (b.mention && issue.projectId) {
    const allComments = (await db.select().from(issueComments).where(eq(issueComments.issueId, iid))).sort((a, d) =>
      a.createdAt.localeCompare(d.createdAt),
    );
    // history 供分类器/讨论 CLI 参考 — 排除刚存的 @ 评论(它作为 mention 单独传)
    const history = allComments
      .filter((cm) => cm.id !== crow.id)
      .map((cm) => {
        let who = "我";
        try {
          const a = JSON.parse(cm.author);
          if (a?.kind === "agent") who = `@${a.agentType}`;
        } catch {
          /* default 我 */
        }
        return { who, body: cm.body };
      });
    const ctx = { issueTitle: issue.title, issueBody: issue.body, history, mention: crow.body };

    // 意图分类:跟 parseIssue 同一条路(issue 上记录的执行者)。
    // 拿不准/失败/超时一律 discuss —— 讨论便宜可逆,execute 一旦派出任务收不回。
    const backend = parseBackend(issue.aiBackend);
    const intent = await classifyMention(ctx, { backend });

    const proj = (await db.select().from(projects).where(eq(projects.id, issue.projectId))).at(0);

    if (intent === "discuss" && proj) {
      // 讨论:插一条 pending agent 评论,异步跑 CLI,跑完 update body+status。
      // 前端已有轮询会自然刷到 done/failed;这条 HTTP 请求不阻塞等 CLI。
      const arow = {
        id: id(),
        issueId: iid,
        author: JSON.stringify({ kind: "agent", agentType: b.mention }),
        body: "",
        attachments: "[]",
        createdAt: now(),
        updatedAt: null as string | null,
        status: "pending" as string | null,
      };
      await db.insert(issueComments).values(arow);
      agentComment = toComment(arow as typeof issueComments.$inferSelect);
      void (async () => {
        try {
          const out = await runAgentOnce(buildDiscussPrompt(ctx), {
            agentType: b.mention,
            cwd: proj.repoPath,
            timeoutMs: DISCUSS_TIMEOUT_MS,
          });
          const text = out.text.trim();
          if (text && out.ok) {
            await db.update(issueComments).set({ body: text, status: "done" }).where(eq(issueComments.id, arow.id));
          } else {
            await db.update(issueComments).set({ body: "(讨论回复为空,请重试或换一种问法)", status: "failed" }).where(eq(issueComments.id, arow.id));
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await db.update(issueComments).set({ body: `讨论出错: ${msg}`, status: "failed" }).where(eq(issueComments.id, arow.id));
        }
      })();
    } else {
      // execute: 建 task,worktree 按 opt-in,立即开跑。跟原来一致。
      // `mentionTeam`(界面上的「@claude · 带一队」)只换一件事:建出来的是 mode:"team"
      // 的常驻指挥台,它自己拆活派工人。团队不给指挥台开 worktree(工人是各自独立的任务、
      // 跑在项目目录,只把指挥者挪走会让两边看到不同的文件),隔离留给它派活时逐个开。
      const useWt = !b.mentionTeam && !!b.useWorktree && (proj ? projectHealthLight(proj.repoPath).isRepo : false);
      const tid = id();
      const trow = {
        id: tid,
        projectId: issue.projectId,
        groupId: null as string | null,
        parentId: null as string | null,
        title: issue.title,
        body: issueContext(issue, allComments),
        mode: b.mentionTeam ? "team" : "single",
        status: "backlog",
        priority: issue.priority,
        labels: "[]",
        dependsOn: "[]",
        resumeDependsOn: "[]",
        agentType: b.mention as AgentType,
        autoTitle: false,
        debate: null as string | null,
        // 被 @ 的类型当指挥者;工人缺省同类型(指挥者派活时可逐个改)
        team: b.mentionTeam ? JSON.stringify({ lead: b.mention, worker: b.mention }) : null,
        scheduleId: null as string | null,
        createdAt: ts,
        updatedAt: ts,
        useWorktree: useWt,
        worktreeBase: null as string | null,
        issueId: iid,
      };
      await db.insert(tasks).values(trow);
      await db.update(issues).set({ status: "in_progress", updatedAt: ts }).where(eq(issues.id, iid));
      void resumeOrRunTask(tid, { reason: "run" });
      task = (await enrichTiming([trow as typeof tasks.$inferSelect]))[0];
    }
  }
  return c.json({ comment: toComment(crow as typeof issueComments.$inferSelect), task, agentComment }, 201);
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

// ── 供应商 (relay, system-level) — 挂给执行者用,harness 不直连它跑推理 ────────
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

// Probe the available models for a connection. Used by the 智能体执行器 form to
// pick a default model. Accepts ad-hoc creds {protocol, baseUrl, apiKey} for the add
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
  const pid = c.req.param("id");
  await db.delete(llmProviders).where(eq(llmProviders.id, pid));
  // 挂着它的执行者退回官方账号 —— 留悬空 id 会让「供应商」下拉显示成空白选项。
  await db.update(agents).set({ providerId: null }).where(eq(agents.providerId, pid));
  return c.json({ deleted: true });
});

// ── queues (顺序依赖原语,DESIGN-scheduling.md §1) ─────────────────────────────
// 端点实现与 helper 都在 ./queues.ts(routes.ts 已经很长,队列语义集中一处更好改)。
mountQueueRoutes(api);

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

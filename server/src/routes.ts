import { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
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
  AgentType,
  LlmProvider,
  LlmProtocol,
} from "@harness/shared";
import { maxBytesFor, attachmentKind } from "@harness/shared";
import { isReasoningEffortSupported, normalizeReasoningEffort, reasoningEffortsFor } from "@harness/shared/cli-presets";
import { db } from "./db/index.js";
import { projects, groups, tasks, sessions, schedules, agents, llmProviders, notes, noteTasks } from "./db/schema.js";
import { bus } from "./bus.js";
import { id, now } from "./util.js";
import { listModels } from "./llm.js";
import { mountQueueRoutes } from "./queues.js";
import { detectKnownClis, detectLocalAgents } from "./detect.js";
import { searchAll } from "./search.js";
import { projectHealthLight, projectHealthFull, tidyRepoPath, repoKey, listBranches } from "./git.js";
import { getGitOverview } from "./git-overview.js";
import { discardTaskWorkspace } from "./workspace-cleanup.js";
import { mountDebateIterationRoutes } from "./debate/iteration.js";
import { mountNoteRoutes } from "./notes.js";
import { mountTeamPresetRoutes } from "./team-presets.js";
import { findWorkflow, mountWorkflowRoutes } from "./workflows.js";
import { getAppSettings, parseAppSettingsPatch, patchAppSettings } from "./app-settings.js";
import { mountTaskRoutes } from "./task-routes.js";
import { mountTaskRunRoutes } from "./task-run-routes.js";
import { mountOpenAiConverterRoutes } from "./openai-converter/routes.js";
import { mountProviderTestRoutes } from "./provider-test.js";

export const api = new Hono();
mountNoteRoutes(api);

// ── health ───────────────────────────────────────────────────────────────
api.get("/health", (c) => c.json({ ok: true, ts: now() }));

// 「现在重启会打断谁」。scripts/restart.sh 的安全闸靠它决定拦不拦 —— 只数
// running/queued 的个数已经不对了：agent 输出走文件之后，多数单飞任务重启不会断。
// 动态 import：这条路只在人工重启时被打一次，没必要把 reattach 那条链拉进启动路径。
api.get("/restart-impact", async (c) => {
  const { restartImpact } = await import("./reattach.js");
  return c.json(await restartImpact());
});

// ── global settings ──────────────────────────────────────────────────────
api.get("/settings", async (c) => c.json(await getAppSettings()));

api.patch("/settings", async (c) => {
  try {
    const patch = parseAppSettingsPatch(await c.req.json<unknown>());
    return c.json(await patchAppSettings(patch));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

// ── search ───────────────────────────────────────────────────────────────
// Global search across tasks + session transcripts (see search.ts).
// Sub-2-char queries return empty instead of erroring — the palette calls this
// on every keystroke.
api.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 2) return c.json([]);
  const projectId = (c.req.query("projectId") ?? "").trim() || undefined;
  const type = (c.req.query("type") ?? "").trim();
  if (type && type !== "tasks" && type !== "notes") {
    return c.json({ error: "type must be tasks or notes" }, 400);
  }
  const searchType = type === "tasks" || type === "notes" ? type : undefined;
  return c.json(await searchAll(q, { projectId, type: searchType }));
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
// 已知 CLI 目录:含上面那几个可执行器(带 type),外加一批只做「装没装」展示的。
api.get("/agents/catalog", async (c) => c.json(await detectKnownClis()));

api.post("/agents", async (c) => {
  const b = await c.req.json<any>();
  const type = b.type as AgentType;
  const model = b.model?.trim() || null;
  if (b.reasoningEffort && !isReasoningEffortSupported(type, model, b.reasoningEffort)) {
    return c.json({
      error: `${type} 模型 ${model ?? "（跟随 CLI）"} 不支持思考强度 ${b.reasoningEffort}`,
      allowedReasoningEfforts: reasoningEffortsFor(type, model),
    }, 400);
  }
  const row = {
    id: id(),
    name: b.name,
    type,
    target: JSON.stringify(b.target ?? { kind: "local" }),
    model,
    extraArgs: JSON.stringify(b.extraArgs ?? []),
    reasoningEffort: normalizeReasoningEffort(type, model, b.reasoningEffort),
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
  const type = existing.type as AgentType;
  const nextModel = b.model !== undefined ? b.model?.trim() || null : existing.model;
  const requestedEffort = b.reasoningEffort !== undefined ? b.reasoningEffort : existing.reasoningEffort;
  if (b.reasoningEffort && !isReasoningEffortSupported(type, nextModel, b.reasoningEffort)) {
    return c.json({
      error: `${type} 模型 ${nextModel ?? "（跟随 CLI）"} 不支持思考强度 ${b.reasoningEffort}`,
      allowedReasoningEfforts: reasoningEffortsFor(type, nextModel),
    }, 400);
  }
  if (b.model !== undefined) patch.model = nextModel;
  if (b.target !== undefined) patch.target = JSON.stringify(b.target);
  if (b.extraArgs !== undefined) patch.extraArgs = JSON.stringify(b.extraArgs);
  if (b.reasoningEffort !== undefined || b.model !== undefined) {
    patch.reasoningEffort = normalizeReasoningEffort(type, nextModel, requestedEffort);
  }
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
  const row = { id: id(), name: b.name.trim(), repoPath: tidyRepoPath(b.repoPath), apiKeys: null, workflowId: null, createdAt: now() };
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
  const row = { id: id(), name, repoPath, apiKeys: null, workflowId: null, createdAt: now() };
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
  // 项目默认起手式：空串/null 都表示「跟随全局默认」，存成 null 保持一种写法
  if (b.workflowId !== undefined) {
    if (b.workflowId !== null && typeof b.workflowId !== "string") {
      return c.json({ error: "workflowId 必须是字符串或 null" }, 400);
    }
    const wid = typeof b.workflowId === "string" ? b.workflowId.trim() : "";
    if (wid && !(await findWorkflow(wid))) return c.json({ error: "起手式不存在" }, 400);
    patch.workflowId = wid || null;
  }
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
  if (ptasks.length) await db.delete(noteTasks).where(inArray(noteTasks.taskId, ptasks.map((task) => task.id)));
  await db.delete(tasks).where(eq(tasks.projectId, pid));
  await db.delete(groups).where(eq(groups.projectId, pid));
  const projectNotes = await db.select({ id: notes.id }).from(notes).where(eq(notes.projectId, pid));
  if (projectNotes.length) await db.delete(noteTasks).where(inArray(noteTasks.noteId, projectNotes.map((note) => note.id)));
  await db.delete(notes).where(eq(notes.projectId, pid));
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

// Read-only command-palette view: local branches plus every registered worktree.
// It deliberately bypasses repo-lock because neither git command mutates refs,
// indexes, or the worktree registry.
api.get("/projects/:id/git-overview", async (c) => {
  const p = (await db.select().from(projects).where(eq(projects.id, c.req.param("id")))).at(0);
  if (!p) return c.json({ error: "not found" }, 404);
  return c.json(await getGitOverview(p.repoPath));
});

// 清理某个任务留下的 worktree 目录 / 分支。任务行这时通常已经被删掉了(删除时
// 没勾选、或勾了但 git 拒绝),所以入口挂在 project 上、只按 taskId 推导路径与
// 分支名 —— 不查任务表,删掉的任务照样能收拾干净。逐项结果原样回给 UI:git 拒绝
// (脏 worktree / 未合并分支)是要展示给用户的信息,不是 500。
api.post("/projects/:id/workspaces/discard", async (c) => {
  const p = (await db.select().from(projects).where(eq(projects.id, c.req.param("id")))).at(0);
  if (!p) return c.json({ error: "not found" }, 404);
  const b = await c.req.json<{ taskId: string; worktree?: boolean; branch?: boolean; force?: boolean }>();
  if (!b?.taskId) return c.json({ error: "taskId required" }, 400);
  return c.json(
    await discardTaskWorkspace(p.repoPath, b.taskId, {
      worktree: b.worktree !== false,
      branch: b.branch !== false,
      force: !!b.force,
    }),
  );
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

mountTaskRoutes(api);
mountTaskRunRoutes(api);
// ── 供应商 (relay, system-level) — 挂给执行器用,harness 不直连它跑推理 ────────
const toProvider = (r: typeof llmProviders.$inferSelect): LlmProvider => ({
  id: r.id,
  name: r.name,
  protocol: r.protocol as LlmProtocol,
  baseUrl: r.baseUrl,
  model: r.model,
  protocolConversionEnabled: r.protocolConversionEnabled,
  modelListMode: r.modelListMode === "pinned" ? "pinned" : "api",
  pinnedModels: parsePinnedModels(r.pinnedModels),
  hasKey: !!r.apiKey, // never return the key itself
  createdAt: r.createdAt,
});

// 固定模型列表:去空白、去重、保序。存的是 json string[],但老行/脏数据都得能读回来。
function parsePinnedModels(raw: unknown): string[] {
  const list = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return []; } })() : raw;
  if (!Array.isArray(list)) return [];
  return normalizePinnedModels(list);
}

function normalizePinnedModels(list: unknown[]): string[] {
  const seen = new Set<string>();
  for (const item of list) {
    const model = typeof item === "string" ? item.trim() : "";
    if (model) seen.add(model);
  }
  return [...seen];
}

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
  const protocol = b.protocol === "anthropic" ? "anthropic" : "openai";
  const row = {
    id: id(),
    name: b.name.trim(),
    protocol,
    baseUrl: b.baseUrl.trim(),
    apiKey: (b.apiKey ?? "").trim(),
    model: (b.model ?? "").trim(),
    protocolConversionEnabled: protocol === "openai" && b.protocolConversionEnabled === true,
    modelListMode: b.modelListMode === "pinned" ? "pinned" : "api",
    pinnedModels: JSON.stringify(normalizePinnedModels(b.pinnedModels ?? [])),
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
  // 模式与固定列表各自独立更新:切模式不清空已固定的模型,切回来还在(需求「随便切换」)。
  if (b.modelListMode !== undefined) patch.modelListMode = b.modelListMode === "pinned" ? "pinned" : "api";
  if (b.pinnedModels !== undefined) patch.pinnedModels = JSON.stringify(normalizePinnedModels(b.pinnedModels ?? []));
  const nextProtocol = b.protocol === undefined ? existing.protocol : b.protocol === "anthropic" ? "anthropic" : "openai";
  if (nextProtocol === "anthropic") patch.protocolConversionEnabled = false;
  else if (b.protocolConversionEnabled !== undefined) patch.protocolConversionEnabled = b.protocolConversionEnabled === true;
  if (b.apiKey) patch.apiKey = b.apiKey; // 只在传了非空 key 时更新(留空=不动)
  await db.update(llmProviders).set(patch).where(eq(llmProviders.id, pid));
  const updated = (await db.select().from(llmProviders).where(eq(llmProviders.id, pid))).at(0)!;
  return c.json(toProvider(updated));
});

api.delete("/llm-providers/:id", async (c) => {
  const pid = c.req.param("id");
  await db.delete(llmProviders).where(eq(llmProviders.id, pid));
  // 挂着它的执行器退回官方账号 —— 留悬空 id 会让「供应商」下拉显示成空白选项。
  await db.update(agents).set({ providerId: null }).where(eq(agents.providerId, pid));
  return c.json({ deleted: true });
});

mountOpenAiConverterRoutes(api);
mountProviderTestRoutes(api);

// ── queues (顺序依赖原语,DESIGN-scheduling.md §1) ─────────────────────────────
// 端点实现与 helper 都在 ./queues.ts(routes.ts 已经很长,队列语义集中一处更好改)。
mountQueueRoutes(api);
mountDebateIterationRoutes(api);
mountTeamPresetRoutes(api);
mountWorkflowRoutes(api);

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

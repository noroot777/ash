import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getConnInfo } from "@hono/node-server/conninfo";
import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { UPLOADS_DIR } from "./paths.js";
import type {
  Group,
  AgentType,
  LlmProvider,
  LlmProtocol,
} from "@ash/shared";
import { maxBytesFor, attachmentKind } from "@ash/shared";
import { isReasoningEffortSupported, normalizeReasoningEffort, reasoningEffortsFor } from "@ash/shared/cli-presets";
import { normalizeCliConfigOverrides, cliConfigOverrideErrors, readCliConfigOverrides } from "@ash/shared/cli-overrides";
import { db } from "./db/index.js";
import { projects, groups, tasks, agents, llmProviders } from "./db/schema.js";
import { bus } from "./bus.js";
import { id, now } from "./util.js";
import { listModels } from "./llm.js";
import { mountQueueRoutes } from "./queues.js";
import { detectKnownClis, detectLocalAgents } from "./detect.js";
import { cliHostEnv } from "./executors/cli-env.js";
import { searchAll } from "./search.js";
import { repoKey } from "./git.js";
import { mountDuetIterationRoutes } from "./duet/iteration.js";
import { mountNoteRoutes } from "./notes.js";
import { mountTeamPresetRoutes } from "./team-presets.js";
import { mountWorkflowRoutes } from "./workflows.js";
import { mountPreviewRoutes } from "./preview-routes.js";
import { getAppSettings, parseAppSettingsPatch, patchAppSettings } from "./app-settings.js";
import { hostInfo } from "./platform.js";
import { mountSkillRoutes } from "./skill-routes.js";
import { mountModelRoutes } from "./model-routes.js";
import { mountTaskRoutes } from "./task-routes.js";
import { mountGroupRoutes } from "./group-routes.js";
import { mountTaskRunRoutes } from "./task-run-routes.js";
import { mountHandoffRoutes } from "./handoff-routes.js";
import { mountFileRoutes } from "./file-routes.js";
import { mountProjectGitRoutes } from "./project-git-routes.js";
import { mountScmRoutes } from "./scm-routes.js";
import { mountTaskDiffRoutes } from "./task-diff-routes.js";
import { mountOpenAiConverterRoutes } from "./openai-converter/routes.js";
import { mountProviderTestRoutes } from "./provider-test.js";
import { mountTerminalRoutes } from "./terminal.js";
import { mountFreeWorkflowRoutes } from "./free-workflow-routes.js";
import { mountReviewerProfileRoutes } from "./reviewer-profiles.js";
import { mountLocalOpenRoutes } from "./local-open-routes.js";
import { directoryPickerSupport, mountDirectoryPickerRoutes } from "./dir-picker.js";
import { mountProjectCloneRoutes } from "./project-clone.js";
import { mountProjectRoutes } from "./project-routes.js";

export const api = new Hono();
mountNoteRoutes(api);
mountLocalOpenRoutes(api);
mountDirectoryPickerRoutes(api);
mountProjectRoutes(api);
mountProjectCloneRoutes(api);

// ── health ───────────────────────────────────────────────────────────────
// `pid` 是给 scripts/restart.mjs 认人用的:它重启完要确认「端口上应答的是我刚起的
// 那个进程」,而不是「端口上有人应答」。少了这个字段,旧进程没被杀掉时(容器里没有
// lsof/ss 就会这样)整条重启会安静地失败成一句「✓ 已就绪」。
api.get("/health", (c) => c.json({ ok: true, ts: now(), pid: process.pid }));

// 「现在重启会打断谁」。scripts/restart.mjs 的安全闸靠它决定拦不拦 —— 只数
// running/queued 的个数已经不对了：agent 输出走文件之后，多数单飞任务重启不会断。
// 动态 import：这条路只在人工重启时被打一次，没必要把 reattach 那条链拉进启动路径。
api.get("/restart-impact", async (c) => {
  const { restartImpact } = await import("./reattach.js");
  return c.json(await restartImpact());
});

// ── global settings ──────────────────────────────────────────────────────
// 「server 跑在哪台机器上」。**不进 /settings** —— 那是一张可写的持久化设置表
// (`app-settings.ts` 用 satisfies 钉住了键集),这条是只读的运行时事实。前端拿它
// 决定路径提示按什么形状给(浏览器所在系统不算数,项目目录在服务端这台机器上)。
//
// `canPickDirectory` 得按**这一次请求**算:文件选择窗口弹在服务端桌面上,只有本机打开
// 的浏览器用得上(见 dir-picker.ts)。所以它不进 hostInfo() —— 那是台机器的静态事实,
// 这条跟调用方是谁有关。
api.get("/host", (c) => c.json({
  ...hostInfo(),
  canPickDirectory: directoryPickerSupport(getConnInfo(c).remote.address).available,
}));

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
  model: r.model ?? undefined,
  extraArgs: JSON.parse(r.extraArgs),
  reasoningEffort: r.reasoningEffort ?? undefined,
  speed: r.speed ?? undefined,
  providerId: r.providerId ?? null,
  // 读端不直接 JSON.parse:库里可能躺着升级前写下的越界值、甚至被手工改坏的
  // JSON —— 前者会让页面显示的数跟执行器实际注入的不是一个,后者直接把这个接口
  // 打成 500(设置页整页打不开)。跟执行器读的是同一份判据。
  configOverrides: readCliConfigOverrides(r.type, r.configOverrides),
  isDefault: r.isDefault,
});

api.get("/agents", async (c) => c.json((await db.select().from(agents)).map(toAgent)));

// Detect which agent CLIs are installed on the local machine (§5).
api.get("/agents/detect", async (c) => c.json(await detectLocalAgents()));
// 已知 CLI 目录:含上面那几个可执行器(带 type),外加一批只做「装没装」展示的。
api.get("/agents/catalog", async (c) => c.json(await detectKnownClis()));
// ash 起 CLI 时它会看到的环境事实(只读,不是配置项)。设置页要拿它换算压缩触发点:
// 有效窗口 = 窗口 − min(CLAUDE_CODE_MAX_OUTPUT_TOKENS, 20000),而那个变量在 server 进程里,
// 前端算不出来 —— 不报过去的话,页面上写的水位和 CLI 的实际行为会对不上。
api.get("/agents/cli-env", (c) => c.json(cliHostEnv()));

// `/技能` 的三个端点在 `skill-routes.ts`(cwd 取项目仓库根)。
mountSkillRoutes(api);
// 模型清单(现问 CLI + 刷新)在 `model-routes.ts`。
mountModelRoutes(api);

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
  // CLI 配置覆盖:有的键单独填是空转的(claude 的触发百分比要配合窗口才生效)。
  // 前端已经拦了一道,这里是权威那道 —— API 直连、旧前端、脚本改配置都过这里。
  const configOverrides = normalizeCliConfigOverrides(type, b.configOverrides);
  const overrideErrors = cliConfigOverrideErrors(type, configOverrides);
  if (overrideErrors.length) return c.json({ error: overrideErrors.join("；") }, 400);
  const row = {
    id: id(),
    name: b.name,
    type,
    model,
    extraArgs: JSON.stringify(b.extraArgs ?? []),
    reasoningEffort: normalizeReasoningEffort(type, model, b.reasoningEffort),
    // 只落 "fast";"standard"/空 归一成 null(标准=不传参,单一表示)
    speed: b.speed === "fast" ? "fast" : null,
    providerId: b.providerId || null,
    configOverrides: JSON.stringify(configOverrides),
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
  if (b.extraArgs !== undefined) patch.extraArgs = JSON.stringify(b.extraArgs);
  if (b.reasoningEffort !== undefined || b.model !== undefined) {
    patch.reasoningEffort = normalizeReasoningEffort(type, nextModel, requestedEffort);
  }
  if (b.speed !== undefined) patch.speed = b.speed === "fast" ? "fast" : null;
  if (b.providerId !== undefined) patch.providerId = b.providerId || null;
  if (b.configOverrides !== undefined) {
    const configOverrides = normalizeCliConfigOverrides(type, b.configOverrides);
    const overrideErrors = cliConfigOverrideErrors(type, configOverrides);
    if (overrideErrors.length) return c.json({ error: overrideErrors.join("；") }, 400);
    patch.configOverrides = JSON.stringify(configOverrides);
  }
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
// 分组(批次容器)路由:列表/运行/暂停/批量建任务(从 task-routes.ts 拆出)。
mountGroupRoutes(api);
mountTaskRunRoutes(api);
// 任务接力:探活/预检/导出/导入(实现在 ./handoff.ts 与 ./handoff-import.ts)。
mountHandoffRoutes(api);
// 任务工作目录的只读文件浏览 + 交给本机去做的三个动作(实现在 ./file-routes.ts)。
mountFileRoutes(api);
mountScmRoutes(api);
mountProjectGitRoutes(api);
// 任务分支相对合入目标的只读 diff:整份 + 单文件(从 task-accept.ts 拆出,它管的是验收本身)。
mountTaskDiffRoutes(api);
// ── 供应商 (relay, system-level) — 挂给执行器用,ash 不直连它跑推理 ────────
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
mountTerminalRoutes(api);

// ── queues (顺序依赖原语) ────────────────────────────────────────────────────
// 端点实现与 helper 都在 ./queues.ts(routes.ts 已经很长,队列语义集中一处更好改)。
mountQueueRoutes(api);
mountDuetIterationRoutes(api);
mountTeamPresetRoutes(api);
mountWorkflowRoutes(api);
mountPreviewRoutes(api);
mountReviewerProfileRoutes(api);
mountFreeWorkflowRoutes(api);

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

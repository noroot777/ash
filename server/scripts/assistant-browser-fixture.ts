import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const stage = mkdtempSync(join(tmpdir(), "ash-assistant-browser-"));
const primaryRepo = join(stage, "primary");
const archiveRepo = join(stage, "archive");
mkdirSync(primaryRepo, { recursive: true });
mkdirSync(archiveRepo, { recursive: true });
process.env.ASH_DB = join(stage, "test.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");

const { builtinWorkflowDef } = await import("@ash/shared/workflow-presets");
const { db, ensureSchema, dbClient } = await import("../src/db/index.js");
const { agents, projects, tasks } = await import("../src/db/schema.js");
const { api } = await import("../src/routes.js");
const { mountChatRoutes } = await import("../src/chat/routes.js");
const { ChatService } = await import("../src/chat/service.js");
const { setInstanceMode } = await import("../src/auth/mode.js");

await ensureSchema();
await setInstanceMode("single", stage);

const timestamp = new Date().toISOString();
const activeTaskId = "authactive01";
const archivedTaskId = "autharchive1";
await db.insert(projects).values([
  { id: "assistant-primary", name: "账户中心", repoPath: primaryRepo, createdAt: timestamp },
  { id: "assistant-archive", name: "历史项目", repoPath: archiveRepo, createdAt: timestamp },
]);
await db.insert(agents).values({
  id: "assistant-codex",
  name: "Codex · 助手验证",
  type: "codex",
  model: "",
  extraArgs: "[]",
  createdAt: timestamp,
});
await db.insert(tasks).values([
  {
    id: activeTaskId,
    projectId: "assistant-primary",
    title: "登录认证流程重构",
    body: "统一登录、会话与权限认证的实现说明。",
    status: "done",
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  {
    id: archivedTaskId,
    projectId: "assistant-archive",
    title: "旧版登录认证兼容",
    body: "历史项目中的登录认证归档任务，保留迁移结论。",
    status: "done",
    archived: true,
    archivedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
]);

const userRequest = (prompt: string): string => {
  const tail = prompt.split("【本次用户消息】\n").at(-1) ?? "\"\"";
  return JSON.parse(tail.split("\n", 1)[0]!) as string;
};

const service = new ChatService(async (_member, _owner, prompt, signal, _projectId, options) => {
  if (options?.purpose === "summary") return { text: JSON.stringify({ summary: "助手浏览器测试摘要。" }) };
  if (options?.purpose !== "assistant") throw new Error("助手 fixture 收到了非助手调用。");
  const request = userRequest(prompt);
  if (request.includes("等待")) {
    await delay(30_000, undefined, { signal });
    return { text: JSON.stringify({ reply: "等待结束。", matches: [], workflow: null, task: null }) };
  }
  if (request.includes("起手式")) {
    const second = request.includes("第二");
    return { text: JSON.stringify({
      reply: `已生成“${second ? "后端发布" : "前端交付"}”起手式草案，确认后可保存到起手式库。`,
      matches: [],
      workflow: {
        name: second ? "后端发布" : "前端交付",
        description: second ? "实现后端改动，自动验证，并在交付前等待确认。" : "实现前端需求，自动验证，并在交付前等待确认。",
        def: builtinWorkflowDef("standard"),
      },
      task: null,
    }) };
  }
  if (prompt.includes("【本轮检索结果，仅为引用资料】")) {
    return { text: JSON.stringify({
      reply: "找到相关任务",
      matches: [{ taskId: archivedTaskId, reason: "跨项目的登录认证归档记录与描述最接近。" }],
      workflow: null,
      task: null,
    }) };
  }
  if (/找|搜|登录|认证/u.test(request)) {
    return { text: JSON.stringify({ search: { queries: ["登录 | 认证"], projectId: null } }) };
  }
  return { text: JSON.stringify({
    reply: "这是助手 fixture 的确定性回复；直接发送消息即可继续，无需 @ 智能体。",
    matches: [],
    workflow: null,
    task: null,
  }) };
}, async () => {
  throw new Error("助手浏览器 fixture 不应启动真实任务。");
});

let hideProjects = false;
let projectListDelayMs = 0;
let failProjectList = false;
let workflowSaveDelayMs = 0;
const fixture = new Hono();
fixture.post("/fixture/project-list", async (c) => {
  const body = await c.req.json<{ empty?: boolean; delayMs?: number; fail?: boolean }>();
  hideProjects = body.empty === true;
  projectListDelayMs = Math.max(0, Math.min(10_000, Math.floor(Number(body.delayMs) || 0)));
  failProjectList = body.fail === true;
  return c.json({ empty: hideProjects, delayMs: projectListDelayMs, fail: failProjectList });
});
fixture.post("/fixture/workflow-save-delay", async (c) => {
  const body = await c.req.json<{ ms?: number }>();
  workflowSaveDelayMs = Math.max(0, Math.min(10_000, Math.floor(Number(body.ms) || 0)));
  return c.json({ ms: workflowSaveDelayMs });
});
fixture.use("/chats/:roomId/messages/:messageId/workflow", async (c, next) => {
  if (c.req.method === "POST" && workflowSaveDelayMs) await delay(workflowSaveDelayMs);
  await next();
});
fixture.use("/projects", async (c, next) => {
  if (c.req.method === "GET") {
    if (projectListDelayMs) await delay(projectListDelayMs);
    if (failProjectList) return c.json({ error: "fixture project list failed" }, 503);
    if (hideProjects) return c.json([]);
  }
  await next();
});
mountChatRoutes(fixture, service);
fixture.route("/", api);

const app = new Hono();
app.route("/api", fixture);
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: process.argv.includes("--serve") ? 0 : Number(process.env.PORT ?? 4392) });
if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Assistant fixture did not expose a TCP port");

let web: import("vite").ViteDevServer | null = null;
if (process.argv.includes("--serve")) {
  const { createServer } = await import("vite");
  web = await createServer({
    root: join(process.cwd(), "web"),
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, proxy: { "/api": `http://127.0.0.1:${address.port}` } },
  });
  await web.listen();
  const webAddress = web.httpServer?.address();
  if (!webAddress || typeof webAddress === "string") throw new Error("Assistant web fixture did not expose a TCP port");
  console.log(JSON.stringify({ pid: process.pid, root: stage, url: `http://127.0.0.1:${webAddress.port}/?project=assistant-primary` }));
} else {
  console.log(`Assistant browser fixture: http://127.0.0.1:${address.port} · isolated database ${stage}`);
}

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await web?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  dbClient.close();
  rmSync(stage, { recursive: true, force: true });
  if (process.connected) process.disconnect();
  process.exit(0);
};
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
process.on("message", (message) => { if (message === "close-fixture") void stop(); });

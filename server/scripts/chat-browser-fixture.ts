import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";

const stage = mkdtempSync(join(tmpdir(), "ash-chat-browser-"));
process.env.ASH_DB = join(stage, "test.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
const { db, ensureSchema, dbClient } = await import("../src/db/index.js");
const { projects, agents, tasks } = await import("../src/db/schema.js");
const { api } = await import("../src/routes.js");
const { mountChatRoutes } = await import("../src/chat/routes.js");
const { ChatService } = await import("../src/chat/service.js");
const { setTaskStatus } = await import("../src/status.js");
await ensureSchema();
const { setInstanceMode } = await import("../src/auth/mode.js");
await setInstanceMode("single", stage);
const timestamp = new Date().toISOString();
await db.insert(projects).values({ id: "chat-demo", name: "Studio / 研发空间", repoPath: stage, createdAt: timestamp });
await db.insert(agents).values([
  { id: "chat-codex", name: "Codex · 工程", type: "codex", model: "", extraArgs: "[]", createdAt: timestamp },
  { id: "chat-claude", name: "Claude · 设计", type: "claude", model: "", extraArgs: "[]", createdAt: timestamp },
]);
const service = new ChatService(async (member, _owner, prompt, signal) => {
  const text = JSON.parse(prompt.split("【本次用户消息】\n").at(-1)!) as string;
  await delay(text.includes("等待") ? 30000 : 1200, undefined, { signal });
  return JSON.stringify({
    reply: text.includes("实现") ? "收到，我会把这项工作建成任务。进度会在这里更新。" : member.name === "claude" ? "建议保留清晰的频道导航，把任务进度嵌入消息流。动效以入场和状态反馈为主。" : "建议先跑通点名唤醒，再连接任务状态。@claude 这条点名只展示，不会自动唤醒。",
    task: text.includes("实现") ? { title: "实现频道导航与任务状态卡", body: "浏览器验证用任务，不运行真实智能体。" } : null,
  });
}, async (taskId) => {
  await setTaskStatus(taskId, "running");
  await delay(5000);
  await db.update(tasks).set({ body: "浏览器测试产物：频道导航和任务状态已通过模拟流程验证。" }).where(eq(tasks.id, taskId));
  await setTaskStatus(taskId, "done");
});
const fixture = new Hono();
mountChatRoutes(fixture, service);
fixture.route("/", api);
const app = new Hono();
app.route("/api", fixture);
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: Number(process.env.PORT ?? 4391) }, (info) => {
  console.log(`Chat browser fixture: http://127.0.0.1:${info.port} · isolated database ${stage}`);
});
const stop = () => {
  server.close();
  dbClient.close();
  rmSync(stage, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

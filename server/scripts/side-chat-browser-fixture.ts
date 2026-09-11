import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";

const stage = mkdtempSync(join(tmpdir(), "ash-side-browser-"));
process.env.ASH_DB = join(stage, "test.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
const { db, ensureSchema, dbClient } = await import("../src/db/index.js");
const { projects, agents, tasks, scheduledMessages } = await import("../src/db/schema.js");
const { ChatService } = await import("../src/chat/service.js");
const { mountChatRoutes } = await import("../src/chat/routes.js");
const { setInstanceMode } = await import("../src/auth/mode.js");
const runs = await import("../src/runs.js");
await ensureSchema(); await setInstanceMode("single", stage);
const timestamp = new Date().toISOString();
await db.insert(projects).values({ id: "p", name: "ash", repoPath: stage, createdAt: timestamp });
await db.insert(agents).values({ id: "side-codex", name: "Codex", type: "codex", model: "", extraArgs: "[]", isDefault: true, createdAt: timestamp });
for (const id of ["parent", "other"]) await db.insert(tasks).values({ id, projectId: "p", title: id === "parent" ? "实现任务消息回传" : "另一个主任务", body: `${id} 的主任务背景：比较方案 A 和 B。`, mode: "single", status: "running", agentType: "codex", executorId: "side-codex", activeTurnToken: "turn", activeDirectionToken: "direction", createdAt: timestamp, updatedAt: timestamp });
const delivered: string[] = [];
let kills = 0;
const native = { kill: () => { kills++; }, steer: async (text: string) => { delivered.push(text); } };
const plain = { kill: () => { kills++; } };
function bind(enabled: boolean) {
  runs.untrackRun("parent", enabled ? plain : native);
  const handle = enabled ? native : plain;
  runs.trackRun("parent", handle);
  if (enabled) runs.bindNativeSteer("parent", native, { agentType: "codex", record: () => {} });
}
runs.claimTurn("parent", "single"); bind(true);
const service = new ChatService(async (_member, _owner, prompt, signal, _project, options) => {
  if (options?.purpose === "summary") return { text: '{"summary":"对比方案 A/B"}' };
  const source = JSON.parse(prompt.split("【当前用户消息】\n").at(-1)!) as string;
  await delay(source.includes("等待") ? 30000 : 350, undefined, { signal });
  return { text: JSON.stringify({ reply: source.includes("告诉主任务") ? "回传结论：选择方案 B，复用现有消息队列，并补上投递回执。" : "**建议选择方案 B。**\n\n主任务继续实现，这里可以单独讨论。\n\n- 复用已持久化的消息队列\n- 支持实时追加时立即送达\n- 回执显示实际投递状态",
    forward: source.includes("告诉主任务") ? { text: "选择方案 B，复用现有消息队列，补上投递回执。", authorization: "把结论告诉主任务" } : null }) };
});
const api = new Hono();
mountChatRoutes(api, service);
api.get("/agents", async (c) => c.json(await db.select().from(agents)));
api.get("/fixture/state", async (c) => c.json({ delivered, kills, pending: await db.select().from(scheduledMessages) }));
api.post("/fixture/native", async (c) => { bind((await c.req.json()).enabled); return c.json({ ok: true }); });
api.post("/fixture/cancel", async (c) => { await db.update(scheduledMessages).set({ status: "canceled" }).where(eq(scheduledMessages.status, "pending")); return c.json({ ok: true }); });
const app = new Hono(); app.route("/api", api);
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => console.log(`SIDE_FIXTURE_URL=http://127.0.0.1:${info.port}`));
const stop = () => { server.close(); dbClient.close(); rmSync(stage, { recursive: true, force: true }); process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);

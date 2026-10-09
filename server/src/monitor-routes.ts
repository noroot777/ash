// 哨兵的 HTTP 面。真正的编排在 monitors.ts，这里只做入参校验和权限归属。
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { MONITOR_MAX_TIMEOUT_MS, MONITOR_MIN_TIMEOUT_MS } from "@ash/shared/monitor";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { actorOf, ownerIdOf } from "./auth/context.js";
import { getMonitor, listMonitors, readMonitorTail, startMonitor, stopMonitor } from "./monitors.js";

export function mountMonitorRoutes(api: Hono): void {
  api.get("/tasks/:id/monitors", async (c) => c.json(await listMonitors(c.req.param("id"))));

  api.post("/tasks/:id/monitors", async (c) => {
    const taskId = c.req.param("id");
    type StartBody = { command?: string; description?: string; cwd?: string; timeoutMs?: number };
    const body = await c.req.json<StartBody>().catch((): StartBody => ({}));
    if (typeof body.command !== "string" || !body.command.trim())
      return c.json({ error: "command 不能为空" }, 400);
    if (body.timeoutMs !== undefined && (typeof body.timeoutMs !== "number" || !Number.isFinite(body.timeoutMs)))
      return c.json({ error: "timeoutMs 必须是毫秒数" }, 400);
    // 越界不报错只钳住（normalizeMonitorTimeout），但得让调用方知道自己写的没生效。
    const clamped =
      body.timeoutMs !== undefined && (body.timeoutMs < MONITOR_MIN_TIMEOUT_MS || body.timeoutMs > MONITOR_MAX_TIMEOUT_MS);
    const result = await startMonitor({
      taskId,
      command: body.command,
      description: body.description,
      cwd: body.cwd,
      timeoutMs: body.timeoutMs,
      ownerUserId: ownerIdOf(actorOf(c)),
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ monitor: result.monitor, ...(clamped ? { notice: "timeoutMs 超出允许区间，已钳到边界" } : {}) });
  });

  // 日志尾巴。面板按需拉取（点开那一张卡才问），所以不塞进列表响应里——几十个哨兵
  // 的尾巴一起走会让任务页每次刷新都背上几百 KB。
  api.get("/monitors/:monitorId/log", async (c) => {
    const lines = Number(c.req.query("lines"));
    const tail = await readMonitorTail(
      c.req.param("monitorId"),
      Number.isFinite(lines) && lines > 0 ? lines : undefined,
    );
    if (!tail) return c.json({ error: "哨兵不存在" }, 404);
    return c.json(tail);
  });

  api.post("/monitors/:monitorId/stop", async (c) => {
    const monitorId = c.req.param("monitorId");
    const body = await c.req.json<{ reason?: string }>().catch((): { reason?: string } => ({}));
    const existing = await getMonitor(monitorId);
    if (!existing) return c.json({ error: "哨兵不存在" }, 404);
    const task = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, existing.taskId))).at(0);
    if (!task) return c.json({ error: "哨兵所属任务已不存在" }, 404);
    const monitor = await stopMonitor(monitorId, body.reason?.trim() || "被停掉了");
    return c.json({ monitor });
  });
}

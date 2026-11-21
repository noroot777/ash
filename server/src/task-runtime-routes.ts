import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { parseBrowserAction } from "@navi/shared/task-runtime";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { actorOf } from "./auth/context.js";
import { requireTaskAccess } from "./auth/visibility.js";
import { developmentService, startDevelopmentService, stopDevelopmentService } from "./task-runtime-service.js";
import { refreshBrowserFrame, taskBrowserAction, taskBrowserState } from "./task-browser.js";
import { browserFrame } from "./task-browser-store.js";
import { runtimeCaller } from "./task-runtime-auth.js";
import { computerUseFrame } from "./computer-preview.js";

const errorBody = (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) });

export function mountTaskRuntimeRoutes(api: Hono): void {
  api.get("/tasks/:id/runtime", async (c) => {
    const taskId = c.req.param("id");
    await requireTaskAccess(actorOf(c), taskId);
    c.header("cache-control", "no-store");
    return c.json({ service: developmentService(taskId), browser: taskBrowserState(taskId), computer: computerUseFrame(taskId) });
  });
  api.post("/tasks/:id/runtime/service", async (c) => {
    const taskId = c.req.param("id");
    try {
      const caller = await runtimeCaller(c, taskId);
      const authorize = async () => {
        await caller.authorize();
        if (!caller.agent) {
          const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
          if (task?.activeTurnToken || task?.status === "running" || task?.status === "queued") throw new Error("任务正在执行，服务由当前智能体启动；用户仍可查看或停止");
        }
      };
      return c.json(await startDevelopmentService(taskId, await c.req.json(), authorize));
    } catch (error) { return c.json(errorBody(error), 409); }
  });
  api.delete("/tasks/:id/runtime/service", async (c) => {
    const taskId = c.req.param("id");
    try {
      const caller = await runtimeCaller(c, taskId);
      return c.json(await stopDevelopmentService(taskId, caller.agent ? "agent" : "user"));
    } catch (error) { return c.json(errorBody(error), 409); }
  });
  api.get("/tasks/:id/runtime/browser/frame", async (c) => {
    const taskId = c.req.param("id");
    await requireTaskAccess(actorOf(c), taskId);
    if (c.req.query("id") !== taskBrowserState(taskId)?.id) return c.text("浏览器会话已更换", 409);
    const frame = c.req.query("refresh") === "1" ? await refreshBrowserFrame(taskId, c.req.query("id")!) : browserFrame(taskId);
    c.header("cache-control", "no-store");
    c.header("content-type", "image/png");
    return frame ? c.body(new Uint8Array(frame)) : c.body(null, 404);
  });
  api.post("/tasks/:id/runtime/browser", async (c) => {
    const taskId = c.req.param("id");
    try {
      const caller = await runtimeCaller(c, taskId);
      const body = await c.req.json();
      const input = parseBrowserAction(body);
      return c.json(await taskBrowserAction(taskId, input, {
        ...caller, id: typeof body.id === "string" ? body.id : undefined, screenshot: body.screenshot === true,
      }));
    } catch (error) { return c.json(errorBody(error), 409); }
  });
}

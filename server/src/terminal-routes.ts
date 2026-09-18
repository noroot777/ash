// 终端会话的 HTTP 传输层:把 TerminalSessionManager(terminal.ts)的能力挂到 Hono 路由上。
// 会话管理、进程组清场那套逻辑全在 terminal.ts;这里只做「请求 → 调 manager → 回响应」的
// 薄壳,拆出来是为了让 terminal.ts 专注会话/进程,不被路由样板撑过 700 行。
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { projects } from "./db/schema.js";
import { instanceAdminOnly } from "./auth/context.js";
import { resolveTerminalDirectory, terminalSessions, type TerminalEvent } from "./terminal.js";

async function projectDirectory(projectId: string): Promise<string | null> {
  const project = (await db.select().from(projects).where(eq(projects.id, projectId))).at(0);
  return resolveTerminalDirectory(project?.repoPath);
}

export function mountTerminalRoutes(api: Hono): void {
  // 终端是**实例管理员专属**(§七):它开的是宿主机上的一个真 shell,项目目录只是
  // 起始 cwd —— 一条 `cd /` 就出去了。给普通用户就等于把「护栏」变成一句空话。
  api.use("/projects/:projectId/terminal/*", async (c, next) => {
    const denied = await instanceAdminOnly(c, "终端");
    if (denied) return c.json(denied.body, denied.status);
    return next();
  });

  api.post("/projects/:projectId/terminal/sessions", async (c) => {
    const projectId = c.req.param("projectId");
    const cwd = await projectDirectory(projectId);
    if (!cwd) return c.json({ error: "项目目录不存在，请先在项目设置中填写可用的本地目录" }, 400);
    const body: { cols?: number; rows?: number } = await c.req.json().catch(() => ({}));
    try {
      return c.json(terminalSessions.create(projectId, cwd, body), 201);
    } catch (error) {
      return c.json({ error: `终端启动失败：${error instanceof Error ? error.message : String(error)}` }, 500);
    }
  });

  // 终端抽屉打开时先问一遍「这个项目已经有哪些会话」：常用命令的常驻会话要 attach
  // 而不是新建，普通 shell 则永远新建（它的生命周期跟着前端 tab 走）。项目已删时
  // 404 —— 项目删除会连带清场终端会话,这里再回数据就是在展示幽灵(第 1 轮自由审查)。
  api.get("/projects/:projectId/terminal/sessions", async (c) => {
    const projectId = c.req.param("projectId");
    const row = (await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId))).at(0);
    if (!row) return c.json({ error: "project not found" }, 404);
    return c.json({ sessions: terminalSessions.listForProject(projectId) });
  });

  api.get("/projects/:projectId/terminal/sessions/:sessionId/events", (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");
    const after = Number(c.req.header("last-event-id") ?? c.req.query("after") ?? 0) || 0;
    const replay = terminalSessions.eventsAfter(sessionId, projectId, after);
    if (!replay) return c.json({ error: "terminal session not found" }, 404);
    return streamSSE(c, async (stream) => {
      let replaying = true;
      const pending: TerminalEvent[] = [];
      const write = (event: TerminalEvent) => stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) });
      const unsubscribe = terminalSessions.subscribe(sessionId, projectId, (event) => {
        if (replaying) pending.push(event);
        else void write(event).catch(() => undefined);
      });
      stream.onAbort(() => unsubscribe?.());
      try {
        for (const event of replay) await write(event);
        replaying = false;
        for (const event of pending) await write(event);
        while (!stream.aborted) {
          await stream.writeSSE({ event: "ping", data: "1" });
          await stream.sleep(15_000);
        }
      } catch {
        /* normal disconnect */
      } finally {
        unsubscribe?.();
      }
    });
  });

  api.post("/projects/:projectId/terminal/sessions/:sessionId/input", async (c) => {
    const body: { data?: unknown } = await c.req.json().catch(() => ({}));
    if (typeof body.data !== "string") return c.json({ error: "data required" }, 400);
    if (Buffer.byteLength(body.data) > 64 * 1024) return c.json({ error: "data too large" }, 413);
    if (!terminalSessions.write(c.req.param("sessionId"), c.req.param("projectId"), body.data)) {
      return c.json({ error: "terminal session not found" }, 404);
    }
    return c.body(null, 204);
  });

  api.post("/projects/:projectId/terminal/sessions/:sessionId/resize", async (c) => {
    const body: { cols?: unknown; rows?: unknown } = await c.req.json().catch(() => ({}));
    if (typeof body.cols !== "number" || typeof body.rows !== "number") {
      return c.json({ error: "cols and rows required" }, 400);
    }
    if (!terminalSessions.resize(c.req.param("sessionId"), c.req.param("projectId"), body.cols, body.rows)) {
      return c.json({ error: "terminal session not found" }, 404);
    }
    return c.body(null, 204);
  });

  // 「结束会话」:进程组级终止,确认整组清空才移除会话。杀不净回 502 —— 前端必须
  // 保留 tab 和把手,不能静默收掉(否则忽略 HUP/TERM 的后台作业成 PID 1 孤儿还没人管)。
  api.delete("/projects/:projectId/terminal/sessions/:sessionId", async (c) => {
    const result = await terminalSessions.destroy(c.req.param("sessionId"), c.req.param("projectId"));
    if (!result.ok) return c.json({ error: `结束会话失败：${result.reason}` }, 502);
    return c.body(null, 204);
  });
}

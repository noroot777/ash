// 会话可追溯性（§13）的三条只读路由：列出一个任务的会话、读某条会话落盘的输出、读它
// 的执行轨迹。轨迹刻意独立于 Markdown transcript 存放，推理/工具事件才不会混成助手正文。
//
// 从 `task-run-routes.ts` 抽出来的原因只有一个：那份文件已经贴着 700 行的上限，而这三条
// 是里面唯一一块「只读、不碰回合所有权」的东西，切走对那边的并发不变量零影响。
import { readFile } from "node:fs/promises";
import type { Session } from "@harness/shared";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { db } from "./db/index.js";
import { sessions } from "./db/schema.js";
import { resumeCommandFor } from "./executors/resume.js";
import { sessionRunMeta } from "./session-run-meta.js";
import { parseSessionTrace, readableRunPath, sessionTracePath, sessionTranscriptPath } from "./transcript.js";
import { sessionContext, sessionUsage } from "./usage.js";

function toSession(
  r: typeof sessions.$inferSelect,
  run: { model: string | null; reasoningEffort: string | null } = { model: null, reasoningEffort: null },
): Session {
  return {
    ...r,
    role: r.role as Session["role"],
    agentType: r.agentType as Session["agentType"],
    transcriptPath: sessionTranscriptPath(r.taskId, r.id),
    resumeCommand: r.cliSessionId
      ? resumeCommandFor(r.agentType, r.cwd ?? r.worktreePath ?? ".", r.cliSessionId, r.resumeEnv, r.resumeArgs)
      : r.resumeCommand,
    ...run,
    usage: sessionUsage(r),
    context: sessionContext(r),
  };
}

export function mountTaskSessionRoutes(api: Hono): void {
  api.get("/tasks/:id/sessions", async (c) => {
    const taskId = c.req.param("id");
    const rows = await db.select().from(sessions).where(eq(sessions.taskId, taskId));
    const runMeta = await sessionRunMeta(taskId, rows);
    return c.json(rows.map((row) => toSession(row, runMeta.get(row.id))));
  });

  // 会话落盘的输出（重载页面时读它；实时输出走 SSE）。
  api.get("/sessions/:id/output", async (c) => {
    const sid = c.req.param("id");
    const row = (await db.select().from(sessions).where(eq(sessions.id, sid))).at(0);
    if (!row) return c.json({ error: "not found" }, 404);
    try {
      const text = await readFile(readableRunPath(sessionTranscriptPath(row.taskId, sid)), "utf8");
      return c.text(text);
    } catch {
      return c.text("");
    }
  });

  api.get("/sessions/:id/trace", async (c) => {
    const sid = c.req.param("id");
    const row = (await db.select().from(sessions).where(eq(sessions.id, sid))).at(0);
    if (!row) return c.json({ error: "not found" }, 404);
    try {
      const raw = await readFile(readableRunPath(sessionTracePath(row.taskId, sid)), "utf8");
      return c.json(parseSessionTrace(raw));
    } catch {
      return c.json([]);
    }
  });
}

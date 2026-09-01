// 会话可追溯性（§13）的三条只读路由：列出一个任务的会话、读某条会话落盘的输出、读它
// 的执行轨迹。轨迹刻意独立于 Markdown transcript 存放，推理/工具事件才不会混成助手正文。
//
// 从 `task-run-routes.ts` 抽出来的原因只有一个：那份文件已经贴着 700 行的上限，而这三条
// 是里面唯一一块「只读、不碰回合所有权」的东西，切走对那边的并发不变量零影响。
import { readFile } from "node:fs/promises";
import type { Session } from "@ash/shared";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { db } from "./db/index.js";
import { sessions } from "./db/schema.js";
import { sessionCliConfigDir } from "./auth/run-env.js";
import { resumeCommandFor } from "./executors/resume.js";
import { sessionRunMeta } from "./session-run-meta.js";
import { parseSessionTrace, readableRunPath, sessionTracePath, sessionTranscriptPath } from "./transcript.js";
import { sessionContext, sessionUsage } from "./usage.js";
import { readCodexCliVersion } from "./executors/codex-rollout.js";
import { affectedCodexSessionWarning } from "./executors/version-policy.js";

async function toSession(
  r: typeof sessions.$inferSelect,
  run: { model: string | null; reasoningEffort: string | null } = { model: null, reasoningEffort: null },
): Promise<Session> {
  // 版本得从**这条会话的 rollout 实际写在的那个目录**里读(会话行记着;老行按当时的
  // 规则解释)。按宿主机默认目录读的话,隔离档下列表恒为「读不出版本」,而起跑守卫那边
  // 却按个人目录判定 —— 界面和守卫会给出两套结论(第 1 轮 finding 1)。
  const cliVersion = r.agentType === "codex" && r.cliSessionId
    ? await readCodexCliVersion(r.cliSessionId, await sessionCliConfigDir(r, "codex"))
    : null;
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
    cliVersion,
    versionWarning: affectedCodexSessionWarning(cliVersion),
  };
}

export async function sessionsForTask(taskId: string): Promise<Session[]> {
  const rows = await db.select().from(sessions).where(eq(sessions.taskId, taskId));
  const runMeta = await sessionRunMeta(taskId, rows);
  return Promise.all(rows.map((row) => toSession(row, runMeta.get(row.id))));
}

export async function sessionOutputText(taskId: string, sessionId: string): Promise<string> {
  try {
    return await readFile(readableRunPath(sessionTranscriptPath(taskId, sessionId)), "utf8");
  } catch {
    return "";
  }
}

export async function sessionTraceEntries(taskId: string, sessionId: string) {
  try {
    const raw = await readFile(readableRunPath(sessionTracePath(taskId, sessionId)), "utf8");
    return parseSessionTrace(raw);
  } catch {
    return [];
  }
}

export function mountTaskSessionRoutes(api: Hono): void {
  api.get("/tasks/:id/sessions", async (c) => {
    return c.json(await sessionsForTask(c.req.param("id")));
  });

  // 会话落盘的输出（重载页面时读它；实时输出走 SSE）。
  api.get("/sessions/:id/output", async (c) => {
    const sid = c.req.param("id");
    const row = (await db.select().from(sessions).where(eq(sessions.id, sid))).at(0);
    if (!row) return c.json({ error: "not found" }, 404);
    return c.text(await sessionOutputText(row.taskId, sid));
  });

  api.get("/sessions/:id/trace", async (c) => {
    const sid = c.req.param("id");
    const row = (await db.select().from(sessions).where(eq(sessions.id, sid))).at(0);
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(await sessionTraceEntries(row.taskId, sid));
  });
}

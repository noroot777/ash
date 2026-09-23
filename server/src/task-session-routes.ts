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
import type { SessionTraceEntry } from "./transcript.js";
import { sessionContext, sessionUsage } from "./usage.js";
import { codexHome, findArchivedRollout, readCodexCliVersion } from "./executors/codex-rollout.js";
import { affectedCodexSessionWarning } from "./executors/version-policy.js";
import { enrichNativeWorkModels } from "./native-work-models.js";

async function toSession(
  r: typeof sessions.$inferSelect,
  run: { model: string | null; reasoningEffort: string | null } = { model: null, reasoningEffort: null },
): Promise<Session> {
  // 版本得从**这条会话的 rollout 实际写在的那个目录**里读(会话行记着;老行按当时的
  // 规则解释)。按宿主机默认目录读的话,隔离档下列表恒为「读不出版本」,而起跑守卫那边
  // 却按个人目录判定 —— 界面和守卫会给出两套结论(第 1 轮 finding 1)。
  const configDir = r.agentType === "codex" ? await sessionCliConfigDir(r, "codex") : null;
  const [cliVersion, archived] = r.agentType === "codex" && r.cliSessionId
    ? await Promise.all([readCodexCliVersion(r.cliSessionId, configDir), findArchivedRollout(r.cliSessionId, configDir)])
    : [null, null];
  return {
    ...r,
    role: r.role as Session["role"],
    agentType: r.agentType as Session["agentType"],
    transcriptPath: sessionTranscriptPath(r.taskId, r.id),
    resumeCommand: r.cliSessionId
      ? resumeCommandFor(r.agentType, r.cwd ?? r.worktreePath ?? ".", r.cliSessionId, r.resumeEnv, r.resumeArgs,
        archived ? { configDir: codexHome(configDir) } : undefined)
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

/**
 * 读一份 run 产物。**「文件还没建」和「读不出来」是两回事**，调用方必须能分开：
 * 前者对刚起跑、还没落第一笔的会话是合法的空；后者（权限、I/O、路径解析，以及
 * 已经收口的会话 transcript 丢了）是故障。一律吞成空字符串的话，前端会把 200 空正文
 * 当成「正文已完整读到」，放开问答历史的去重门禁，把匹配不上的记录整屏补出来 ——
 * 正是这个任务一开始要修的那屏答复卡（第 2 轮审查）。
 */
type RunFileRead<T> = { ok: true; value: T } | { ok: false; missing: boolean };

async function readRunFile(path: string): Promise<RunFileRead<string>> {
  try {
    return { ok: true, value: await readFile(readableRunPath(path), "utf8") };
  } catch (err) {
    return { ok: false, missing: (err as NodeJS.ErrnoException)?.code === "ENOENT" };
  }
}

export async function readSessionOutput(taskId: string, sessionId: string): Promise<RunFileRead<string>> {
  return readRunFile(sessionTranscriptPath(taskId, sessionId));
}

export async function readSessionTrace(
  taskId: string,
  sessionId: string,
): Promise<RunFileRead<SessionTraceEntry[]>> {
  const raw = await readRunFile(sessionTracePath(taskId, sessionId));
  if (!raw.ok) return raw;
  let trace: SessionTraceEntry[];
  try {
    trace = parseSessionTrace(raw.value);
  } catch {
    // 文件在、却解析不出来：这跟读不出来一样是故障，别装作这条会话没干过活。
    return { ok: false, missing: false };
  }
  if (!trace.some((entry) => entry.event.kind === "tool" && entry.event.nativeWork)) return { ok: true, value: trace };
  try {
    const row = (await db.select().from(sessions).where(eq(sessions.id, sessionId))).at(0);
    // 补模型名只是锦上添花，补不上就给裸 trace —— 这一条降级是有意的。
    return {
      ok: true,
      value: row && row.taskId === taskId
        ? await enrichNativeWorkModels(trace, row, await sessionCliConfigDir(row, row.agentType)) : trace,
    };
  } catch {
    return { ok: true, value: trace };
  }
}

// 接力快照那边读不到就当空：那是一次性搬运，缺一段正文不该让整个快照失败。
export async function sessionOutputText(taskId: string, sessionId: string): Promise<string> {
  const read = await readSessionOutput(taskId, sessionId);
  return read.ok ? read.value : "";
}

export async function sessionTraceEntries(taskId: string, sessionId: string): Promise<SessionTraceEntry[]> {
  const read = await readSessionTrace(taskId, sessionId);
  return read.ok ? read.value : [];
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
    const read = await readSessionOutput(row.taskId, sid);
    if (read.ok) return c.text(read.value);
    // 还没收口的会话可以还没建文件；已经收口了还找不到，就是丢了。正文是每条会话都
    // 必然产出的东西（真实库 1924 条已收口会话里只有 2 条缺，且它们的 runs 目录整个
    // 已被清掉），所以这条判据站得住。
    if (read.missing && !row.endedAt) return c.text("");
    return c.json({ error: "transcript unreadable" }, 500);
  });

  api.get("/sessions/:id/trace", async (c) => {
    const sid = c.req.param("id");
    const row = (await db.select().from(sessions).where(eq(sessions.id, sid))).at(0);
    if (!row) return c.json({ error: "not found" }, 404);
    const read = await readSessionTrace(row.taskId, sid);
    if (read.ok) return c.json(read.value);
    // **trace 不能套正文那条判据。** 它是 2026-08-01 才加的功能（bd8ed749 / de2c9893），
    // 在那之前跑完的会话本来就没有这个文件，眼下也没有任何标记能证明「这条会话应该
    // 产 trace」—— 同一个库里 992/1924 条已收口会话没有 .trace.jsonl。把它们一律判成
    // 故障，前端的 traceError 就会把整页的「派生新任务」入口静默关掉（第 3 轮审查）。
    // 文件不在就是没有；只有文件在却读不动、或者解析不出来，才是真的坏了。
    if (read.missing) return c.json([]);
    return c.json({ error: "trace unreadable" }, 500);
  });
}

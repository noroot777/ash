// 会话可追溯性（§13）的三条只读路由：列出一个任务的会话、读某条会话落盘的输出、读它
// 的执行轨迹。轨迹刻意独立于 Markdown transcript 存放，推理/工具事件才不会混成助手正文。
//
// 从 `task-run-routes.ts` 抽出来的原因只有一个：那份文件已经贴着 700 行的上限，而这三条
// 是里面唯一一块「只读、不碰回合所有权」的东西，切走对那边的并发不变量零影响。
import { readFile } from "node:fs/promises";
import { mergeImageJournal } from "./agent-image-journal.js";
import type { Session } from "@ash/shared";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { db } from "./db/index.js";
import { sessions } from "./db/schema.js";
import { backfillArtifactUploads, eventAttachmentPath } from "./uploads.js";
import { sessionCliConfigDir } from "./auth/run-env.js";
import { resumeCommandFor } from "./executors/resume.js";
import { sessionRunMeta } from "./session-run-meta.js";
import { failedTurnNotices, replaysFailureScene, sessionWaiting } from "./session-waiting.js";
import { turnOutcome } from "./session-turns.js";
import {
  parseSessionTraceLines,
  readRecentTraceEntries,
  readableRunPath,
  sessionTracePath,
  sessionTranscriptPath,
} from "./transcript.js";
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
    // 「此刻还在等上游」跟着会话行一起出门:刷新重建要用它,而不是去 trace 的末条上猜
    // (判据与窄出口同一份,见 Session.awaitingUpstream 与 session-waiting.ts)。
    awaitingUpstream: sessionWaiting(r.id, r.turnStartedAt).length > 0,
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

/**
 * trace 读出来之后还多一位：**末行是不是半截**。`parseSessionTraceLines` 已经把
 * 「整行写完却解析不出来」判成坏（那种直接 ok:false），剩下这一位交给路由结合会话有没有
 * 收口来判 —— 还在跑的会话末行半截是 agent 正在落笔，收了口还残着半行就是被截断了。
 */
type TraceRead =
  | { ok: true; value: SessionTraceEntry[]; truncatedTail: boolean }
  | { ok: false; missing: boolean };

export async function readSessionTrace(taskId: string, sessionId: string): Promise<TraceRead> {
  const raw = await readRunFile(sessionTracePath(taskId, sessionId));
  if (!raw.ok) return raw;
  const parsed = parseSessionTraceLines(raw.value);
  // 一整行写完了却解析不出来 —— 那不是「正在写」，是文件坏了。把它当成空 trace 交出去，
  // 前端就既看不到执行过程、也收不到任何警告，派生照样挂着（第 4 轮审查）。
  if (parsed.badLines > 0) return { ok: false, missing: false };
  // trace 缺的图记录从持久账本补回来(消费者死在落笔之前的那几条),再做归属补齐 ——
  // 顺序有讲究:合成行里的 path 也要走下面那道 backfill 才对普通成员可见。
  const trace = await mergeImageJournal(taskId, sessionId, parsed.entries);
  const tail = parsed.truncatedTail;
  // 这段执行过程里记着的图,归属补齐 —— 登记那一道是后来才补的,在它之前落盘的会话、以及
  // 登记写失败的那几次,图对普通成员一律 404 且**没有新广播就永远不会恢复**(判据与边界见
  // uploads.ts 的 backfillArtifactUploads;讨论那条读取路径用的是同一道)。
  await backfillArtifactUploads(
    taskId,
    // 遍历跟实时登记**同一份**(eventAttachmentPath):子智能体那一层的附件包在
    // `tool.nativeWork` 里,只看顶层就只补得到主附件 —— 两道范围不对称就是 R3 那一幕。
    trace.map((entry) => eventAttachmentPath(entry.event)),
  );
  if (!trace.some((entry) => entry.event.kind === "tool" && entry.event.nativeWork)) {
    return { ok: true, value: trace, truncatedTail: tail };
  }
  try {
    const row = (await db.select().from(sessions).where(eq(sessions.id, sessionId))).at(0);
    // 补模型名只是锦上添花，补不上就给裸 trace —— 这一条降级是有意的。
    return {
      ok: true,
      truncatedTail: tail,
      value: row && row.taskId === taskId
        ? await enrichNativeWorkModels(trace, row, await sessionCliConfigDir(row, row.agentType)) : trace,
    };
  } catch {
    return { ok: true, value: trace, truncatedTail: tail };
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
    if (read.ok) {
      // 末行半截：还在跑就是 agent 正在落那一笔（照常给已读到的部分）；收了口还残着
      // 半行，说明文件写到一半断了，跟坏行一样得说出来。
      if (read.truncatedTail && row.endedAt) return c.json({ error: "trace unreadable" }, 500);
      return c.json(read.value);
    }
    // **trace 不能套正文那条判据。** 它是 2026-08-01 才加的功能（bd8ed749 / de2c9893），
    // 在那之前跑完的会话本来就没有这个文件，眼下也没有任何标记能证明「这条会话应该
    // 产 trace」—— 同一个库里 992/1924 条已收口会话没有 .trace.jsonl。把它们一律判成
    // 故障，前端的 traceError 就会把整页的「派生新任务」入口静默关掉（第 3 轮审查）。
    // 文件不在就是没有；只有文件在却读不动、或者内容坏了，才是真的坏了。
    if (read.missing) return c.json([]);
    return c.json({ error: "trace unreadable" }, 500);
  });

  // 过程提示的窄出口。给读不动整份 trace 的消费者(手机端每几秒重拉一次)。两种投影的
  // 分工与判据见 session-waiting.ts:**此刻还在等**只认事件消费链上的内存状态(落盘产物
  // 答不了它 —— 正文有缓冲),**失败现场**才从 trace 回放。
  // 还在等的时候压根不读盘;要读的时候读失败也不咽:整份 trace 那条出口已经是这个口径
  // (文件不在=没有,读不动=500),否则一次磁盘故障会被手机端读成「上游没在重试」。
  api.get("/sessions/:id/notices", async (c) => {
    const sid = c.req.param("id");
    const row = (await db.select().from(sessions).where(eq(sessions.id, sid))).at(0);
    if (!row) return c.json({ error: "not found" }, 404);
    const live = sessionWaiting(sid, row.turnStartedAt);
    if (live.length) return c.json(live);
    try {
      // 失败现场认**这一个回合自己的结局**,不认进程退出码(理由见 failedTurnNotices)。
      // 结局读在读盘之前:不是明确失败就一个字节都不必读 —— 这个出口每几秒被手机拉一次,
      // 而 trace 要尾读 256 KiB。两处共用 replaysFailureScene 那一份判据,不另算一遍。
      const outcome = await turnOutcome(sid, row.turnStartedAt);
      if (!replaysFailureScene(outcome)) return c.json([]);
      const entries = await readRecentTraceEntries(row.taskId, sid);
      return c.json(failedTurnNotices(entries, { turnStartedAt: row.turnStartedAt, outcome }));
    } catch (error) {
      console.warn(`[ash] 读 ${sid} 的过程提示失败:`, error);
      return c.json({ error: "trace unreadable" }, 500);
    }
  });
}

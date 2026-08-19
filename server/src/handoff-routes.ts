// 任务接力的 HTTP 面。业务全在 handoff.ts / handoff-import.ts,这里只做参数搬运
// 和 HandoffError → HTTP 状态码的翻译。
//
// 对端发现(/handoff/ping、/refs)与导入(/handoff/import)是**机器对机器**的端点:
// 由源机的 harness 服务端来调,不给浏览器用——server→server 顺带绕开了 CORS。
// V1 与 harness 其它端点一样没有鉴权,只在可信内网使用(终端 API 本身就是个 shell)。
import { hostname } from "node:os";
import { appendFile } from "node:fs/promises";
import type { Hono } from "hono";
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { projects, sessions, tasks } from "./db/schema.js";
import { projectHealthLight } from "./git.js";
import {
  exportHandoff, HandoffError, preflightHandoff, repoRefTips,
  type HandoffPingResponse,
} from "./handoff.js";
import { importHandoff } from "./handoff-import.js";
import { publishTaskUpdated } from "./task-store.js";
import { sessionTranscriptPath, TURN_SENTINEL } from "./transcript.js";
import { now } from "./util.js";

type ErrorStatus = 400 | 404 | 409 | 500 | 502;

const fail = (c: Context, e: unknown) => {
  if (e instanceof HandoffError) return c.json({ error: e.message }, e.status as ErrorStatus);
  const msg = e instanceof Error ? e.message : String(e);
  console.error("[handoff]", e);
  return c.json({ error: `接力失败:${msg}` }, 500);
};

export function mountHandoffRoutes(api: Hono): void {
  // 对端探活:证明「我是一台 harness」,并报出可作为接力目的地的项目清单。
  api.get("/handoff/ping", async (c) => {
    const rows = await db.select().from(projects);
    const body: HandoffPingResponse = {
      ok: true,
      service: "harness",
      host: hostname(),
      projects: rows.map((p) => ({
        id: p.id,
        name: p.name,
        repoPath: p.repoPath,
        isRepo: projectHealthLight(p.repoPath).isRepo,
      })),
    };
    return c.json(body);
  });

  // 分支尖清单,供源机协商 git bundle 的前置提交(对端已有的历史不重复打包)。
  api.get("/handoff/projects/:id/refs", async (c) => {
    const row = (await db.select().from(projects)).find((p) => p.id === c.req.param("id"));
    if (!row) return c.json({ error: "项目不存在" }, 404);
    if (!projectHealthLight(row.repoPath).isRepo) return c.json({ refs: [] });
    try {
      return c.json({ refs: await repoRefTips(row.repoPath) });
    } catch (e) {
      return fail(c, e);
    }
  });

  // 接收一整个任务(manifest 里带 git bundle 和会话文件,可能上百 MB)。
  api.post("/handoff/import", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "导入体不是合法 JSON" }, 400);
    }
    try {
      return c.json(await importHandoff(body));
    } catch (e) {
      return fail(c, e);
    }
  });

  // 预检:探测目标机、匹配项目、盘点本地可搬运的东西。只读。
  api.post("/tasks/:id/handoff/preflight", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { targetUrl?: string };
    if (!body.targetUrl) return c.json({ error: "缺 targetUrl" }, 400);
    try {
      return c.json(await preflightHandoff(c.req.param("id"), body.targetUrl));
    } catch (e) {
      return fail(c, e);
    }
  });

  // 正式接力:停任务 → 打包 → 推给对端 → 本地落「已接力」标记。
  api.post("/tasks/:id/handoff", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      targetUrl?: string;
      targetProjectId?: string;
      targetName?: string;
      autoResume?: boolean;
    };
    if (!body.targetUrl || !body.targetProjectId) {
      return c.json({ error: "缺 targetUrl / targetProjectId" }, 400);
    }
    try {
      return c.json(await exportHandoff(c.req.param("id"), {
        targetUrl: body.targetUrl,
        targetProjectId: body.targetProjectId,
        targetName: body.targetName,
        autoResume: body.autoResume,
      }));
    } catch (e) {
      return fail(c, e);
    }
  });

  // 移除接力标记:「在本机继续」的唯一逃生门(接力出去/接力未确认的任务被硬拦后走这里)。
  // 只清本机标记,对端那份任务不动——两边并跑的风险由用户自担,所以前端必须走确认框,
  // 时间线也留一条持久可见的系统说明。
  api.delete("/tasks/:id/handoff", async (c) => {
    const taskId = c.req.param("id");
    const row = (await db
      .select({ id: tasks.id, handoff: tasks.handoff })
      .from(tasks)
      .where(eq(tasks.id, taskId))).at(0);
    if (!row) return c.json({ error: "任务不存在" }, 404);
    let marker: { direction?: string } | null = null;
    if (row.handoff) {
      try { marker = JSON.parse(row.handoff) as { direction?: string }; } catch { marker = null; }
    }
    if (marker?.direction !== "out") {
      return c.json({ error: "任务没有「接力出去」的标记;接力进来的任务本来就在本机跑,不用移除" }, 409);
    }
    await db.update(tasks).set({ handoff: null, updatedAt: now() }).where(eq(tasks.id, taskId));
    const latest = (await db
      .select({ id: sessions.id, agentType: sessions.agentType })
      .from(sessions)
      .where(eq(sessions.taskId, taskId))
      .orderBy(sessions.startedAt)).at(-1);
    if (latest) {
      const line = {
        t: "system" as const, agent: latest.agentType, by: "system" as const, at: now(),
        text: "🔁 用户移除了接力标记,任务恢复为本机可运行(对端那份仍存在,注意别两边同时跑)。",
      };
      await appendFile(sessionTranscriptPath(taskId, latest.id), `\n${TURN_SENTINEL}${JSON.stringify(line)}\n`)
        .catch(() => { /* 从未跑过就没有产物目录,标记已清,不阻塞 */ });
    }
    await publishTaskUpdated(taskId);
    return c.json({ cleared: true });
  });
}

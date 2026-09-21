import { open } from "node:fs/promises";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { parseSessionOutput } from "@ash/shared";
import { db } from "../db/index.js";
import { chatContextEntries, chatRooms, sessions, tasks } from "../db/schema.js";
import { actorOf, ownerIdOf } from "../auth/context.js";
import { filterOwned } from "../auth/owned.js";
import { id, now } from "../util.js";
import { readableRunPath, sessionTranscriptPath } from "../transcript.js";
import { estimateChatTokens } from "./context-format.js";
import { isHumanRequest, parseMembers, visibleProject } from "./route-access.js";
import { toRoom } from "./service.js";

async function parentFor(c: Context) {
  if (!isHumanRequest(c)) return;
  const task = (await db.select().from(tasks).where(eq(tasks.id, c.req.param("id")!))).at(0);
  return task && task.mode === "single" && await visibleProject(c, task.projectId) ? task : undefined;
}

/**
 * 侧聊带进去的主会话快照。**不按体积拒绝创建**（用户 2026-09-21 指定：侧聊和主会话一样，
 * 不额外设限）——主会话自己吃得下的历史，侧聊没有理由以「太长」为由不让开。快照超出一轮
 * 上下文预算时交给既有的历史整理（`ChatContextManager`，状态可见、可随时停止），而不是在
 * 入口上甩一句「无法创建」——那是用户唯一没法绕开的失败。
 *
 * 下面唯一保留的阀是**内存保护**，不是产品策略：整份 transcript 要读进内存再切块，几十 MB
 * 起就会把 server 的堆顶起来，而 server 是所有任务共用的。阀设在实测 p99（约 10 MB）之上
 * 一个数量级，正常任务撞不到；真撞上时报错也说清是内存保护，不是「你的会话太长」。
 */
const SNAPSHOT_MEMORY_LIMIT = 64 * 1024 * 1024;

export async function sideChatHistory(task: typeof tasks.$inferSelect) {
  const history = [{ role: "user", author: "原始任务", body: `${task.title}\n\n${task.body}` }];
  const rows = await db.select().from(sessions).where(eq(sessions.taskId, task.id)).orderBy(asc(sessions.startedAt), asc(sessions.id));
  let total = Buffer.byteLength(history[0]!.body);
  if (total > SNAPSHOT_MEMORY_LIMIT) throw new Error("主任务正文超过 64 MB，一次读进内存会拖垮服务；请从指定回复派生任务继续讨论。");
  for (const session of rows) {
    // 固定每个文件本次读到的长度，主任务继续追加的内容留在主会话。
    let handle;
    try {
      handle = await open(readableRunPath(sessionTranscriptPath(task.id, session.id)), "r");
      const size = (await handle.stat()).size;
      total += size;
      if (total > SNAPSHOT_MEMORY_LIMIT) throw new Error("主会话记录超过 64 MB，一次读进内存会拖垮服务；请从指定回复派生任务继续讨论。");
      const data = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await handle.read(data, offset, size - offset, offset);
        if (!bytesRead) throw new Error("主会话文件在读取期间发生变化，请重试。");
        offset += bytesRead;
      }
      for (const part of parseSessionOutput(data.toString("utf8"))) {
        if (part.kind === "system" || !part.text.trim()) continue;
        history.push({ role: part.kind === "user" && part.bySystem ? "system" : part.kind, author: part.kind === "user" ? part.bySystem ? "系统发言（历史）" : "主会话用户（历史）" : `${session.agentType}（主会话历史）`, body: part.text });
      }
    } catch (error) {
      // 刚起跑且还没有任何输出的会话尚无文件。
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || session.endedAt) throw error;
    } finally { await handle?.close(); }
  }
  const entries = history.flatMap((message) => {
    const parts: string[] = [];
    for (let start = 0; start < message.body.length; start += 4000) {
      parts.push(JSON.stringify({ ...message, source: "主会话快照，仅供参考", body: message.body.slice(start, start + 4000) }));
    }
    return parts;
  });
  return entries;
}

export function mountSideChatRoutes(api: Hono) {
  api.get("/tasks/:id/side-chats", async (c) => {
    const task = await parentFor(c);
    if (!task) return c.json({ error: "任务不存在或不支持侧聊" }, 404);
    const rows = await filterOwned(await db.select().from(chatRooms)
      .where(and(eq(chatRooms.parentTaskId, task.id), eq(chatRooms.projectId, task.projectId), eq(chatRooms.kind, "side")))
      .orderBy(desc(chatRooms.createdAt), desc(chatRooms.id)), actorOf(c));
    return c.json(rows.map(toRoom));
  });
  api.post("/tasks/:id/side-chats", async (c) => {
    const task = await parentFor(c);
    if (!task) return c.json({ error: "任务不存在或不支持侧聊" }, 404);
    try {
      const body = await c.req.json();
      if (typeof body.id !== "string" || !/^[\w-]{8,80}$/u.test(body.id)) throw new Error("侧聊编号无效");
      const existing = (await filterOwned(await db.select().from(chatRooms).where(eq(chatRooms.id, body.id)), actorOf(c))).at(0);
      if (existing) {
        if (existing.kind !== "side" || existing.parentTaskId !== task.id) throw new Error("侧聊编号冲突");
        return c.json(toRoom(existing));
      }
      const members = await parseMembers([body.member], c);
      const history = await sideChatHistory(task);
      const row = { id: body.id as string, kind: "side", parentTaskId: task.id, projectId: task.projectId,
        name: "侧聊", members: JSON.stringify(members), ownerUserId: ownerIdOf(actorOf(c)), createdAt: now() };
      await db.transaction(async (tx) => {
        if (!(await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, task.id))).length) throw new Error("主任务已删除。");
        await tx.insert(chatRooms).values(row);
        for (const content of history) await tx.insert(chatContextEntries).values({ roomId: row.id, messageId: id(), content, tokens: estimateChatTokens(`${content}\n`) });
      });
      return c.json(toRoom(row), 201);
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : "创建侧聊失败" }, 400); }
  });
}

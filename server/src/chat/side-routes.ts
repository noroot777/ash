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

export async function sideChatHistory(task: typeof tasks.$inferSelect) {
  const history = [{ role: "user", author: "原始任务", body: `${task.title}\n\n${task.body}` }];
  const rows = await db.select().from(sessions).where(eq(sessions.taskId, task.id)).orderBy(asc(sessions.startedAt), asc(sessions.id));
  let total = Buffer.byteLength(history[0]!.body);
  if (total > 4 * 1024 * 1024) throw new Error("主任务正文超过 4 MB，暂时无法创建侧聊。");
  for (const session of rows) {
    // 固定每个文件本次读到的长度，主任务继续追加的内容留在主会话。
    let handle;
    try {
      handle = await open(readableRunPath(sessionTranscriptPath(task.id, session.id)), "r");
      const size = (await handle.stat()).size;
      total += size;
      if (total > 4 * 1024 * 1024) throw new Error("主会话超过 4 MB，暂时无法创建侧聊；可从指定回复派生任务继续讨论。");
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
  return history.flatMap((message) => {
    const parts: string[] = [];
    for (let start = 0; start < message.body.length; start += 4000) {
      parts.push(JSON.stringify({ ...message, source: "主会话快照，仅供参考", body: message.body.slice(start, start + 4000) }));
    }
    return parts;
  });
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
        await tx.insert(chatRooms).values(row);
        for (const content of history) await tx.insert(chatContextEntries).values({ roomId: row.id, messageId: id(), content, tokens: estimateChatTokens(`${content}\n`) });
      });
      return c.json(toRoom(row), 201);
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : "创建侧聊失败" }, 400); }
  });
}

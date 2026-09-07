import { and, eq, inArray } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { AGENT_TYPES } from "@ash/shared";
import type { ChatMember } from "@ash/shared/chat";
import { isAllMention } from "@ash/shared/chat";
import { db } from "../db/index.js";
import { agents, chatRooms, chatMessages, projects, tasks } from "../db/schema.js";
import { actorOf, isAccountHolder, ownerIdOf } from "../auth/context.js";
import { canSeeProject, visibleTaskIds } from "../auth/visibility.js";
import { canUseOwned, filterOwned } from "../auth/owned.js";
import { enrichTasks, toTaskListItem } from "../task-store.js";
import { id, now } from "../util.js";
import { chatService, roomMessages, toRoom, type ChatService, type RoomRow } from "./service.js";

async function visibleRoom(c: Context): Promise<RoomRow | undefined> {
  const actor = actorOf(c);
  if (!isAccountHolder(actor)) return;
  const row = (await db.select().from(chatRooms).where(eq(chatRooms.id, c.req.param("roomId")!))).at(0);
  if (row && await canUseOwned(row, actor) && await visibleProject(c, row.projectId)) return row;
}

async function visibleProject(c: Context, projectId: string) {
  return await canSeeProject(actorOf(c), projectId) && (await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId))).length > 0;
}

function isHumanRequest(c: Context) {
  return isAccountHolder(actorOf(c)) && !c.req.header("x-ash-source-task-id") && !c.req.header("x-ash-turn-token");
}

async function parseMembers(value: unknown, c: Context): Promise<ChatMember[]> {
  if (!Array.isArray(value) || !value.length || value.length > 24) throw new Error("请选择 1–24 位成员。");
  const profiles = await filterOwned(await db.select().from(agents), actorOf(c));
  const names = new Set<string>();
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error("成员配置无效。");
    const raw = entry as Record<string, unknown>;
    if (typeof raw.name !== "string" || !/^[\p{L}\p{N}_·.-]{1,32}$/u.test(raw.name) || names.has(raw.name)) throw new Error("成员名须唯一，限 32 字，不含空格或 @。");
    if (isAllMention(raw.name)) throw new Error("「all / 所有人」是召唤全体成员的保留名，请换一个成员名。");
    if (!AGENT_TYPES.includes(raw.agentType as ChatMember["agentType"])) throw new Error("请选择有效的智能体。");
    const executorId = typeof raw.executorId === "string" && raw.executorId ? raw.executorId : null;
    if (executorId && !profiles.some((profile) => profile.id === executorId && profile.type === raw.agentType)) throw new Error("所选执行器不存在或类型不匹配。");
    for (const field of ["model", "reasoningEffort"] as const) {
      if (raw[field] != null && (typeof raw[field] !== "string" || raw[field].length > 200)) throw new Error("模型或智能水平无效。");
    }
    const memberId = typeof raw.id === "string" && /^[\w-]{1,80}$/u.test(raw.id) ? raw.id : id();
    if (ids.has(memberId)) throw new Error("成员编号重复。");
    names.add(raw.name);
    ids.add(memberId);
    return { id: memberId, name: raw.name, agentType: raw.agentType as ChatMember["agentType"], executorId, model: raw.model as string || null, reasoningEffort: raw.reasoningEffort as string || null };
  });
}

async function snapshot(room: RoomRow, c: Context) {
  const messages = await roomMessages(room.id);
  const taskIds = messages.flatMap((message) => message.taskId ? [message.taskId] : []);
  const visible = await visibleTaskIds(actorOf(c), taskIds);
  const rows = visible.length ? await db.select().from(tasks).where(and(eq(tasks.projectId, room.projectId), inArray(tasks.id, visible))) : [];
  return { room: toRoom(room), messages, tasks: (await enrichTasks(rows)).map(toTaskListItem) };
}

export function mountChatRoutes(api: Hono, service: ChatService = chatService) {
  api.use("/chats/*", async (c, next) => {
    if (!isHumanRequest(c)) return c.json({ error: "聊天只接受用户操作，智能体消息不能唤醒成员。" }, 403);
    await next();
  });
  api.get("/chats", async (c) => {
    if (!isHumanRequest(c)) return c.json({ error: "用户身份必需" }, 403);
    const projectId = c.req.query("projectId");
    if (!projectId || !await visibleProject(c, projectId)) return c.json({ error: "project not found" }, 404);
    const rows = await filterOwned(await db.select().from(chatRooms).where(eq(chatRooms.projectId, projectId)), actorOf(c));
    return c.json(rows.map(toRoom));
  });
  api.post("/chats", async (c) => {
    if (!isHumanRequest(c)) return c.json({ error: "用户身份必需" }, 403);
    const body = await c.req.json();
    if (typeof body.projectId !== "string" || !await visibleProject(c, body.projectId)) return c.json({ error: "project not found" }, 404);
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 80) return c.json({ error: "群聊名称限 1–80 字。" }, 400);
    try {
      const members = await parseMembers(body.members, c);
      const row = { id: id(), projectId: body.projectId, name: body.name.trim(), members: JSON.stringify(members), ownerUserId: ownerIdOf(actorOf(c)), createdAt: now() };
      await db.insert(chatRooms).values(row);
      return c.json(toRoom(row), 201);
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : "成员配置无效" }, 400); }
  });
  api.get("/chats/:roomId", async (c) => {
    const room = await visibleRoom(c);
    return room ? c.json(await snapshot(room, c)) : c.json({ error: "chat not found" }, 404);
  });
  api.patch("/chats/:roomId", async (c) => {
    const room = await visibleRoom(c);
    if (!room) return c.json({ error: "chat not found" }, 404);
    const body = await c.req.json();
    const renaming = body.name !== undefined;
    const rewiring = body.members !== undefined;
    if (!renaming && !rewiring) return c.json({ error: "请提供要修改的群聊名称或成员。" }, 400);
    if (renaming && (typeof body.name !== "string" || !body.name.trim() || body.name.length > 80)) return c.json({ error: "群聊名称限 1–80 字。" }, 400);
    try {
      const patch: { name?: string; members?: string } = {};
      if (renaming) patch.name = (body.name as string).trim();
      // 成员原样回传不算换人：设置面板改名时会连成员一起提交，不该被在跑的回复挡住。
      if (rewiring) {
        const members = JSON.stringify(await parseMembers(body.members, c));
        if (members !== room.members) patch.members = members;
      }
      if (patch.members !== undefined) {
        const busy = await db.select({ id: chatMessages.id }).from(chatMessages).where(and(eq(chatMessages.roomId, room.id), inArray(chatMessages.status, ["queued", "running"]))).limit(1);
        if (busy.length) return c.json({ error: "请等待回复结束或停止回复后再修改成员。" }, 409);
      }
      if (Object.keys(patch).length) await db.update(chatRooms).set(patch).where(eq(chatRooms.id, room.id));
      return c.json(toRoom({ ...room, ...patch }));
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : "成员配置无效" }, 400); }
  });
  api.post("/chats/:roomId/messages", async (c) => {
    const room = await visibleRoom(c);
    if (!room) return c.json({ error: "chat not found" }, 404);
    const body = await c.req.json();
    if (typeof body.body !== "string" || !body.body.trim() || body.body.length > 8000 || typeof body.id !== "string" || !/^[\w-]{8,80}$/u.test(body.id)) return c.json({ error: "消息限 1–8000 字，并需有效消息编号。" }, 400);
    if (body.role !== undefined || body.mentions !== undefined) return c.json({ error: "角色和点名对象由服务器确定。" }, 400);
    try {
      await service.send(room, body.body.trim(), body.id, actorOf(c).name);
      return c.json(await snapshot(room, c), 202);
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : "消息发送失败" }, 409); }
  });
  api.post("/chats/:roomId/stop", async (c) => {
    const room = await visibleRoom(c);
    if (!room) return c.json({ error: "chat not found" }, 404);
    await service.stop(room.id);
    return c.json(await snapshot(room, c));
  });
  api.get("/chats/:roomId/events", async (c) => {
    if (!await visibleRoom(c)) return c.json({ error: "chat not found" }, 404);
    return streamSSE(c, async (stream) => {
      let previous = "";
      while (!stream.aborted) {
        const room = await visibleRoom(c);
        if (!room) { await stream.writeSSE({ event: "revoked", data: "{}" }); break; }
        const data = JSON.stringify(await snapshot(room, c));
        if (data !== previous) { await stream.writeSSE({ event: "snapshot", data }); previous = data; }
        else await stream.writeSSE({ event: "ping", data: "{}" });
        await stream.sleep(1000);
      }
    });
  });
}

import { and, eq, inArray } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { AGENT_TYPES } from "@ash/shared";
import type { ChatMember } from "@ash/shared/chat";
import { isAllMention } from "@ash/shared/chat";
import { db } from "../db/index.js";
import { agents, chatRooms, chatMessages, projects, tasks, workflows } from "../db/schema.js";
import { actorOf, isAccountHolder, ownerIdOf } from "../auth/context.js";
import { canSeeProject, visibleTaskIds } from "../auth/visibility.js";
import { canUseOwned, filterOwned } from "../auth/owned.js";
import { enrichTasks, toTaskListItem } from "../task-store.js";
import { id, now } from "../util.js";
import { chatService, roomMessages, toRoom, type ChatService, type RoomRow } from "./service.js";
import { chatContextStatus } from "./context-store.js";
import { validateAssistantWorkflow } from "./assistant.js";
import type { AssistantResult } from "@ash/shared/chat";

async function visibleRoom(c: Context): Promise<RoomRow | undefined> {
  const actor = actorOf(c);
  if (!isAccountHolder(actor)) return;
  const row = (await db.select().from(chatRooms).where(eq(chatRooms.id, c.req.param("roomId")!))).at(0);
  if (row && await canUseOwned(row, actor) && ((row.kind === "assistant" && !row.projectId) || await visibleProject(c, row.projectId))) return row;
}

async function visibleProject(c: Context, projectId: string) {
  return await canSeeProject(actorOf(c), projectId) && (await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId))).length > 0;
}

function isHumanRequest(c: Context) {
  return isAccountHolder(actorOf(c)) && !c.req.header("x-ash-source-task-id") && !c.req.header("x-ash-turn-token");
}

/** 成员 + 执行器的组合键。用 JSON 拼，免得分隔符和 id / 类型里的字符撞上。 */
const executorKey = (memberId: string, agentType: unknown, executorId: string) => JSON.stringify([memberId, agentType, executorId]);

/**
 * 校验一份成员配置。`existing` 是这个群当前已经存下来的成员：**已经存在的那一条不再重新
 * 体检执行器**——profile 被删之后，用户只想改个群名也会连带提交这份陈旧成员，严格校验会
 * 把改名一起 400 掉。新填进来的执行器仍然照常校验，运行时也仍有 `invokeChat` 那道闸
 * （执行器没了会明说「请在群成员配置中重新选择」），所以放行存量不会让活跑到别人的
 * profile 上。
 */
async function parseMembers(value: unknown, c: Context, existing: ChatMember[] = []): Promise<ChatMember[]> {
  if (!Array.isArray(value) || !value.length || value.length > 24) throw new Error("请选择 1–24 位成员。");
  const profiles = await filterOwned(await db.select().from(agents), actorOf(c));
  const grandfathered = new Set(existing.flatMap((member) => member.executorId ? [executorKey(member.id, member.agentType, member.executorId)] : []));
  const names = new Set<string>();
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error("成员配置无效。");
    const raw = entry as Record<string, unknown>;
    if (typeof raw.name !== "string" || !/^[\p{L}\p{N}_·.-]{1,32}$/u.test(raw.name) || names.has(raw.name)) throw new Error("成员名须唯一，限 32 字，不含空格或 @。");
    if (isAllMention(raw.name)) throw new Error("「all / 所有人」是召唤全体成员的保留名，请换一个成员名。");
    if (!AGENT_TYPES.includes(raw.agentType as ChatMember["agentType"])) throw new Error("请选择有效的智能体。");
    const executorId = typeof raw.executorId === "string" && raw.executorId ? raw.executorId : null;
    const memberId = typeof raw.id === "string" && /^[\w-]{1,80}$/u.test(raw.id) ? raw.id : id();
    if (executorId && !profiles.some((profile) => profile.id === executorId && profile.type === raw.agentType)
      && !grandfathered.has(executorKey(memberId, raw.agentType, executorId))) throw new Error("所选执行器不存在或类型不匹配。");
    for (const field of ["model", "reasoningEffort"] as const) {
      if (raw[field] != null && (typeof raw[field] !== "string" || raw[field].length > 200)) throw new Error("模型或智能水平无效。");
    }
    if (ids.has(memberId)) throw new Error("成员编号重复。");
    names.add(raw.name);
    ids.add(memberId);
    return { id: memberId, name: raw.name, agentType: raw.agentType as ChatMember["agentType"], executorId, model: raw.model as string || null, reasoningEffort: raw.reasoningEffort as string || null };
  });
}

async function snapshot(room: RoomRow, c: Context) {
  const messages = await roomMessages(room.id);
  const taskIds = messages.flatMap((message) => [...(message.taskId ? [message.taskId] : []), ...(message.assistant?.matches.map((match) => match.taskId) ?? [])]);
  const visible = await visibleTaskIds(actorOf(c), taskIds);
  const rows = visible.length ? await db.select().from(tasks).where(and(room.kind === "assistant" ? undefined : eq(tasks.projectId, room.projectId), inArray(tasks.id, visible))) : [];
  for (const message of messages) if (message.assistant) message.assistant.matches = message.assistant.matches.filter((match) => visible.includes(match.taskId));
  return { room: toRoom(room), messages, tasks: (await enrichTasks(rows)).map(toTaskListItem), context: await chatContextStatus(room.id) };
}

export function mountChatRoutes(api: Hono, service: ChatService = chatService) {
  api.use("/chats/*", async (c, next) => {
    if (!isHumanRequest(c)) return c.json({ error: "聊天只接受用户操作，智能体消息不能唤醒成员。" }, 403);
    await next();
  });
  api.get("/chats", async (c) => {
    if (!isHumanRequest(c)) return c.json({ error: "用户身份必需" }, 403);
    const kind = c.req.query("kind") === "assistant" ? "assistant" : "chat";
    const projectId = c.req.query("projectId") ?? "";
    if (!(kind === "assistant" && !projectId) && (!projectId || !await visibleProject(c, projectId))) return c.json({ error: "project not found" }, 404);
    const rows = await filterOwned(await db.select().from(chatRooms).where(and(eq(chatRooms.projectId, projectId), eq(chatRooms.kind, kind))), actorOf(c));
    return c.json(rows.map(toRoom));
  });
  api.post("/chats", async (c) => {
    if (!isHumanRequest(c)) return c.json({ error: "用户身份必需" }, 403);
    const body = await c.req.json();
    if (body.kind !== undefined && body.kind !== "chat" && body.kind !== "assistant") return c.json({ error: "聊天类型无效" }, 400);
    const kind = body.kind === "assistant" ? "assistant" : "chat";
    if (typeof body.projectId !== "string" || (!(kind === "assistant" && !body.projectId) && !await visibleProject(c, body.projectId))) return c.json({ error: "project not found" }, 404);
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 80) return c.json({ error: "群聊名称限 1–80 字。" }, 400);
    try {
      const members = await parseMembers(body.members, c);
      if (kind === "assistant" && members.length !== 1) throw new Error("助手只能接入一个智能体。");
      const row = { id: id(), kind, projectId: body.projectId, name: body.name.trim(), members: JSON.stringify(members), ownerUserId: ownerIdOf(actorOf(c)), createdAt: now() };
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
        const parsed = await parseMembers(body.members, c, toRoom(room).members);
        if (room.kind === "assistant" && parsed.length !== 1) throw new Error("助手只能接入一个智能体。");
        const members = JSON.stringify(parsed);
        if (members !== room.members) patch.members = members;
      }
      if (patch.members !== undefined) {
        const busy = await db.select({ id: chatMessages.id }).from(chatMessages).where(and(eq(chatMessages.roomId, room.id), inArray(chatMessages.status, ["queued", "running"]))).limit(1);
        if (busy.length || (await chatContextStatus(room.id)).status === "compacting") return c.json({ error: "请等待回复或历史整理结束，或停止回复后再修改成员。" }, 409);
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
    if (body.projectId !== undefined && (room.kind !== "assistant" || typeof body.projectId !== "string")) return c.json({ error: "项目上下文无效" }, 400);
    if (body.projectId && !await visibleProject(c, body.projectId)) return c.json({ error: "project not found" }, 404);
    try {
      await service.send(room, body.body.trim(), body.id, actorOf(c).name, body.projectId);
      return c.json(await snapshot(room, c), 202);
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : "消息发送失败" }, 409); }
  });
  api.post("/chats/:roomId/stop", async (c) => {
    const room = await visibleRoom(c);
    if (!room) return c.json({ error: "chat not found" }, 404);
    await service.stop(room.id);
    return c.json(await snapshot(room, c));
  });
  api.post("/chats/:roomId/messages/:messageId/workflow", async (c) => {
    const room = await visibleRoom(c);
    if (!room || room.kind !== "assistant") return c.json({ error: "assistant not found" }, 404);
    const messageId = c.req.param("messageId");
    try {
      const message = (await db.select().from(chatMessages).where(and(eq(chatMessages.id, messageId), eq(chatMessages.roomId, room.id)))).at(0);
      if (!message?.assistant || message.role !== "agent" || message.status !== "done") throw new Error("没有可保存的起手式草案。");
      const result = JSON.parse(message.assistant) as AssistantResult;
      if (result.workflowId) return c.json(await snapshot(room, c));
      const draft = await validateAssistantWorkflow(result.workflow, actorOf(c));
      const workflowId = `assistant-${message.id}`;
      result.workflowId = workflowId;
      await db.batch([
        db.insert(workflows).values({ id: workflowId, name: draft.name, description: draft.description, def: JSON.stringify(draft.def), ownerUserId: ownerIdOf(actorOf(c)), createdAt: now(), updatedAt: now() }).onConflictDoNothing(),
        db.update(chatMessages).set({ assistant: JSON.stringify(result) }).where(eq(chatMessages.id, message.id)),
        db.insert(chatMessages).values({ id: `workflow-${message.id}`, roomId: room.id, role: "system", author: "ash", body: `已将「${draft.name}」保存到起手式库（${workflowId}）。未更改默认起手式，也未运行任务。`, createdAt: now() }).onConflictDoNothing(),
      ]);
      return c.json(await snapshot(room, c));
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : "起手式保存失败" }, 400); }
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

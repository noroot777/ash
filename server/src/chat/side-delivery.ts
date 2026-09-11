import { and, eq, inArray } from "drizzle-orm";
import type { ChatMessage } from "@ash/shared/chat";
import { db } from "../db/index.js";
import { chatMessages, chatRooms, scheduledMessages, tasks, users } from "../db/schema.js";
import { SINGLE_ACTOR, type Actor } from "../auth/context.js";
import { isMultiUser } from "../auth/mode.js";
import { canSeeProject } from "../auth/visibility.js";
import { handoffBlockReason } from "../handoff-guard.js";
import { pendingMessageRow, publishPendingMessages, flushPendingForTask } from "../pending-messages.js";
import { steerQueuedMessage } from "../task-steer.js";
import type { parseSideChatReply } from "./side-prompt.js";

type Room = typeof chatRooms.$inferSelect;

export async function sideChatParent(room: Room) {
  let actor: Actor = SINGLE_ACTOR;
  if (await isMultiUser()) {
    const user = room.ownerUserId ? (await db.select().from(users).where(eq(users.id, room.ownerUserId))).at(0) : undefined;
    if (!user || user.status !== "active") throw new Error("侧聊所属用户已不可用，未发送到主任务。");
    actor = { kind: "user", userId: user.id, role: user.role as Actor["role"], name: user.name };
  }
  const parent = room.parentTaskId ? (await db.select().from(tasks).where(eq(tasks.id, room.parentTaskId))).at(0) : undefined;
  if (!parent || parent.projectId !== room.projectId || !await canSeeProject(actor, parent.projectId)) throw new Error("主任务不存在或已失去访问权限。");
  return parent;
}

export async function settleSideChat(room: Room, messageId: string, result: ReturnType<typeof parseSideChatReply>, notice: string | undefined, signal: AbortSignal) {
  const parent = await sideChatParent(room);
  if (result.forward) {
    const blocked = handoffBlockReason(parent.handoff);
    if (blocked || parent.archived || parent.mode !== "single") throw new Error(blocked ?? "主任务已归档或不支持回传，未发送。");
  }
  const text = result.forward ? `【来自侧聊 · ${room.name}】\n${result.forward.text}` : null;
  const pending = text ? { ...pendingMessageRow({ taskId: parent.id, text, ownerUserId: room.ownerUserId }), id: `side-${messageId}` } : null;
  const settled = await db.transaction(async (tx) => {
    signal.throwIfAborted();
    const updated = await tx.update(chatMessages).set({
      status: "done", context: null, body: notice ? `${result.reply}\n\n${notice}` : result.reply,
      modelReply: result.reply + (result.forward ? `\n[本轮已请求回传主任务，正文：${result.forward.text}；实际投递状态以 ash 回执为准]` : ""),
      forwardMessageId: pending?.id ?? null,
    }).where(and(eq(chatMessages.id, messageId), eq(chatMessages.roomId, room.id), eq(chatMessages.status, "running"))).returning({ id: chatMessages.id });
    if (!updated.length) return false;
    if (pending) await tx.insert(scheduledMessages).values(pending);
    return true;
  });
  return settled ? pending : undefined;
}

export async function dispatchSideMessage(messageId: string, taskId: string) {
  publishPendingMessages(taskId);
  try { await steerQueuedMessage(messageId, { nativeOnly: true }); }
  finally { flushPendingForTask(taskId); }
}

export async function sideMessageReceipts(messages: ChatMessage[], ids: string[]): Promise<void> {
  if (!ids.length) return;
  const rows = await db.select().from(scheduledMessages).where(inArray(scheduledMessages.id, ids));
  for (const message of messages) {
    const key = `side-${message.id}`;
    if (!ids.includes(key)) continue;
    const row = rows.find((entry) => entry.id === key);
    message.forward = { messageId: key, taskId: row?.taskId ?? "", text: row?.text ?? "回传消息已不可访问",
      status: !row ? "unavailable" : row.status === "sent" ? "sent" : row.status === "canceled" ? "canceled" : row.deliveringSince ? "delivering" : "queued" };
  }
}

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
import type { VerifiedSideChatReply } from "./side-authorization.js";

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

export async function settleSideChat(room: Room, messageId: string, result: VerifiedSideChatReply, notice: string | undefined, signal: AbortSignal) {
  let forwardError = result.forwardError ?? null;
  let parent: Awaited<ReturnType<typeof sideChatParent>> | undefined;
  try {
    parent = await sideChatParent(room);
    if (result.forward) {
      forwardError = handoffBlockReason(parent.handoff)
        ?? (parent.archived || parent.mode !== "single" ? "主任务已归档或不支持回传。" : null);
    }
  } catch (error) {
    if (result.forward) forwardError = error instanceof Error ? error.message : "主任务不可访问。";
  }
  const text = result.forward && !forwardError ? `【来自侧聊 · ${room.name}】\n${result.forward.text}` : null;
  const pending = text && parent ? { ...pendingMessageRow({ taskId: parent.id, text, ownerUserId: room.ownerUserId }), id: `side-${messageId}` } : null;
  // 格式降级的提示跟并发变更附注一样，只挂在展示正文后面；modelReply 另外标一句，让下一轮
  // 上下文里能看出「上一条是原始输出、不是按格式给的回答」。
  const displayed = [result.reply, result.formatWarning, notice].filter(Boolean).join("\n\n");
  const settled = await db.transaction(async (tx) => {
    signal.throwIfAborted();
    const updated = await tx.update(chatMessages).set({
      status: "done", context: null, body: displayed,
      modelReply: result.reply + (result.formatWarning ? "\n[上一轮未按约定 JSON 格式输出，以上为原始输出]" : "")
        + (forwardError ? `\n[未发送到主任务：${forwardError}]`
        : pending ? `\n[本轮已请求回传主任务，正文：${result.forward!.text}；实际投递状态以 ash 回执为准]` : ""),
      forwardMessageId: pending?.id ?? null,
      forwardError,
    }).where(and(eq(chatMessages.id, messageId), eq(chatMessages.roomId, room.id), eq(chatMessages.status, "running"))).returning({ id: chatMessages.id });
    if (!updated.length) return false;
    if (pending) await tx.insert(scheduledMessages).values(pending);
    return true;
  });
  return settled ? pending : undefined;
}

/**
 * 「发给主任务」那颗键：把侧聊里一条已经答完的回答**原文**交给主任务。跟回答里自带的回传
 * （settleSideChat）走同一条投递路：落一条待发送消息，主任务在跑就排着（能从待发送里撤回），
 * 空下来才送到；回执按同一个 id（side-<消息 id>）挂回那条回答上。
 *
 * 这一下是用户亲手点的，所以不过授权分类器——那道核验防的是「模型自己决定替你发」。
 * 撤回过的可以再发一次；排着、正在送、已送到的不重复落。
 */
export async function forwardSideAnswer(room: Room, messageId: string) {
  const message = (await db.select().from(chatMessages)
    .where(and(eq(chatMessages.id, messageId), eq(chatMessages.roomId, room.id)))).at(0);
  if (!message || message.role !== "agent" || message.status !== "done" || !message.body?.trim()) throw new Error("这条回答还没答完，不能发给主任务。");
  const parent = await sideChatParent(room);
  const blocked = handoffBlockReason(parent.handoff)
    ?? (parent.archived || parent.mode !== "single" ? "主任务已归档或不支持回传。" : null);
  if (blocked) throw new Error(blocked);
  const pending = { ...pendingMessageRow({ taskId: parent.id, text: `【来自侧聊 · ${room.name}】\n${message.body}`, ownerUserId: room.ownerUserId }), id: `side-${messageId}` };
  await db.transaction(async (tx) => {
    const existing = (await tx.select().from(scheduledMessages).where(eq(scheduledMessages.id, pending.id))).at(0);
    if (existing && existing.status !== "canceled") throw new Error(existing.status === "sent" ? "这条回答已经送到主任务了。" : "这条回答已经排着等主任务了。");
    if (existing) await tx.delete(scheduledMessages).where(eq(scheduledMessages.id, pending.id));
    await tx.insert(scheduledMessages).values(pending);
    await tx.update(chatMessages).set({ forwardMessageId: pending.id, forwardError: null }).where(eq(chatMessages.id, messageId));
  });
  void dispatchSideMessage(pending.id, pending.taskId).catch((error) => console.error("[side-chat] delivery deferred", error));
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

import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, ne, or } from "drizzle-orm";
import type { ChatContextStatus, ChatMessage } from "@ash/shared/chat";
import { db } from "../db/index.js";
import { chatContextEntries as entries, chatContextStates as states, chatContextResets as resets, chatMessages, chatSummaries as summaries } from "../db/schema.js";
import { id, now } from "../util.js";
import { contextMessage, estimateChatTokens } from "./context-format.js";

// 完成后的消息冻结为只含正文的记录；排队状态、时间戳和后续任务状态不再反复改动提示词前缀。
export async function captureChatHistory(roomId: string): Promise<number> {
  return (await captureChatSnapshot(roomId)).cutoff;
}

export async function captureChatSnapshot(roomId: string): Promise<{ cutoff: number; tail: string[] }> {
  return db.transaction(async (tx) => {
    const pending = (await tx.select({ id: chatMessages.id, createdAt: chatMessages.createdAt }).from(chatMessages)
      .where(and(eq(chatMessages.roomId, roomId), inArray(chatMessages.status, ["queued", "running"])))
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id)).limit(1)).at(0);
    const beforePending = pending ? or(lt(chatMessages.createdAt, pending.createdAt), and(eq(chatMessages.createdAt, pending.createdAt), lt(chatMessages.id, pending.id))) : undefined;
    const fields = { id: chatMessages.id, role: chatMessages.role, author: chatMessages.author, body: chatMessages.body, taskId: chatMessages.taskId };
    const unfrozen = and(eq(chatMessages.roomId, roomId), ne(chatMessages.role, "system"), inArray(chatMessages.status, ["done", "failed", "stopped"]), isNull(entries.sequence));
    for (;;) {
      const missing = await tx.select(fields)
        .from(chatMessages).leftJoin(entries, eq(entries.messageId, chatMessages.id))
        .where(and(unfrozen, beforePending))
        .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id)).limit(500);
      if (!missing.length) break;
      for (const message of missing) {
        const content = contextMessage({ ...message, role: message.role as ChatMessage["role"] });
        await tx.insert(entries).values({ roomId, messageId: message.id, content, tokens: estimateChatTokens(`${content}\n`) }).onConflictDoNothing();
      }
    }
    // 未完成回复之后的已完成消息只进入本次快照，等缺口补齐后再按原时间顺序冻结。
    const tail = pending ? await tx.select(fields).from(chatMessages).leftJoin(entries, eq(entries.messageId, chatMessages.id))
      .where(unfrozen).orderBy(asc(chatMessages.createdAt), asc(chatMessages.id)) : [];
    const cutoff = (await tx.select({ sequence: entries.sequence }).from(entries).where(eq(entries.roomId, roomId)).orderBy(desc(entries.sequence)).limit(1)).at(0)?.sequence ?? 0;
    return { cutoff, tail: tail.map((message) => contextMessage({ ...message, role: message.role as ChatMessage["role"] })) };
  });
}

export async function readChatHistory(roomId: string, cutoff: number) {
  const reset = await chatContextReset(roomId);
  const after = reset?.afterSequence ?? 0;
  const summary = (await db.select().from(summaries).where(and(eq(summaries.roomId, roomId), gt(summaries.throughSequence, after), lte(summaries.throughSequence, cutoff)))
    .orderBy(desc(summaries.throughSequence), desc(summaries.id)).limit(1)).at(0);
  const messages = await db.select().from(entries).where(and(eq(entries.roomId, roomId), gt(entries.sequence, summary?.throughSequence ?? after), lte(entries.sequence, cutoff)))
    .orderBy(asc(entries.sequence));
  return { summary, messages, tokens: (summary?.tokens ?? 0) + messages.reduce((sum, message) => sum + message.tokens, 0) };
}

export async function contextState(roomId: string) {
  return (await db.select().from(states).where(eq(states.roomId, roomId))).at(0);
}

export async function setContextState(roomId: string, status: ChatContextStatus["status"], error: string | null = null) {
  const updatedAt = now();
  const value = { roomId, status, error, updatedAt, failedAt: status === "failed" ? updatedAt : null };
  await db.insert(states).values(value).onConflictDoUpdate({ target: states.roomId, set: value });
}

export async function acknowledgeContextFailure(roomId: string) {
  // 清除已不妨碍当前请求的提示，保留失败时间以维持前后台重试冷却。
  await db.update(states).set({ status: "idle", error: null, updatedAt: now() })
    .where(and(eq(states.roomId, roomId), eq(states.status, "failed")));
}

export async function chatContextStatus(roomId: string): Promise<ChatContextStatus> {
  const state = await contextState(roomId);
  const reset = await chatContextReset(roomId);
  const summary = (await db.select({ id: summaries.id }).from(summaries).where(and(eq(summaries.roomId, roomId), gt(summaries.throughSequence, reset?.afterSequence ?? 0))).limit(1)).at(0);
  return { status: (state?.status ?? "idle") as ChatContextStatus["status"], error: state?.error ?? null, hasSummary: !!summary, clearedAt: reset?.clearedAt ?? null };
}

async function chatContextReset(roomId: string) {
  return (await db.select().from(resets).where(eq(resets.roomId, roomId))).at(0);
}

export async function resetChatContext(roomId: string, command: { id: string; body: string; author: string }) {
  await captureChatHistory(roomId);
  const clearedAt = now();
  await db.transaction(async (tx) => {
    await tx.insert(chatMessages).values({ ...command, roomId, role: "user", createdAt: clearedAt });
    await tx.insert(chatMessages).values({ id: id(), roomId, role: "system", author: "系统", body: "上下文已清空。之后的点名从这里重新开始；之前的消息仍可查看，但不会再提供给智能体。", createdAt: new Date(Date.parse(clearedAt) + 1).toISOString() });
    const content = contextMessage({ ...command, role: "user" });
    const inserted = await tx.insert(entries).values({ roomId, messageId: command.id, content, tokens: estimateChatTokens(`${content}\n`) }).returning({ sequence: entries.sequence });
    const afterSequence = inserted[0]!.sequence;
    await tx.insert(resets).values({ roomId, afterSequence, clearedAt }).onConflictDoUpdate({ target: resets.roomId, set: { afterSequence, clearedAt } });
    await tx.insert(states).values({ roomId, status: "idle", error: null, updatedAt: clearedAt })
      .onConflictDoUpdate({ target: states.roomId, set: { status: "idle", error: null, failedAt: null, updatedAt: clearedAt } });
  });
}

export async function chatHasPending(roomId: string) {
  return (await db.select({ id: chatMessages.id }).from(chatMessages)
    .where(and(eq(chatMessages.roomId, roomId), inArray(chatMessages.status, ["queued", "running"]))).limit(1)).length > 0;
}

export async function recoverChatContext() {
  await db.update(states).set({ status: "stopped", error: "服务重启，历史整理已中断；已保存的摘要和原文仍保留，下次点名时按需继续。", updatedAt: now() })
    .where(eq(states.status, "compacting"));
}

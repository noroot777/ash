import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { ChatMember, ChatMessage, ChatRoom } from "@ash/shared/chat";
import { isChatClearCommand, mentionedMembers } from "@ash/shared/chat";
import { db } from "../db/index.js";
import { chatRooms, chatMessages } from "../db/schema.js";
import { id, now } from "../util.js";
import { createTasks } from "../task-store.js";
import { runTask } from "../task-run.js";
import { invokeChat } from "./execution.js";
import { parseChatReply } from "./prompt.js";
import { ChatBoundaryError } from "./boundary.js";
import { ChatContextManager } from "./context.js";
import { limitedChatInvoke } from "./invocation-queue.js";
import type { ChatContextPolicy } from "./context-format.js";

export type RoomRow = typeof chatRooms.$inferSelect;
type MessageRow = typeof chatMessages.$inferSelect;
export const toRoom = (row: RoomRow): ChatRoom => ({ id: row.id, projectId: row.projectId, name: row.name, members: JSON.parse(row.members), createdAt: row.createdAt });
export const toMessage = ({ context: _context, modelReply: _modelReply, ...row }: MessageRow): ChatMessage => ({ ...row, role: row.role as ChatMessage["role"], status: row.status as ChatMessage["status"], mentions: JSON.parse(row.mentions) });

export async function roomMessages(roomId: string) {
  const rows = await db.select().from(chatMessages).where(eq(chatMessages.roomId, roomId)).orderBy(desc(chatMessages.createdAt), desc(chatMessages.id)).limit(500);
  return rows.reverse().map(toMessage);
}

export class ChatService {
  private active = new Map<string, { roomId: string; memberId: string; abort: AbortController }>();
  private pumping = false;
  private sending = new Map<string, Promise<void>>();
  private stopping = new Set<string>();
  private invoke: typeof invokeChat;
  private contexts: ChatContextManager;
  constructor(invoke = invokeChat, private startTask = runTask, policy?: ChatContextPolicy) {
    this.invoke = limitedChatInvoke(invoke);
    this.contexts = new ChatContextManager(this.invoke, policy);
  }

  async recover() {
    await db.update(chatMessages).set({ status: "stopped", body: "服务重启，回复已中断。请重新 @ 该成员继续。", context: null })
      .where(inArray(chatMessages.status, ["queued", "running"]));
    await this.contexts.recover();
  }

  async send(row: RoomRow, body: string, messageId: string, author: string) {
    const previous = this.sending.get(row.id) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.sendNow(row, body, messageId, author));
    this.sending.set(row.id, pending);
    try { await pending; }
    finally { if (this.sending.get(row.id) === pending) this.sending.delete(row.id); }
  }

  private async sendNow(row: RoomRow, body: string, messageId: string, author: string) {
    const existing = (await db.select().from(chatMessages).where(eq(chatMessages.id, messageId))).at(0);
    if (existing) {
      if (existing.roomId !== row.id || existing.role !== "user" || existing.body !== body) throw new Error("消息编号冲突，请刷新后重试。");
      return;
    }
    if (isChatClearCommand(body)) {
      await this.stop(row.id);
      await this.contexts.clear(row.id, { id: messageId, body, author });
      return;
    }
    const room = toRoom(row);
    const mentions = mentionedMembers(body, room.members);
    const { cutoff, tail } = mentions.length ? await this.contexts.captureSnapshot(row.id) : { cutoff: 0, tail: [] };
    const timestamp = now();
    await db.transaction(async (tx) => {
      await tx.insert(chatMessages).values({ id: messageId, roomId: row.id, role: "user", author, body, mentions: JSON.stringify(mentions.map((member) => member.id)), createdAt: timestamp });
      for (const [position, member] of mentions.entries()) {
        await tx.insert(chatMessages).values({ id: id(), roomId: row.id, role: "agent", memberId: member.id, author: member.name, status: "queued", createdAt: new Date(Date.parse(timestamp) + position + 1).toISOString(), context: JSON.stringify({ cutoff, tail, source: body, member }) });
      }
    });
    void this.pump();
  }

  async stop(roomId: string) {
    this.stopping.add(roomId);
    try {
      const body = "你已停止这次回复。再次 @ 才会继续；已创建的任务可在任务卡中管理。";
      const stopped = await db.update(chatMessages).set({ status: "stopped", body, context: null })
        .where(and(eq(chatMessages.roomId, roomId), inArray(chatMessages.status, ["queued", "running"]))).returning({ id: chatMessages.id });
      const contextStopped = this.contexts.stop(roomId);
      for (const message of stopped) this.active.get(message.id)?.abort.abort(new Error(body));
      await contextStopped;
    } finally { this.stopping.delete(roomId); void this.pump(); }
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const queued = await db.select().from(chatMessages).where(eq(chatMessages.status, "queued")).orderBy(asc(chatMessages.createdAt));
      for (const message of queued) {
        if (this.active.size >= 4) break;
        if (this.stopping.has(message.roomId)) continue;
        if (!message.memberId || [...this.active.values()].some((entry) => entry.roomId === message.roomId && entry.memberId === message.memberId)) continue;
        const abort = new AbortController();
        this.active.set(message.id, { roomId: message.roomId, memberId: message.memberId, abort });
        let completed: ChatMember | undefined;
        void this.reply(message, abort).then((member) => { completed = member; }).finally(() => {
          this.active.delete(message.id);
          void this.pump();
          if (completed) void this.contexts.prewarm(message.roomId, completed).catch((error) => console.error("[chat] background context failed", error));
        }).catch((error) => console.error("[chat] reply settlement failed", error));
      }
    } catch (error) {
      console.error("[chat] queue failed", error);
    } finally {
      this.pumping = false;
    }
  }

  private async reply(message: MessageRow, abort: AbortController) {
    const timer = setTimeout(() => abort.abort(new Error("回复超过五分钟，已停止。请重新 @ 重试。")), 300000);
    try {
      const claimed = await db.update(chatMessages).set({ status: "running" })
        .where(and(eq(chatMessages.id, message.id), eq(chatMessages.status, "queued"))).returning();
      if (!claimed.length) return;
      abort.signal.throwIfAborted();
      const room = (await db.select().from(chatRooms).where(eq(chatRooms.id, message.roomId))).at(0);
      if (!room || !message.context) throw new Error("群聊或成员不存在，请重新选择成员。");
      const context = JSON.parse(message.context) as { prompt?: string; cutoff: number; tail?: string[]; source: string; member: ChatMember };
      const member = context.member;
      const prompt = context.prompt ?? await this.contexts.prepare(room, member, context.cutoff, context.source, abort.signal, context.tail);
      const invoked = await this.invoke(member, room.ownerUserId, prompt, abort.signal, room.projectId);
      const result = parseChatReply(invoked.text);
      abort.signal.throwIfAborted();
      let taskToStart: string | null = null;
      if (result.task) {
        const taskId = id();
        const timestamp = now();
        await createTasks([{
          id: taskId, projectId: room.projectId, title: result.task.title,
          body: `来源群聊：${room.name}；委派成员：${member.name}\n\n${result.task.body}\n\n【用户原始委派，供核对上下文】\n${context.source}`,
          agentType: member.agentType, executorId: member.executorId, model: member.model,
          reasoningEffort: member.reasoningEffort, ownerUserId: room.ownerUserId,
          mode: "single", workflowMode: "free", useWorktree: true,
          createdAt: timestamp, updatedAt: timestamp,
        }], async () => {
          await db.update(chatMessages).set({ taskId }).where(eq(chatMessages.id, message.id));
        });
        abort.signal.throwIfAborted();
        taskToStart = taskId;
      }
      // 并发变更附注只进展示用的 body，不进 modelReply：后续轮次的上下文取 modelReply，
      // 附注混进去会被智能体当成对话内容复读。
      const settled = await db.update(chatMessages).set({ body: invoked.notice ? `${result.reply}\n\n${invoked.notice}` : result.reply, modelReply: result.reply, status: "done", context: null })
        .where(and(eq(chatMessages.id, message.id), eq(chatMessages.status, "running"))).returning();
      if (taskToStart && settled.length && !abort.signal.aborted) {
        void this.startTask(taskToStart).catch(async (error) => {
          await db.update(chatMessages).set({ status: "failed", body: `任务已创建，但启动失败：${error instanceof Error ? error.message : String(error)}。请打开任务重试。` }).where(eq(chatMessages.id, message.id));
        });
      }
      if (settled.length && !abort.signal.aborted) return member;
    } catch (error) {
      const boundary = error instanceof ChatBoundaryError;
      await db.update(chatMessages).set({ status: boundary ? "failed" : abort.signal.aborted ? "stopped" : "failed", context: null, body: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) })
        .where(and(eq(chatMessages.id, message.id), inArray(chatMessages.status, boundary ? ["running", "stopped"] : ["running"])));
    } finally {
      clearTimeout(timer);
    }
  }
}

export const chatService = new ChatService();

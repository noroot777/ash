import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { ChatMember, ChatMessage, ChatRoom } from "@ash/shared/chat";
import { mentionedMembers } from "@ash/shared/chat";
import { db } from "../db/index.js";
import { chatRooms, chatMessages } from "../db/schema.js";
import { id, now } from "../util.js";
import { createTasks } from "../task-store.js";
import { runTask } from "../task-run.js";
import { invokeChat } from "./execution.js";
import { chatPrompt, parseChatReply } from "./prompt.js";

export type RoomRow = typeof chatRooms.$inferSelect;
type MessageRow = typeof chatMessages.$inferSelect;
export const toRoom = (row: RoomRow): ChatRoom => ({ id: row.id, projectId: row.projectId, name: row.name, members: JSON.parse(row.members), createdAt: row.createdAt });
export const toMessage = ({ context: _context, ...row }: MessageRow): ChatMessage => ({ ...row, role: row.role as ChatMessage["role"], status: row.status as ChatMessage["status"], mentions: JSON.parse(row.mentions) });

export async function roomMessages(roomId: string) {
  const rows = await db.select().from(chatMessages).where(eq(chatMessages.roomId, roomId)).orderBy(desc(chatMessages.createdAt), desc(chatMessages.id)).limit(500);
  return rows.reverse().map(toMessage);
}

export class ChatService {
  private active = new Map<string, { roomId: string; memberId: string; abort: AbortController }>();
  private pumping = false;
  constructor(private invoke = invokeChat, private startTask = runTask) {}

  async recover() {
    await db.update(chatMessages).set({ status: "stopped", body: "服务重启，回复已中断。请重新 @ 该成员继续。", context: null })
      .where(inArray(chatMessages.status, ["queued", "running"]));
  }

  async send(row: RoomRow, body: string, messageId: string, author: string) {
    const existing = (await db.select().from(chatMessages).where(eq(chatMessages.id, messageId))).at(0);
    if (existing) {
      if (existing.roomId !== row.id || existing.role !== "user" || existing.body !== body) throw new Error("消息编号冲突，请刷新后重试。");
      return;
    }
    const room = toRoom(row);
    const mentions = mentionedMembers(body, room.members);
    const history = await roomMessages(row.id);
    const timestamp = now();
    await db.transaction(async (tx) => {
      await tx.insert(chatMessages).values({ id: messageId, roomId: row.id, role: "user", author, body, mentions: JSON.stringify(mentions.map((member) => member.id)), createdAt: timestamp });
      for (const [position, member] of mentions.entries()) {
        await tx.insert(chatMessages).values({ id: id(), roomId: row.id, role: "agent", memberId: member.id, author: member.name, status: "queued", createdAt: new Date(Date.parse(timestamp) + position + 1).toISOString(), context: JSON.stringify({ prompt: chatPrompt(member, history, body), source: body, member }) });
      }
    });
    void this.pump();
  }

  async stop(roomId: string) {
    const stopped = await db.update(chatMessages).set({ status: "stopped", body: "你已停止这次回复。再次 @ 才会继续；已创建的任务可在任务卡中管理。", context: null })
      .where(and(eq(chatMessages.roomId, roomId), inArray(chatMessages.status, ["queued", "running"]))).returning({ id: chatMessages.id });
    for (const message of stopped) this.active.get(message.id)?.abort.abort();
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const queued = await db.select().from(chatMessages).where(eq(chatMessages.status, "queued")).orderBy(asc(chatMessages.createdAt));
      for (const message of queued) {
        if (this.active.size >= 4) break;
        if (!message.memberId || [...this.active.values()].some((entry) => entry.roomId === message.roomId && entry.memberId === message.memberId)) continue;
        const abort = new AbortController();
        this.active.set(message.id, { roomId: message.roomId, memberId: message.memberId, abort });
        void this.reply(message, abort).finally(() => {
          this.active.delete(message.id);
          void this.pump();
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
      const context = JSON.parse(message.context) as { prompt: string; source: string; member: ChatMember };
      const member = context.member;
      const result = parseChatReply(await this.invoke(member, room.ownerUserId, context.prompt, abort.signal, room.projectId));
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
      const settled = await db.update(chatMessages).set({ body: result.reply, status: "done", context: null })
        .where(and(eq(chatMessages.id, message.id), eq(chatMessages.status, "running"))).returning();
      if (taskToStart && settled.length && !abort.signal.aborted) {
        void this.startTask(taskToStart).catch(async (error) => {
          await db.update(chatMessages).set({ status: "failed", body: `任务已创建，但启动失败：${error instanceof Error ? error.message : String(error)}。请打开任务重试。` }).where(eq(chatMessages.id, message.id));
        });
      }
    } catch (error) {
      await db.update(chatMessages).set({ status: abort.signal.aborted ? "stopped" : "failed", context: null, body: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) })
        .where(and(eq(chatMessages.id, message.id), eq(chatMessages.status, "running")));
    } finally {
      clearTimeout(timer);
    }
  }
}

export const chatService = new ChatService();

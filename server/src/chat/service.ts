import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
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
import { assistantFormatter, invokeAssistant } from "./assistant.js";
import { parseSideChatReply, sideChatPrompt } from "./side-prompt.js";
import { sideChatParent, settleSideChat, dispatchSideMessage, sideMessageReceipts } from "./side-delivery.js";

export type RoomRow = typeof chatRooms.$inferSelect;
type MessageRow = typeof chatMessages.$inferSelect;
export const toRoom = (row: RoomRow): ChatRoom => ({ id: row.id, projectId: row.projectId, name: row.name, members: JSON.parse(row.members), createdAt: row.createdAt, kind: row.kind === "side" ? "side" : row.kind === "assistant" ? "assistant" : "chat", parentTaskId: row.parentTaskId });
export const toMessage = ({ context: _context, modelReply: _modelReply, notice: _notice, forwardMessageId: _forwardMessageId, assistant, ...row }: MessageRow): ChatMessage => ({ ...row, role: row.role as ChatMessage["role"], status: row.status as ChatMessage["status"], mentions: JSON.parse(row.mentions), ...(assistant ? { assistant: JSON.parse(assistant) } : {}) });

// stop()/recover() 用固定文案覆盖 body 时，把已持久化的目录附注（chat_messages.notice，
// invoke 一返回就落库）拼回正文。附注是「项目可能被并发改动/观察失效」的安全信息，不能随
// 覆盖消失；而崩溃/重启后旧进程的闭包已不存在，唯一来源就是这个列（审查第 4 轮复现：
// task.created 时点 SIGKILL 旧进程，新进程 recover() 曾把附注连同 running 正文一起抹掉）。
const withStoredNotice = (text: string | SQL) =>
  sql`${text} || CASE WHEN ${chatMessages.notice} IS NULL THEN ${""} ELSE ${"\n\n"} || ${chatMessages.notice} END`;

export async function roomMessages(roomId: string) {
  const rows = await db.select().from(chatMessages).where(eq(chatMessages.roomId, roomId)).orderBy(desc(chatMessages.createdAt), desc(chatMessages.id)).limit(500);
  const messages = rows.reverse().map(toMessage);
  await sideMessageReceipts(messages, rows.flatMap((row) => row.forwardMessageId ? [row.forwardMessageId] : []));
  return messages;
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
    await db.update(chatMessages).set({ status: "stopped", body: withStoredNotice("服务重启，回复已中断。请重新发送；群聊中需 @ 该成员。"), context: null })
      .where(inArray(chatMessages.status, ["queued", "running"]));
    await this.contexts.recover();
  }

  async send(row: RoomRow, body: string, messageId: string, author: string, projectId?: string) {
    const previous = this.sending.get(row.id) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.sendNow(row, body, messageId, author, projectId));
    this.sending.set(row.id, pending);
    try { await pending; }
    finally { if (this.sending.get(row.id) === pending) this.sending.delete(row.id); }
  }

  private async sendNow(row: RoomRow, body: string, messageId: string, author: string, projectId?: string) {
    const existing = (await db.select().from(chatMessages).where(eq(chatMessages.id, messageId))).at(0);
    if (existing) {
      if (existing.roomId !== row.id || existing.role !== "user" || existing.body !== body) throw new Error("消息编号冲突，请刷新后重试。");
      return;
    }
    if (row.kind === "side") {
      await sideChatParent(row);
      const busy = await db.select({ id: chatMessages.id }).from(chatMessages).where(and(eq(chatMessages.roomId, row.id), inArray(chatMessages.status, ["queued", "running"]))).limit(1);
      if (busy.length) throw new Error("请等待侧聊回复结束，或先停止回复再发送。");
    }
    if (row.kind !== "side" && isChatClearCommand(body)) {
      await this.stop(row.id);
      await this.contexts.clear(row.id, { id: messageId, body, author });
      return;
    }
    const room = toRoom(row);
    const mentions = room.kind !== "chat" ? room.members.slice(0, 1) : mentionedMembers(body, room.members);
    const { cutoff, tail } = mentions.length ? await this.contexts.captureSnapshot(row.id) : { cutoff: 0, tail: [] };
    const timestamp = now();
    await db.transaction(async (tx) => {
      await tx.insert(chatMessages).values({ id: messageId, roomId: row.id, role: "user", author, body, mentions: JSON.stringify(mentions.map((member) => member.id)), createdAt: timestamp });
      for (const [position, member] of mentions.entries()) {
        await tx.insert(chatMessages).values({ id: id(), roomId: row.id, role: "agent", memberId: member.id, author: member.name, status: "queued", createdAt: new Date(Date.parse(timestamp) + position + 1).toISOString(), context: JSON.stringify({ cutoff, tail, source: body, member, projectId: row.kind === "assistant" ? projectId ?? row.projectId : row.projectId }) });
      }
    });
    void this.pump();
  }

  async stop(roomId: string) {
    this.stopping.add(roomId);
    try {
      const body = sql`CASE WHEN (SELECT kind FROM chat_rooms WHERE id = ${roomId}) = 'side'
        THEN ${"你已停止侧聊回复，主任务不受影响。已回传的消息仍以回执为准；发送新消息可继续。"}
        WHEN (SELECT kind FROM chat_rooms WHERE id = ${roomId}) = 'assistant'
        THEN ${"你已停止这次回复。发送新消息可继续；已创建的任务可在任务卡中管理。"}
        ELSE ${"你已停止这次回复。再次 @ 才会继续；已创建的任务可在任务卡中管理。"} END`;
      const stopped = await db.update(chatMessages).set({ status: "stopped", body: withStoredNotice(body), context: null })
        .where(and(eq(chatMessages.roomId, roomId), inArray(chatMessages.status, ["queued", "running"]))).returning({ id: chatMessages.id });
      const contextStopped = this.contexts.stop(roomId);
      for (const message of stopped) this.active.get(message.id)?.abort.abort(new Error("你已停止这次回复。"));
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
    // 目录观察附注与结算结果正交：只要 invoke 已经返回（观察结果已取得），无论后面是
    // 解析失败、任务创建/启动失败、停止还是进程崩溃后重启，终态正文都必须带上附注——
    // 这些失败回合恰恰是用户最需要知道项目可能被改动/观察失效的时候。所以 notice 一
    // 取得就写进 chat_messages.notice 持久列（跨进程的唯一来源），本回合内的终态写入
    // 用闭包值拼接（与列值相同）。附注仍不进 modelReply（上下文取 modelReply，混入会
    // 被智能体当对话内容复读）。
    let notice: string | undefined;
    const withNotice = (text: string) => notice ? `${text}\n\n${notice}` : text;
    // 停止竞态的残余窗口：stop() 在 notice 落列之前就把本消息覆盖成停止文案（此时列还是
    // NULL，withStoredNotice 拼不到），随后本轮的终态更新命中 0 行。已取得的附注不能跟着
    // 消失——补写在既有文案之后；body 等值条件保证并发下只补一次、不覆盖别人的新写入。
    const preserveNotice = async () => {
      if (!notice) return;
      const current = (await db.select().from(chatMessages).where(eq(chatMessages.id, message.id))).at(0);
      if (!current || current.status !== "stopped" || current.body.includes(notice)) return;
      await db.update(chatMessages).set({ body: `${current.body}\n\n${notice}` })
        .where(and(eq(chatMessages.id, message.id), eq(chatMessages.body, current.body)));
    };
    try {
      const claimed = await db.update(chatMessages).set({ status: "running" })
        .where(and(eq(chatMessages.id, message.id), eq(chatMessages.status, "queued"))).returning();
      if (!claimed.length) return;
      abort.signal.throwIfAborted();
      const storedRoom = (await db.select().from(chatRooms).where(eq(chatRooms.id, message.roomId))).at(0);
      if (!storedRoom || !message.context) throw new Error("群聊或成员不存在，请重新选择成员。");
      const context = JSON.parse(message.context) as { prompt?: string; cutoff: number; tail?: string[]; source: string; member: ChatMember; projectId?: string };
      const room = storedRoom.kind === "assistant" && context.projectId !== undefined ? { ...storedRoom, projectId: context.projectId } : storedRoom;
      const member = context.member;
      const isAssistant = room.kind === "assistant";
      if (room.kind === "side") await sideChatParent(room);
      const format = room.kind === "side" ? sideChatPrompt : isAssistant ? await assistantFormatter(room) : undefined;
      const prompt = context.prompt ?? await this.contexts.prepare(room, member, context.cutoff, context.source, abort.signal, context.tail, format, isAssistant ? 9000 : 0);
      const assistantReply = isAssistant ? await invokeAssistant(member, room, prompt, abort.signal, this.invoke) : undefined;
      const invoked = assistantReply ? { text: "", notice: undefined } : await this.invoke(member, room.ownerUserId, prompt, abort.signal, room.projectId, room.kind === "side" ? { purpose: "side", taskId: room.parentTaskId! } : undefined);
      notice = invoked.notice;
      // 落列必须和「补 stopped 正文」是同一条 UPDATE：stop() 可能已在 notice 落列之前把本消息
      // 覆盖成不带附注的停止文案（那时列还是 NULL，withStoredNotice 拼不到）。若分两步写、
      // 中间进程崩溃，preserveNotice 的闭包消失，而 recover() 只处理 queued/running——附注就
      // 永久藏在列里、正文却不可见（toMessage 剥 notice 列，页面只显示 body）。原子写让
      // 「列已落 ⇒ 终态正文可见」在任何崩溃时点都成立；instr 判重保证与 preserveNotice 幂等。
      if (notice) await db.update(chatMessages).set({
        notice,
        body: sql`CASE WHEN ${chatMessages.status} = ${"stopped"} AND ${chatMessages.body} IS NOT NULL AND instr(${chatMessages.body}, ${notice}) = 0 THEN ${chatMessages.body} || ${"\n\n"} || ${notice} ELSE ${chatMessages.body} END`,
      }).where(eq(chatMessages.id, message.id));
      if (room.kind === "side") {
        const pending = await settleSideChat(room, message.id, parseSideChatReply(invoked.text, context.source), notice, abort.signal);
        if (pending) void dispatchSideMessage(pending.id, pending.taskId).catch((error) => console.error("[side-chat] delivery deferred", error));
        await preserveNotice();
        return abort.signal.aborted ? undefined : member;
      }
      const result = assistantReply ?? parseChatReply(invoked.text);
      abort.signal.throwIfAborted();
      let taskToStart: string | null = null;
      if (result.task) {
        const taskId = id();
        const timestamp = now();
        await createTasks([{
          id: taskId, projectId: room.projectId, title: result.task.title,
          creationOrigin: JSON.stringify({ kind: "agent", agentType: member.agentType, executorLabel: member.name,
            chatRoomId: room.id, chatMemberId: member.id }),
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
      const modelReply = assistantReply ? JSON.stringify({ reply: result.reply, assistant: assistantReply.assistant }) : result.reply;
      const settled = await db.update(chatMessages).set({ body: withNotice(result.reply), modelReply, assistant: assistantReply ? JSON.stringify(assistantReply.assistant) : null, status: "done", context: null })
        .where(and(eq(chatMessages.id, message.id), eq(chatMessages.status, "running"))).returning();
      if (!settled.length) { await preserveNotice(); return; }
      if (taskToStart && !abort.signal.aborted) {
        void this.startTask(taskToStart).catch(async (error) => {
          await db.update(chatMessages).set({ status: "failed", body: withNotice(`任务已创建，但启动失败：${error instanceof Error ? error.message : String(error)}。请打开任务重试。`) }).where(eq(chatMessages.id, message.id));
        });
      }
      if (!abort.signal.aborted) return member;
    } catch (error) {
      const boundary = error instanceof ChatBoundaryError;
      const updated = await db.update(chatMessages).set({ status: boundary ? "failed" : abort.signal.aborted ? "stopped" : "failed", context: null, body: withNotice(error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)) })
        .where(and(eq(chatMessages.id, message.id), inArray(chatMessages.status, boundary ? ["running", "stopped"] : ["running"]))).returning({ id: chatMessages.id });
      if (!updated.length) await preserveNotice();
    } finally {
      clearTimeout(timer);
    }
  }
}

export const chatService = new ChatService();

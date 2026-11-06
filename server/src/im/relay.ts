// 飞书里说的话进 ash 的聊天房间（单聊 → 助手房间，群 @ → 项目群聊房间），房间里的回复再
// 发回飞书。
//
// chat 没有「回复完成」事件，只能轮询房间快照：每 2 秒看一眼还在等回复的那几条（没有在等的
// 就不看）。投进房间的消息 id 由飞书消息 id 派生、正文与附件路径记在 im_inbound 上，所以
// 重启后重投也是同一条（chat 按 id + 正文判重）。
//
// 智能体回复对上用户那条消息靠 chat_messages.reply_to（同一事务里插入的那条回复）。
import { createHash } from "node:crypto";
import type { TaskListItem } from "@ash/shared";
import type { ChatMessage, ChatRoom } from "@ash/shared/chat";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { imInbound } from "../db/schema-im.js";
import { now } from "../util.js";
import type { ImPrincipal } from "../auth/im-actor.js";
import type { AshClient } from "./ash-client.js";
import { CHANNEL, updateBinding } from "./binding.js";
import { taskLink } from "./cards.js";
import type { CommandRunner, InboundContext } from "./commands.js";
import { groupRoomOf, setGroupRoom, type GroupRow } from "./groups.js";
import { readOptions } from "./meta.js";
import type { Destination } from "./outbox.js";
import { scrubText, scrubTitle } from "./scrub.js";

const POLL_MS = 2_000;
const REPLY_TIMEOUT_MS = 20 * 60_000;
const DONE = new Set<ChatMessage["status"]>(["done", "failed", "stopped"]);

type Snapshot = { room: ChatRoom; messages: ChatMessage[]; tasks: TaskListItem[] };

export const chatMessageIdOf = (inboundId: string) => `im-${createHash("sha256").update(inboundId).digest("hex").slice(0, 24)}`;

export class RoomRelay {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(private readonly deps: { appId: string; ash: AshClient; commands: CommandRunner }) {}

  start(): void {
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 这个人的助手房间；没有（或被网页删了）就照他最近用过的助手配置新建一间「飞书」。 */
  async assistantRoom(ctx: InboundContext): Promise<string | { error: string }> {
    const { principal, binding } = ctx;
    if (binding.assistantRoomId) {
      const existing = await this.deps.ash.get(principal, `/api/chats/${encodeURIComponent(binding.assistantRoomId)}`);
      if (existing.ok) return binding.assistantRoomId;
    }
    const rooms = await this.deps.ash.get<ChatRoom[]>(principal, "/api/chats?kind=assistant");
    const template = rooms.ok && Array.isArray(rooms.data)
      ? [...rooms.data].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).find((room) => room.members[0])
      : undefined;
    if (!template) return { error: "还没配置过 ash 助手：先在 ash 网页里打开一次助手、选好智能体，之后飞书里就能直接聊。" };
    const created = await this.deps.ash.post<ChatRoom>(principal, "/api/chats", {
      kind: "assistant", projectId: "", name: "飞书", members: [template.members[0]],
    });
    if (!created.ok) return { error: `没能建助手房间：${created.error}` };
    await updateBinding(principal, { assistantRoomId: created.data.id });
    binding.assistantRoomId = created.data.id;
    return created.data.id;
  }

  /** 群里这个人的那间项目群聊房间（多人模式下群聊房间是创建者私有的，所以一人一间）。 */
  async groupRoom(ctx: InboundContext, group: GroupRow): Promise<{ roomId: string; mention: string | null } | { error: string }> {
    const userKey = ctx.binding.userId ?? "";
    const known = await groupRoomOf(this.deps.appId, group.chatId, userKey);
    if (known) {
      const existing = await this.deps.ash.get<Snapshot>(ctx.principal, `/api/chats/${encodeURIComponent(known)}`);
      if (existing.ok) return { roomId: known, mention: existing.data.room?.members?.[0]?.name ?? null };
    }
    // 成员照这个人最近一间助手房间的智能体来：群聊里 @ 机器人，就是让它来答。
    const rooms = await this.deps.ash.get<ChatRoom[]>(ctx.principal, "/api/chats?kind=assistant");
    const template = rooms.ok && Array.isArray(rooms.data)
      ? [...rooms.data].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).find((room) => room.members[0])
      : undefined;
    if (!template) return { error: "还没配置过 ash 助手：先在 ash 网页里打开一次助手、选好智能体。" };
    const created = await this.deps.ash.post<ChatRoom>(ctx.principal, "/api/chats", {
      kind: "chat", projectId: group.projectId, name: scrubTitle(`飞书群 ${group.name ?? ""}`.trim(), 60), members: [template.members[0]],
    });
    if (!created.ok) return { error: `没能建群聊房间：${created.error}` };
    await setGroupRoom(this.deps.appId, group.chatId, userKey, created.data.id);
    return { roomId: created.data.id, mention: template.members[0]!.name };
  }

  /**
   * 把一句话投进房间。群聊房间里要 @ 成员才会有人答：自动在前面补上 @成员名。
   * 返回 false = 投递失败（已回过一句说明）。
   */
  async post(ctx: InboundContext, inboundId: string, roomId: string, text: string, paths: string[], mentionName: string | null): Promise<boolean> {
    const messageId = chatMessageIdOf(inboundId);
    const body = mentionName ? `@${mentionName} ${text}` : text;
    const projectId = ctx.chatType === "p2p" && ctx.binding.projectId ? { projectId: ctx.binding.projectId } : {};
    const sent = await this.deps.ash.post(ctx.principal, `/api/chats/${encodeURIComponent(roomId)}/messages`, {
      id: messageId, body, ...(paths.length ? { attachments: paths } : {}), ...projectId,
    });
    if (!sent.ok) {
      await this.mark(inboundId, "failed", sent.error);
      await this.deps.commands.say(ctx, `没能送进 ash：${sent.error}`);
      return false;
    }
    await db.update(imInbound).set({ state: "sent", roomId, detail: messageId, updatedAt: now() }).where(eq(imInbound.id, inboundId));
    return true;
  }

  private async mark(inboundId: string, state: string, detail: string | null): Promise<void> {
    await db.update(imInbound).set({ state, ...(detail !== null ? { detail } : {}), updatedAt: now() }).where(eq(imInbound.id, inboundId));
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const waiting = await db.select().from(imInbound).where(and(
        eq(imInbound.appId, this.deps.appId), inArray(imInbound.kind, ["assistant", "group"]), eq(imInbound.state, "sent"),
      ));
      for (const row of waiting) await this.check(row);
    } catch (error) {
      console.error("[ash] 飞书聊天回复轮询出错:", error);
    } finally {
      this.polling = false;
    }
  }

  private async check(row: typeof imInbound.$inferSelect): Promise<void> {
    if (!row.roomId || !row.openId || !row.detail || !row.chatId) return;
    const principal: ImPrincipal = { channel: CHANNEL, appId: this.deps.appId, openId: row.openId };
    const dest: Destination = row.chatType === "p2p"
      ? { receiveType: "open_id", receiveId: row.openId, recipientOpenId: row.openId }
      : { receiveType: "chat_id", receiveId: row.chatId, recipientOpenId: null };
    const feishuMessageId = row.id.replace(/^msg:/, "");
    const reply = (text: string) => this.deps.commands.say({ messageId: feishuMessageId, dest }, text, `relay:${row.id}`);
    const snapshot = await this.deps.ash.get<Snapshot>(principal, `/api/chats/${encodeURIComponent(row.roomId)}`);
    if (!snapshot.ok) {
      await this.mark(row.id, "failed", snapshot.error);
      return reply(`没拿到回复：${snapshot.error}`);
    }
    const answers = snapshot.data.messages.filter((message) => message.role === "agent" && message.replyTo === row.detail);
    const timedOut = Date.parse(row.updatedAt) + REPLY_TIMEOUT_MS < Date.now();
    if (!answers.length) {
      // 没有任何成员被点到（群聊里没 @ 到人）就不会有回复。
      if (timedOut || snapshot.data.messages.some((message) => message.id === row.detail && !message.mentions.length)) {
        await this.mark(row.id, "replied", null);
        if (timedOut) await reply("等了 20 分钟没等到回复，去 ash 里看看吧。");
      }
      return;
    }
    if (!answers.every((message) => DONE.has(message.status)) && !timedOut) return;
    const base = (await readOptions()).publicBaseUrl;
    const titleOf = new Map(snapshot.data.tasks.map((task) => [task.id, task] as const));
    const lines: string[] = [];
    for (const message of answers) {
      lines.push(scrubText(message.body, 3000) || (message.status === "done" ? "（空回复）" : "（回复中断）"));
      const linked = [...(message.taskId ? [message.taskId] : []), ...(message.assistant?.matches.map((match) => match.taskId) ?? [])];
      for (const taskId of [...new Set(linked)].slice(0, 5)) {
        const task = titleOf.get(taskId);
        if (!task) continue;
        const link = taskLink(base, { task: task as never });
        lines.push(`· ${scrubTitle(task.title, 50)}${message.taskId === taskId ? "（新建）" : ""}${link ? ` ${link}` : ""}`);
      }
    }
    await this.mark(row.id, "replied", null);
    await reply(lines.join("\n"));
  }
}

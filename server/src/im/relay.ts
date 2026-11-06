// 飞书里说的话进 ash 的聊天房间（单聊 → 助手房间，群 @ → 项目群聊房间），房间里的回复再
// 发回飞书。
//
// chat 没有「回复完成」事件，只能轮询房间快照：每 2 秒看一眼还在等回复的那几条（没有在等的
// 就不看）。投进房间的消息 id 由飞书消息 id 派生、正文与附件路径记在 im_inbound 上，所以
// 重启后重投也是同一条（chat 按 id + 正文判重）。
//
// 智能体回复对上用户那条消息靠 chat_messages.reply_to（同一事务里插入的那条回复）。
//
// 房间里的回复带着 ash 里的东西：投进房间那一刻按房间盖下授权来源（scope.ts room），记在 im_inbound 上，
// 回复发回飞书时出口按它现核（房间还在、还归他、群还绑着那个项目）。投不进去、拿不到回复、等超时这几句
// 说明不带房间里的东西，按他自己这次操作的结局（reply）发 —— 房间没了正是它们要说的事。
import { createHash } from "node:crypto";
import type { TaskListItem } from "@ash/shared";
import type { ChatMessage, ChatRoom } from "@ash/shared/chat";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { imInbound } from "../db/schema-im.js";
import { now } from "../util.js";
import type { ImPrincipal } from "../auth/im-actor.js";
import { deleteChatRoom } from "../chat/lifecycle.js";
import type { AshClient } from "./ash-client.js";
import { bindingOf, CHANNEL, claimAssistantRoom } from "./binding.js";
import { taskLink } from "./cards.js";
import type { CommandRunner, InboundContext } from "./commands.js";
import { claimGroupRoom, groupOf, groupRoomOf, type GroupRow } from "./groups.js";
import { readOptions } from "./meta.js";
import type { Destination } from "./outbox.js";
import { scopeFor, type OutboxScope } from "./scope.js";
import { scrubText, scrubTitle } from "./scrub.js";

const POLL_MS = 2_000;
const REPLY_TIMEOUT_MS = 20 * 60_000;
const DONE = new Set<ChatMessage["status"]>(["done", "failed", "stopped"]);

type Snapshot = { room: ChatRoom; messages: ChatMessage[]; tasks: TaskListItem[] };

/** 刚建的房间没领到（别人先领了，或者绑定刚换过）：删掉它，免得网页上多一间空房间。返回该用的那一间。 */
function settleClaim(created: string, claimed: string | null): string | null {
  if (claimed !== created) {
    void deleteChatRoom(created).catch((error) => console.warn(`[ash] 飞书多建的房间 ${created} 没删掉:`, (error as Error).message));
  }
  return claimed;
}

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

  /**
   * 这个人的助手房间；没有（或被网页删了）就照他最近用过的助手配置新建一间「飞书」。
   * 同一个人连发几句是并发处理的（channel.ts），可能同时发现没有房间、各建一间：建好之后按「映射还是我读到
   * 的那一间」领取（binding.ts claimAssistantRoom），只有一间领得到，其余的用胜出的那间、删掉自己建的。
   */
  async assistantRoom(ctx: InboundContext): Promise<string | { error: string }> {
    const { principal, binding } = ctx;
    // 入口读的那份绑定可能已经过时（同时到的另一句刚建了房间）。
    const fresh = await bindingOf(this.deps.appId, principal.openId);
    const known = (fresh ? fresh.assistantRoomId : binding.assistantRoomId) ?? null;
    if (known) {
      const existing = await this.deps.ash.get(principal, `/api/chats/${encodeURIComponent(known)}`);
      if (existing.ok) return (binding.assistantRoomId = known);
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
    const claimed = settleClaim(created.data.id, await claimAssistantRoom(principal, binding.boundAt, known, created.data.id));
    if (!claimed) return { error: "你刚换过绑定：请再发一次。" };
    return (binding.assistantRoomId = claimed);
  }

  /**
   * 群里这个人的那间项目群聊房间（多人模式下群聊房间是创建者私有的，所以一人一间）。并发与领取同
   * assistantRoom，领取还要群的绑定没换过：出口只放行映射上的那一间（scope.ts），各用各建的那间的话，
   * 没记进映射的那间的回复永远发不出去。
   */
  async groupRoom(ctx: InboundContext, group: GroupRow): Promise<{ roomId: string; mention: string | null } | { error: string }> {
    const userKey = ctx.binding.userId ?? "";
    const known = await groupRoomOf(this.deps.appId, group.chatId, userKey);
    if (known) {
      const existing = await this.deps.ash.get<Snapshot>(ctx.principal, `/api/chats/${encodeURIComponent(known)}`);
      // 房间得还在这个群绑的项目里：不在了（群换过项目）就另建，话不能投进别的项目。
      if (existing.ok && (existing.data.room?.projectId ?? "") === group.projectId) {
        return { roomId: known, mention: existing.data.room?.members?.[0]?.name ?? null };
      }
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
    const claimed = settleClaim(created.data.id, await claimGroupRoom(group, userKey, known, created.data.id));
    if (!claimed) return { error: "这个群刚换过绑定：请再发一次。" };
    return { roomId: claimed, mention: template.members[0]!.name };
  }

  /**
   * 把一句话投进房间。群聊房间里要 @ 成员才会有人答：自动在前面补上 @成员名。
   * 返回 false = 投递失败（已回过一句说明）。
   */
  async post(
    ctx: InboundContext, inboundId: string, roomId: string, text: string, paths: string[], mentionName: string | null, projectId: string | null,
  ): Promise<boolean> {
    const messageId = chatMessageIdOf(inboundId);
    const scope = await this.deps.commands.scoped(ctx, { kind: "room", roomId, projectId });
    const body = mentionName ? `@${mentionName} ${text}` : text;
    const current = ctx.chatType === "p2p" && ctx.binding.projectId ? { projectId: ctx.binding.projectId } : {};
    const sent = await this.deps.ash.post(ctx.principal, `/api/chats/${encodeURIComponent(roomId)}/messages`, {
      id: messageId, body, ...(paths.length ? { attachments: paths } : {}), ...current,
    });
    if (!sent.ok) {
      await this.deps.commands.say(ctx, `没能送进 ash：${scrubText(sent.error, 300)}`, await this.deps.commands.answered(ctx, { projectId }));
      await this.mark(inboundId, "failed", sent.error);
      return false;
    }
    await db.update(imInbound).set({ state: "sent", roomId, detail: messageId, scope: JSON.stringify(scope), updatedAt: now() })
      .where(eq(imInbound.id, inboundId));
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
    const scope = await this.scopeOf(row, dest);
    const reply = async (text: string, notice = false) => this.deps.commands.say({ messageId: feishuMessageId, dest }, text,
      notice ? await this.deps.commands.answered({ dest }, { projectId: scope.kind === "room" ? scope.projectId : null }) : scope,
      { subject: `relay:${row.id}` });
    const snapshot = await this.deps.ash.get<Snapshot>(principal, `/api/chats/${encodeURIComponent(row.roomId)}`);
    // 先把回复入队、再记结局：中间退出，下一圈还会再看这一行，同一个 subject 的回复入不了第二次。
    if (!snapshot.ok) {
      await reply(`没拿到回复：${scrubText(snapshot.error, 300)}`, true);
      return this.mark(row.id, "failed", snapshot.error);
    }
    const answers = snapshot.data.messages.filter((message) => message.role === "agent" && message.replyTo === row.detail);
    const timedOut = Date.parse(row.updatedAt) + REPLY_TIMEOUT_MS < Date.now();
    if (!answers.length) {
      // 没有任何成员被点到（群聊里没 @ 到人）就不会有回复。
      if (timedOut || snapshot.data.messages.some((message) => message.id === row.detail && !message.mentions.length)) {
        if (timedOut) await reply("等了 20 分钟没等到回复，去 ash 里看看吧。", true);
        await this.mark(row.id, "replied", null);
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
    await reply(lines.join("\n"));
    await this.mark(row.id, "replied", null);
  }

  /** 投进房间时盖下的来源。旧版本投的没有：按此刻的绑定补一份（群里的房间按群此刻绑的项目）。 */
  private async scopeOf(row: typeof imInbound.$inferSelect, dest: Destination): Promise<OutboxScope> {
    if (row.scope) return JSON.parse(row.scope) as OutboxScope;
    const group = row.chatType === "p2p" ? null : await groupOf(this.deps.appId, row.chatId!);
    return scopeFor(this.deps.appId, dest, { kind: "room", roomId: row.roomId!, projectId: group?.projectId ?? null },
      row.chatType === "p2p" ? null : await bindingOf(this.deps.appId, row.openId!));
  }
}

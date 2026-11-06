// 飞书发来的一条消息该去哪：
//   ① 带绑定码 → 认领（binding.ts / groups.ts），回一句「回网页确认」；
//   ② 发消息的人没绑定 → 单聊回一句怎么绑（一天最多一次），群里不理；
//   ③ 斜杠命令 → commands.ts；
//   ④ 回复了某张任务卡 → 这张卡是提问就答复，否则当成给任务发消息；
//   ⑤ 其余：单聊进助手房间、群里 @ 进项目群聊房间（relay.ts）。
// 群消息只处理 @ 了机器人的（开放平台只推这类，这里再判一次）。
import type { QuestionItem } from "@ash/shared";
import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { imInbound, imOutbox } from "../db/schema-im.js";
import { now } from "../util.js";
import { imActorFor, type ImPrincipal } from "../auth/im-actor.js";
import { viewsOf } from "./attention.js";
import { taskPath, type AshClient } from "./ash-client.js";
import { saveAttachments } from "./attachments.js";
import { bindingOf, CHANNEL, claimCode, extractCode, updateBinding } from "./binding.js";
import { parseCommand, type CommandRunner, type InboundContext } from "./commands.js";
import type { FeishuApi } from "./feishu/api.js";
import { parseMessage, type FeishuMention } from "./feishu/message.js";
import { groupOf } from "./groups.js";
import type { Destination } from "./outbox.js";
import type { Reconciler } from "./reconcile.js";
import type { RoomRelay } from "./relay.js";

const HINT_EVERY_MS = 24 * 3600_000;

export interface MessageEvent {
  sender?: { sender_id?: { open_id?: string }; sender_type?: string };
  message?: {
    message_id?: string; root_id?: string; parent_id?: string; chat_id?: string; chat_type?: string;
    message_type?: string; content?: string; mentions?: { key?: string; id?: { open_id?: string } }[];
  };
}

/** 「1. xxx\n2. yyy」按题号拆成多题答复；拆不齐就返回 null（整段当一条答复）。 */
export function splitNumberedAnswers(text: string, count: number): string[] | null {
  if (count <= 1) return null;
  const answers: string[] = Array.from({ length: count }, () => "");
  let current = -1;
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s*[.、．)）:：]\s*(.*)$/.exec(line);
    if (match && Number(match[1]) >= 1 && Number(match[1]) <= count) {
      current = Number(match[1]) - 1;
      answers[current] = match[2]!;
    } else if (current >= 0) {
      answers[current] += `\n${line}`;
    } else if (line.trim()) {
      return null;
    }
  }
  return answers.some((answer) => answer.trim()) ? answers.map((answer) => answer.trim()) : null;
}

export class InboundRouter {
  constructor(private readonly deps: {
    appId: string;
    api: FeishuApi;
    ash: AshClient;
    commands: CommandRunner;
    relay: RoomRelay;
    reconciler: Reconciler;
    botOpenId: () => string | null;
  }) {}

  private async record(id: string, patch: Partial<typeof imInbound.$inferInsert>): Promise<void> {
    await db.update(imInbound).set({ ...patch, updatedAt: now() }).where(eq(imInbound.id, id));
  }

  async handle(event: MessageEvent): Promise<void> {
    const message = event.message;
    const openId = event.sender?.sender_id?.open_id;
    if (event.sender?.sender_type !== "user" || !message?.message_id || !message.chat_id || !openId) return;
    const chatType = message.chat_type === "p2p" ? "p2p" : "group";
    const inboundId = `msg:${message.message_id}`;
    const fresh = await db.insert(imInbound).values({
      id: inboundId, channel: CHANNEL, appId: this.deps.appId, openId, chatId: message.chat_id, chatType,
      kind: "received", state: "received", createdAt: now(), updatedAt: now(),
    }).onConflictDoNothing().returning({ id: imInbound.id });
    if (!fresh.length) return;
    try {
      await this.route(inboundId, message as Required<MessageEvent>["message"] & { message_id: string; chat_id: string }, openId, chatType);
    } catch (error) {
      console.error("[ash] 飞书消息处理出错:", error);
      await this.record(inboundId, { state: "failed", detail: String((error as Error).message).slice(0, 500) });
    }
  }

  private async route(
    inboundId: string,
    message: NonNullable<MessageEvent["message"]> & { message_id: string; chat_id: string },
    openId: string,
    chatType: "p2p" | "group",
  ): Promise<void> {
    const mentions: FeishuMention[] = (message.mentions ?? []).map((m) => ({ key: m.key ?? "", openId: m.id?.open_id ?? null }));
    if (chatType === "group") {
      const bot = this.deps.botOpenId();
      const mentioned = bot ? mentions.some((m) => m.openId === bot) : mentions.length > 0;
      if (!mentioned) return this.record(inboundId, { kind: "ignored", state: "done" });
    }
    const parsed = parseMessage(message.message_type ?? "", message.content ?? "", mentions);
    const dest: Destination = chatType === "p2p"
      ? { receiveType: "open_id", receiveId: openId, recipientOpenId: openId }
      : { receiveType: "chat_id", receiveId: message.chat_id, recipientOpenId: null };
    const say = (text: string) => this.deps.commands.say({ messageId: message.message_id, dest }, text);
    const principal: ImPrincipal = { channel: CHANNEL, appId: this.deps.appId, openId };

    const code = extractCode(parsed.text);
    if (code) {
      const name = chatType === "group" ? await this.deps.api.chatInfo(message.chat_id).then((r) => (r.ok ? r.data.name : null)) : null;
      const claimed = await claimCode(code, { appId: this.deps.appId, openId, chatId: message.chat_id, chatType, name });
      await this.record(inboundId, { kind: "bind", state: "done", detail: claimed.kind });
      return say({
        claimed: claimed.kind === "claimed" && claimed.purpose === "group"
          ? "收到群绑定码。回到 ash 网页 设置 → 飞书 → 群，点「确认」就绑好了。"
          : "收到绑定码。回到 ash 网页 设置 → 飞书，核对后点「确认」就绑好了。",
        unknown: "这串绑定码不对，或已经用过/作废了：在 ash 网页上重新生成一个。",
        expired: "这串绑定码已过期（10 分钟有效）：在 ash 网页上重新生成一个。",
        wrong_place: chatType === "group" ? "这是个人绑定码，请在和我的单聊里发。" : "这是群绑定码，请在要绑定的群里 @ 我发出来。",
        taken: "这串绑定码已经被别人认领了：在 ash 网页上拒绝那次认领，再重新生成。",
        not_owner: "群绑定码要由生成它的那个人自己在群里发（先在单聊里绑好你自己的飞书）。",
      }[claimed.kind]);
    }

    const binding = await bindingOf(this.deps.appId, openId);
    const actor = binding ? await imActorFor(principal) : null;
    if (!binding || !actor) {
      await this.record(inboundId, { kind: "denied", state: "done" });
      if (chatType !== "p2p") return;
      const recent = await db.select({ id: imInbound.id }).from(imInbound).where(and(
        eq(imInbound.openId, openId), eq(imInbound.kind, "denied"),
        gt(imInbound.createdAt, new Date(Date.now() - HINT_EVERY_MS).toISOString()),
      )).limit(2);
      if (recent.length > 1) return;
      return say(binding
        ? "你的 ash 账号已停用或绑定已失效：请在 ash 网页 设置 → 飞书 里重新绑定。"
        : "你还没绑定 ash：在 ash 网页 设置 → 飞书 → 绑定 里生成绑定码，把它发给我。");
    }
    if (chatType === "p2p" && binding.chatId !== message.chat_id) await updateBinding(principal, { chatId: message.chat_id });
    if (!parsed.supported) {
      await this.record(inboundId, { kind: "ignored", state: "done" });
      return say("我只认文字、图片和文件。");
    }

    const parents = [message.parent_id, message.root_id].filter((id): id is string => !!id);
    const card = parents.length
      ? (await db.select().from(imOutbox).where(and(eq(imOutbox.appId, this.deps.appId), inArray(imOutbox.messageId, parents))))
        .find((row) => row.taskId) ?? null
      : null;
    const ctx: InboundContext = { messageId: message.message_id, chatId: message.chat_id, chatType, principal, binding, dest, card };

    let text = parsed.text;
    const command = parseCommand(text);
    if (command && command.name !== "answer" && command.name !== "reply") {
      await this.record(inboundId, { kind: "command", state: "done", detail: command.name });
      return this.deps.commands.run(ctx, command.name, command.rest);
    }
    if (command) text = command.rest;

    // 附件转存一次，路径记下来（重试时复用同一份）。
    const saved = await saveAttachments(this.deps.api, this.deps.ash, principal, message.message_id, parsed.attachments);
    await this.record(inboundId, { body: text, attachments: JSON.stringify(saved.paths) });
    if (saved.failures.length) await say(`有附件没收下：\n${saved.failures.join("\n")}`);
    if (!text.trim() && !saved.paths.length) return this.record(inboundId, { kind: "ignored", state: "done" });

    if (card?.taskId) return this.toTask(inboundId, ctx, card.taskId, text, saved.paths);
    if (chatType === "p2p") {
      const room = await this.deps.relay.assistantRoom(ctx);
      if (typeof room !== "string") { await this.record(inboundId, { kind: "assistant", state: "failed", detail: room.error }); return say(room.error); }
      await this.record(inboundId, { kind: "assistant" });
      if (await this.deps.relay.post(ctx, inboundId, room, text, saved.paths, null)) void this.react(message.message_id);
      return;
    }
    const group = await groupOf(this.deps.appId, message.chat_id);
    if (!group) {
      await this.record(inboundId, { kind: "group", state: "done", detail: "unbound" });
      return say("这个群还没绑定 ash 项目：在 ash 网页 设置 → 飞书 → 群 里绑定。回复任务卡片不受影响。");
    }
    const room = await this.deps.relay.groupRoom(ctx, group);
    if ("error" in room) { await this.record(inboundId, { kind: "group", state: "failed", detail: room.error }); return say(room.error); }
    await this.record(inboundId, { kind: "group" });
    if (await this.deps.relay.post(ctx, inboundId, room.roomId, text, saved.paths, room.mention)) void this.react(message.message_id);
  }

  /** 回复任务卡：此刻在等答复就答复（提问回合结束前答复会被拒，那就当普通消息），否则发给任务。 */
  private async toTask(inboundId: string, ctx: InboundContext, taskId: string, text: string, paths: string[]): Promise<void> {
    const view = (await viewsOf([taskId])).get(taskId) ?? null;
    const say = (line: string) => this.deps.commands.say(ctx, line, `r:${ctx.messageId}`, taskId);
    if (!view) { await this.record(inboundId, { kind: "reply", taskId, state: "failed" }); return say("这个任务已经被删除了。"); }
    if (view.turn?.kind === "question" && !paths.length) {
      const items: QuestionItem[] = view.turn.items;
      const split = splitNumberedAnswers(text, items.length);
      // 多题没按题号写：整段作为一条答复（与网页上「直接写一段话」同一条路）。
      const body = split ? { answers: split } : { answer: text };
      const result = await this.deps.ash.post(ctx.principal, taskPath(taskId, "/answer"), { ...body, questionKey: view.turn.questionKey });
      await this.record(inboundId, { kind: "answer", taskId, state: result.ok ? "done" : "failed", detail: result.ok ? null : result.error });
      if (!result.ok) return say(`没答上：${result.error}`);
      this.deps.reconciler.mark(taskId);
      return void this.react(ctx.messageId);
    }
    const result = await this.deps.ash.post(ctx.principal, taskPath(taskId, "/reply"), { text, ...(paths.length ? { attachments: paths } : {}) });
    await this.record(inboundId, { kind: "reply", taskId, state: result.ok ? "done" : "failed", detail: result.ok ? null : result.error });
    if (!result.ok) return say(`没发进任务：${result.error}`);
    this.deps.reconciler.mark(taskId);
    void this.react(ctx.messageId);
  }

  /** 「收到了」：在用户那条消息上点个表情（额度吃紧时第一个省掉）。 */
  private async react(messageId: string): Promise<void> {
    await this.deps.api.react(messageId, "OK").catch(() => undefined);
  }
}

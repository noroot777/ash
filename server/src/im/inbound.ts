// 飞书发来的一条消息该去哪：
//   ① 带绑定码 → 认领（binding.ts / groups.ts），回一句「回网页确认」；
//   ② 发消息的人没绑定 → 单聊回一句怎么绑（一天最多一次），群里不理；
//   ③ 斜杠命令 → commands.ts；
//   ④ 回复了某张任务卡 → 这张卡是眼下这道提问就答复；以 /reply 开头的才当成给任务发消息；
//   ⑤ 其余：单聊进助手房间、群里 @ 进项目群聊房间（relay.ts）。
// 群消息只处理 @ 了机器人的（开放平台只推这类，这里再判一次）。
//
// 收和办分两步：accept 先把消息原文落库（长连接等它落库才回执），process 再去办。一行的进度：
//   received    收下了、还没碰任何收不回来的事 —— 重启后照原文重办一遍（绑定认领、命令回执、投进
//               聊天房间都按消息 id 幂等；附件转存过的沿用记下的路径）；
//   dispatching 正要答复 / 给任务发消息 / 重试 —— 这几下不幂等，重启后不重办，照实告诉用户「不确定
//               送到没有」；
//   done / failed，聊天房间另有 sent → replied（relay.ts）。
//
// 回复卡片答复提问，只认那张卡自己问的那一次（卡片代次 = 那一次提问的身份，task-wait-ownership.ts
// questionOccurrenceOf；外加发卡时记下的 questionKey），带不带附件都走答复接口，由它在写入那一刻核：
// 任务眼下在问的可能已经是另一道、或者同一道题又问了一次，不能拿此刻的提问去替一条旧回复补上身份。
//
// 直接回复不是提问的卡（失败卡、待验收卡、通知……）不发给任务：送到之前任务可能刚问了一道新题，
// 发给任务的消息会顶掉它，等于替一道没看过的题作了答（用户 2026-11-06 选定：要捎话就明说 /reply）。
//
// 回执各按内容记授权来源（scope.ts）：静态的提示是 system，带着任务接口报错的是 task。
import type { QuestionItem } from "@ash/shared";
import { and, desc, eq, gt, inArray, like } from "drizzle-orm";
import { db } from "../db/index.js";
import { imActions, imInbound, imOutbox } from "../db/schema-im.js";
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
import type { Destination, OutboxRow } from "./outbox.js";
import { TURN_KINDS, type Reconciler } from "./reconcile.js";
import type { RoomRelay } from "./relay.js";
import { SYSTEM_SCOPE } from "./scope.js";
import { scrubText } from "./scrub.js";

const HINT_EVERY_MS = 24 * 3600_000;
/** 重启时比这更早收下的消息不再补办（补办一条一小时前的话多半已经不合时宜），只告诉用户重发。 */
const RECOVER_WITHIN_MS = 3600_000;

type InboundRow = typeof imInbound.$inferSelect;
/** 本进程正在办的消息：通道重启后新的那一份接管时跳过它们（旧的那份还在办）。 */
const inFlight = new Set<string>();
type Message = NonNullable<MessageEvent["message"]> & { message_id: string; chat_id: string };

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

  /** 收下并办完（测试与不经长连接的调用方用）。 */
  async handle(event: MessageEvent): Promise<void> {
    const inboundId = await this.accept(event);
    if (inboundId) await this.process(inboundId);
  }

  /** 收下一条消息：连原文一起落库。返回 null = 重复投递，或者不是要处理的消息。 */
  async accept(event: MessageEvent): Promise<string | null> {
    const message = event.message;
    const openId = event.sender?.sender_id?.open_id;
    if (event.sender?.sender_type !== "user" || !message?.message_id || !message.chat_id || !openId) return null;
    const inboundId = `msg:${message.message_id}`;
    const fresh = await db.insert(imInbound).values({
      id: inboundId, channel: CHANNEL, appId: this.deps.appId, openId, chatId: message.chat_id,
      chatType: message.chat_type === "p2p" ? "p2p" : "group",
      kind: "received", state: "received", payload: JSON.stringify(message), createdAt: now(), updatedAt: now(),
    }).onConflictDoNothing().returning({ id: imInbound.id });
    return fresh.length ? inboundId : null;
  }

  /** 办一条收下了、还没办过的消息。 */
  async process(inboundId: string): Promise<void> {
    if (inFlight.has(inboundId)) return;
    inFlight.add(inboundId);
    try {
      const row = (await db.select().from(imInbound).where(eq(imInbound.id, inboundId))).at(0);
      if (!row || row.state !== "received" || !row.payload || !row.openId) return;
      await this.route(row, JSON.parse(row.payload) as Message, row.openId, row.chatType === "p2p" ? "p2p" : "group");
      // 一路上没记结局的（命令、认领、提示）到这里才算办完；回执在这之前已经入队了。
      await this.finish(inboundId, { state: "done" });
    } catch (error) {
      console.error("[ash] 飞书消息处理出错:", error);
      await this.explain(inboundId, "error").catch((failure) => console.error("[ash] 飞书消息出错后回话失败:", failure));
      await this.finish(inboundId, { state: "failed", detail: String((error as Error).message).slice(0, 500) });
    } finally {
      inFlight.delete(inboundId);
    }
  }

  /** 只收尾还没有结局的那一行（聊天房间的 sent / replied 不动）。 */
  private async finish(inboundId: string, patch: Partial<typeof imInbound.$inferInsert>): Promise<void> {
    await db.update(imInbound).set({ ...patch, updatedAt: now() })
      .where(and(eq(imInbound.id, inboundId), inArray(imInbound.state, ["received", "dispatching"])));
  }

  /** 上一次运行收下、没办完的消息（启动时、对账之前调）。一条出错不挡后面的。 */
  async recover(): Promise<number> {
    const rows = await db.select().from(imInbound).where(and(
      eq(imInbound.appId, this.deps.appId), like(imInbound.id, "msg:%"), inArray(imInbound.state, ["received", "dispatching"]),
    ));
    for (const row of rows) {
      if (inFlight.has(row.id)) continue;
      try {
        const fresh = Date.parse(row.createdAt) > Date.now() - RECOVER_WITHIN_MS;
        if (row.state === "received" && fresh && row.payload) { await this.process(row.id); continue; }
        await this.explain(row.id, "recover");
        await this.finish(row.id, { state: "failed", detail: row.state === "dispatching" ? "interrupted" : "expired" });
      } catch (error) {
        console.error(`[ash] 飞书消息 ${row.id} 补办出错:`, error);
      }
    }
    return rows.length;
  }

  /**
   * 没办完的消息照实回一句：正要做不幂等的那一步（dispatching）的说不确定送到没有，其余的请他再发。
   * why 进 subject，同一条消息的同一种说明只入队一次。
   */
  private async explain(inboundId: string, why: "recover" | "error"): Promise<void> {
    const row = (await db.select().from(imInbound).where(eq(imInbound.id, inboundId))).at(0);
    if (!row?.openId || !row.chatId || !["received", "dispatching"].includes(row.state)) return;
    const dest: Destination = row.chatType === "p2p"
      ? { receiveType: "open_id", receiveId: row.openId, recipientOpenId: row.openId }
      : { receiveType: "chat_id", receiveId: row.chatId, recipientOpenId: null };
    const text = row.state === "dispatching"
      ? `处理这条消息时${why === "recover" ? " ash 正好重启" : "出了错"}，不确定送到没有：请在 ash 里看一眼，没到的话再发一次。`
      : why === "recover" ? "ash 停机期间没来得及处理这条消息，请再发一次。" : "处理这条消息时出了错：请在 ash 里看一眼，没办成的话再发一次。";
    const messageId = row.id.replace(/^msg:/, "");
    await this.deps.commands.say({ messageId, dest }, text, SYSTEM_SCOPE, { subject: `r:${messageId}:${why}`, taskId: row.taskId });
  }

  private async route(row: InboundRow, message: Message, openId: string, chatType: "p2p" | "group"): Promise<void> {
    const inboundId = row.id;
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
    // 这一段里的回话都是静态提示（不含 ash 数据）；带着房间、项目内容的由各自的地方另记来源。
    const say = (text: string) => this.deps.commands.say({ messageId: message.message_id, dest }, text, SYSTEM_SCOPE);
    const principal: ImPrincipal = { channel: CHANNEL, appId: this.deps.appId, openId };

    const code = extractCode(parsed.text);
    if (code) {
      const name = chatType === "group" ? await this.deps.api.chatInfo(message.chat_id).then((r) => (r.ok ? r.data.name : null)) : null;
      const claimed = await claimCode(code, { appId: this.deps.appId, openId, chatId: message.chat_id, chatType, name });
      await this.record(inboundId, { kind: "bind", detail: claimed.kind });
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
      await this.record(inboundId, { kind: "denied" });
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
      await this.record(inboundId, { kind: "ignored" });
      return say("我只认文字、图片和文件。");
    }

    const ctx: InboundContext = {
      messageId: message.message_id, chatId: message.chat_id, chatType, principal, binding, dest,
      card: await this.cardOf(message), commit: (taskId) => this.record(inboundId, { taskId, state: "dispatching" }),
    };

    let text = parsed.text;
    const command = parseCommand(text);
    if (command && command.name !== "answer" && command.name !== "reply") {
      await this.record(inboundId, { kind: "command", detail: command.name });
      return this.deps.commands.run(ctx, command.name, command.rest);
    }
    if (command) text = command.rest;

    // 附件转存一次，路径记下来（重办时沿用同一份，不再下载、不再转存）。
    const saved = row.attachments
      ? { paths: JSON.parse(row.attachments) as string[], failures: [] as string[] }
      : await saveAttachments(this.deps.api, this.deps.ash, principal, message.message_id, parsed.attachments);
    await this.record(inboundId, { body: text, attachments: JSON.stringify(saved.paths) });
    if (saved.failures.length) {
      // 列的是他自己刚发的附件和下载 / 转存的报错，不含 ash 里的数据。
      await this.deps.commands.say(ctx, `有附件没收下：\n${scrubText(saved.failures.join("\n"), 1500)}`, SYSTEM_SCOPE, { subject: `r:${message.message_id}:att` });
    }
    if (!text.trim() && !saved.paths.length) return this.record(inboundId, { kind: "ignored" });

    if (ctx.card?.taskId) return this.toTask(inboundId, ctx, ctx.card, command?.name ?? null, text, saved.paths);
    if (chatType === "p2p") {
      const room = await this.deps.relay.assistantRoom(ctx);
      if (typeof room !== "string") {
        await this.deps.commands.say(ctx, room.error, await this.deps.commands.answered(ctx, {}));
        return this.record(inboundId, { kind: "assistant", state: "failed", detail: room.error });
      }
      await this.record(inboundId, { kind: "assistant" });
      if (await this.deps.relay.post(ctx, inboundId, room, text, saved.paths, null, null)) void this.react(message.message_id);
      return;
    }
    const group = await groupOf(this.deps.appId, message.chat_id);
    if (!group) {
      await this.record(inboundId, { kind: "group", detail: "unbound" });
      return say("这个群还没绑定 ash 项目：在 ash 网页 设置 → 飞书 → 群 里绑定。回复任务卡片不受影响。");
    }
    const room = await this.deps.relay.groupRoom(ctx, group);
    if ("error" in room) {
      await this.deps.commands.say(ctx, room.error, await this.deps.commands.answered(ctx, { projectId: group.projectId }));
      return this.record(inboundId, { kind: "group", state: "failed", detail: room.error });
    }
    await this.record(inboundId, { kind: "group" });
    if (await this.deps.relay.post(ctx, inboundId, room.roomId, text, saved.paths, room.mention, group.projectId)) void this.react(message.message_id);
  }

  /**
   * 这条消息回复的是哪张任务卡：直接回复的那条优先，其次是话题的根。回的是机器人自己的文字回执
   * （「没答上：…」这类，挂着任务但不是卡）时认话题根上那张卡，都没有才退回那条回执。
   */
  private async cardOf(message: Message): Promise<OutboxRow | null> {
    const parents = [message.parent_id, message.root_id].filter((id): id is string => !!id);
    if (!parents.length) return null;
    const rows = (await db.select().from(imOutbox).where(and(eq(imOutbox.appId, this.deps.appId), inArray(imOutbox.messageId, parents))))
      .filter((row) => row.taskId);
    const ordered = parents.flatMap((id) => rows.filter((row) => row.messageId === id));
    return ordered.find((row) => (TURN_KINDS as readonly string[]).includes(row.kind)) ?? ordered.at(0) ?? null;
  }

  /**
   * 回复任务卡。任务在等答复、而且回的正是问这一次的那张卡 → 答复（附件随答复一起进那一轮，带着卡片
   * 代次与 questionKey，答复接口写入那一刻核）；回的是旧提问卡、或者不是提问卡 → 带不带附件都不收，
   * 告诉他怎么办。明说 /reply 的 → 当成给任务发一条消息（他自己知道是在给任务新的指示）。
   */
  private async toTask(
    inboundId: string, ctx: InboundContext, card: OutboxRow, intent: string | null, text: string, paths: string[],
  ): Promise<void> {
    const taskId = card.taskId!;
    const view = (await viewsOf([taskId])).get(taskId) ?? null;
    const say = (line: string) => this.deps.commands.say(ctx, line, SYSTEM_SCOPE, { taskId });
    /** 任务接口的报错：他自己这次操作的结局（scope.ts reply），只推标题的项目换成短句。 */
    const sayError = async (line: string) => this.deps.commands.say(ctx, line, await this.deps.commands.answered(ctx, { taskId }),
      { taskId, brief: "没办成，原因见 ash。" });
    // 先把回话入队再记结局：中间退出，重办时同一句回话入不了第二次（同 subject）。
    const refuse = async (detail: string, line: string) => {
      await say(line);
      return this.record(inboundId, { kind: "reply", taskId, state: "failed", detail });
    };
    if (!view) return refuse("deleted", "这个任务已经被删除了。");
    const turn = view.turn;
    const explicit = intent === "reply";
    const current = turn?.kind === "question" && card.kind === "question" && card.subject === turn.generation;
    if (!explicit && card.kind === "question" && !current) {
      return refuse("stale_question", turn?.kind === "question"
        ? "这张卡上的问题已经换了：请回复最新那张提问卡（发 /todo 能找到它）。只想给任务捎句话，用 /reply 开头。"
        : "这道题已经答过了。还想给任务捎句话，用 /reply 开头再发一次。");
    }
    if (!explicit && card.kind !== "question") {
      return refuse("not_question_card", turn?.kind === "question"
        ? "任务眼下在等一道提问，这张卡不是那道题：请回复那张提问卡（发 /todo 能找到它）。只想给任务捎句话，用 /reply 开头。"
        : "直接回复只用来答提问卡，这句话没发给任务。要给任务捎句话，回复时以 /reply 开头再发一次（附件一样能带）。");
    }
    if (!explicit && current) {
      const questionKey = await this.questionKeyOf(card);
      if (!questionKey) return refuse("no_question_key", "认不出这张卡问的是哪道题了：请在 ash 里答复。");
      const items: QuestionItem[] = turn.items;
      const split = text.trim() ? splitNumberedAnswers(text, items.length) : null;
      // 多题没按题号写：整段作为一条答复（与网页上「直接写一段话」同一条路）。只发了附件：答复写明见附件。
      const body = split ? { answers: split } : { answer: text.trim() || "（见附件）" };
      await this.record(inboundId, { kind: "answer", taskId, state: "dispatching" });
      const result = await this.deps.ash.post(ctx.principal, taskPath(taskId, "/answer"), {
        ...body, questionKey, questionOccurrence: card.subject, ...(paths.length ? { attachments: paths } : {}),
      });
      if (!result.ok) await sayError(`没答上：${scrubText(result.error, 300)}`);
      await this.record(inboundId, { state: result.ok ? "done" : "failed", detail: result.ok ? null : result.error });
      if (!result.ok) return;
      this.deps.reconciler.mark(taskId);
      return void this.react(ctx.messageId);
    }
    await this.record(inboundId, { kind: "reply", taskId, state: "dispatching" });
    const result = await this.deps.ash.post(ctx.principal, taskPath(taskId, "/reply"), { text, ...(paths.length ? { attachments: paths } : {}) });
    if (!result.ok) await sayError(`没发进任务：${scrubText(result.error, 300)}`);
    await this.record(inboundId, { state: result.ok ? "done" : "failed", detail: result.ok ? null : result.error });
    if (!result.ok) return;
    this.deps.reconciler.mark(taskId);
    void this.react(ctx.messageId);
  }

  /** 发这张提问卡时记下的 questionKey（信封 payload 里）。 */
  private async questionKeyOf(card: OutboxRow): Promise<string | null> {
    const envelope = (await db.select({ payload: imActions.payload }).from(imActions)
      .where(and(eq(imActions.outboxId, card.id), eq(imActions.action, "question")))
      .orderBy(desc(imActions.createdAt)).limit(1)).at(0);
    try {
      const key = (JSON.parse(envelope?.payload ?? "{}") as { questionKey?: unknown }).questionKey;
      return typeof key === "string" && key ? key : null;
    } catch {
      return null;
    }
  }

  /** 「收到了」：在用户那条消息上点个表情（额度吃紧时第一个省掉）。 */
  private async react(messageId: string): Promise<void> {
    await this.deps.api.react(messageId, "OK").catch(() => undefined);
  }
}

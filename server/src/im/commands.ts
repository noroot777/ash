// 飞书里的斜杠命令。全部以发命令那个人的身份执行（ash-client.ts），能做的事不超过他在网页上能做的。
//
// 会改东西、而且改了收不回来的（/new 建任务并开跑、/stop 停任务）先回一张确认卡，点「确定」
// 才执行 —— 手机上误触、输入法联想补全都很常见。确认卡 10 分钟有效。
import type { Project } from "@ash/shared";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { imOutbox } from "../db/schema-im.js";
import type { ImPrincipal } from "../auth/im-actor.js";
import { taskPath, type AshClient } from "./ash-client.js";
import { updateBinding, type BindingRow } from "./binding.js";
import { confirmCard, taskLink } from "./cards.js";
import { createEnvelope } from "./envelopes.js";
import { renderCard } from "./feishu/cards.js";
import { readOptions } from "./meta.js";
import type { Destination, OutboxRow } from "./outbox.js";
import type { Outcome } from "./actions.js";
import type { Reconciler } from "./reconcile.js";
import { scrubText, scrubTitle } from "./scrub.js";

export interface InboundContext {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  principal: ImPrincipal;
  binding: BindingRow;
  /** 回给这个人的去处：单聊按 open_id，群按 chat_id。 */
  dest: Destination;
  /** 这条消息回复的是哪张任务卡（没回复卡片为 null）。 */
  card: OutboxRow | null;
}

const CONFIRM_TTL_MS = 10 * 60_000;

export const HELP = [
  "直接回复任务卡片 = 答复它的提问 / 给任务发消息（附图片、文件也行）。",
  "单聊里直接说话 = 跟 ash 助手聊（它能帮你查任务、建任务）。",
  "/todo —— 还有哪些事等你；积压的卡逐张推过来",
  "/project —— 看看能选哪些项目；/project 2 或 /project 名字 —— 设为当前项目",
  "/new 标题（换行写详细要求）—— 在当前项目建任务并开跑（会先让你确认）",
  "/stop —— 回复某张任务卡发送：停掉那个任务（会先让你确认）",
  "/retry —— 回复某张失败卡发送：重试",
  "/help —— 显示这段说明",
].join("\n");

const KNOWN = new Set(["help", "todo", "project", "new", "stop", "retry", "answer", "reply"]);

export function parseCommand(text: string): { name: string; rest: string } | null {
  const match = /^\/([a-z]+)\b[ \t]*([\s\S]*)$/i.exec(text.trim());
  if (!match || !KNOWN.has(match[1]!.toLowerCase())) return null;
  return { name: match[1]!.toLowerCase(), rest: match[2]!.trim() };
}

export class CommandRunner {
  constructor(private readonly deps: { appId: string; ash: AshClient; reconciler: Reconciler }) {}

  /** 回一句文字（回复用户那条消息）。 */
  async say(ctx: Pick<InboundContext, "messageId" | "dest">, text: string, subject = `r:${ctx.messageId}`, taskId: string | null = null): Promise<void> {
    await this.deps.reconciler.run(() => this.deps.reconciler.insert({
      dest: ctx.dest, taskId, kind: "reply", subject, msgType: "text",
      content: JSON.stringify({ text: scrubText(text, 3500) }), replyTo: ctx.messageId,
    }));
    this.deps.reconciler.kick();
  }

  private async card(ctx: InboundContext, title: string, text: string, payload: Record<string, unknown>, danger: boolean): Promise<void> {
    const rowId = `cf${ctx.messageId}`.slice(0, 40);
    const envelope = await createEnvelope({
      outboxId: rowId, taskId: typeof payload.taskId === "string" ? payload.taskId : null, action: "confirm", payload,
      recipientOpenId: ctx.principal.openId, generation: "c", ttlMs: CONFIRM_TTL_MS,
    });
    await this.deps.reconciler.run(() => this.deps.reconciler.insert({
      id: rowId, dest: ctx.dest, taskId: null, kind: "confirm", subject: ctx.messageId,
      content: JSON.stringify(renderCard(confirmCard(title, text, envelope, danger))), replyTo: ctx.messageId,
    }));
    this.deps.reconciler.kick();
  }

  async run(ctx: InboundContext, name: string, rest: string): Promise<void> {
    switch (name) {
      case "help": return this.say(ctx, HELP);
      case "todo": return this.todo(ctx);
      case "project": return this.project(ctx, rest);
      case "new": return this.newTask(ctx, rest);
      case "stop": {
        if (!ctx.card?.taskId) return this.say(ctx, "回复某张任务卡片再发 /stop，才知道要停哪个任务。");
        const title = (JSON.parse(ctx.card.content)?.header?.title?.content as string | undefined) ?? "这个任务";
        return this.card(ctx, "停掉任务？", `「${title}」会被停掉（可以之后在 ash 里重试续跑）。`, { command: "stop", taskId: ctx.card.taskId }, true);
      }
      case "retry": {
        if (!ctx.card?.taskId) return this.say(ctx, "回复某张失败卡片再发 /retry。");
        const result = await this.deps.ash.post(ctx.principal, taskPath(ctx.card.taskId, "/retry"));
        return this.say(ctx, result.ok ? "已重试，任务重新开始跑了。" : `没能重试：${result.error}`, undefined, ctx.card.taskId);
      }
      default:
        // /answer、/reply 与「直接回复卡片」是同一件事，由调用方当普通回复处理。
        return this.say(ctx, HELP);
    }
  }

  private async todo(ctx: InboundContext): Promise<void> {
    const open = await db.select().from(imOutbox).where(and(
      eq(imOutbox.appId, this.deps.appId), eq(imOutbox.receiveId, ctx.dest.receiveId),
      inArray(imOutbox.state, ["sent", "held", "pending"]),
      inArray(imOutbox.kind, ["question", "failed", "dispute", "duet_gate", "accept"]),
    ));
    if (!open.length) return this.say(ctx, "眼下没有等你处理的事。");
    const { released, left } = await this.deps.reconciler.run(() => this.deps.reconciler.release(ctx.dest.receiveId));
    const lines = open.slice(0, 15).map((row) => `· ${(JSON.parse(row.content)?.header?.title?.content as string | undefined) ?? "（任务）"}`);
    await this.say(ctx, [
      `还有 ${open.length} 件事等你：`, ...lines,
      released ? `刚把其中 ${released} 张卡推了过来${left ? `，还有 ${left} 张，再发 /todo 继续` : ""}。` : "它们的卡片都已经在上面了。",
    ].join("\n"));
  }

  private async projects(ctx: InboundContext): Promise<Project[]> {
    const result = await this.deps.ash.get<Project[]>(ctx.principal, "/api/projects");
    return result.ok && Array.isArray(result.data) ? result.data : [];
  }

  private async project(ctx: InboundContext, rest: string): Promise<void> {
    const list = await this.projects(ctx);
    if (!rest) {
      if (!list.length) return this.say(ctx, "你还看不到任何项目。");
      const current = list.find((project) => project.id === ctx.binding.projectId);
      return this.say(ctx, [
        `当前项目：${current ? current.name : "未指定"}`,
        ...list.slice(0, 30).map((project, index) => `${index + 1}. ${project.name}`),
        "发 /project 编号 或 /project 名字 切换。",
      ].join("\n"));
    }
    const index = /^\d+$/.test(rest) ? Number(rest) - 1 : -1;
    const lowered = rest.toLowerCase();
    const picked = index >= 0 ? list[index] : list.find((project) => project.name.toLowerCase() === lowered)
      ?? list.find((project) => project.name.toLowerCase().includes(lowered));
    if (!picked) return this.say(ctx, `没找到「${scrubTitle(rest, 30)}」。发 /project 看看能选哪些。`);
    await updateBinding(ctx.principal, { projectId: picked.id });
    return this.say(ctx, `当前项目已切到「${picked.name}」。/new 建的任务、助手派的活都会落在这里。`);
  }

  private async newTask(ctx: InboundContext, rest: string): Promise<void> {
    if (!rest) return this.say(ctx, "用法：/new 标题（换行写详细要求）");
    const projectId = ctx.binding.projectId;
    const project = projectId ? (await this.projects(ctx)).find((item) => item.id === projectId) : undefined;
    if (!project) return this.say(ctx, "还没选当前项目（或你已经看不到它了）：先发 /project 选一个。");
    const [first, ...others] = rest.split("\n");
    const title = first!.trim().slice(0, 120);
    const body = (others.join("\n").trim() || title).slice(0, 20_000);
    return this.card(ctx, "建任务并开跑？", `项目：${project.name}\n标题：${title}${body !== title ? `\n要求：${scrubText(body, 600)}` : ""}`,
      { command: "new", projectId: project.id, title, body }, false);
  }

  /** 确认卡上点了「确定」。 */
  async confirmed(principal: ImPrincipal, payload: Record<string, unknown>): Promise<Outcome> {
    if (payload.command === "stop" && typeof payload.taskId === "string") {
      const result = await this.deps.ash.post(principal, taskPath(payload.taskId, "/stop"));
      return result.ok ? { ok: true, text: "已停止。", final: true, tone: "grey" } : { ok: false, text: result.error, final: false };
    }
    if (payload.command === "new" && typeof payload.projectId === "string" && typeof payload.title === "string") {
      const created = await this.deps.ash.post<{ id: string }>(principal, "/api/tasks", {
        projectId: payload.projectId, title: payload.title, body: payload.body,
      });
      if (!created.ok) return { ok: false, text: created.error, final: false };
      const run = await this.deps.ash.post(principal, taskPath(created.data.id, "/run"));
      const base = (await readOptions()).publicBaseUrl;
      const link = taskLink(base, { task: { id: created.data.id, projectId: payload.projectId } as never });
      return {
        ok: true, final: true, tone: run.ok ? "green" : "orange", link,
        text: run.ok ? `已建任务「${payload.title}」并开跑。` : `任务已建好，但没能开跑：${run.error}`,
      };
    }
    return { ok: false, text: "认不出这张确认卡", final: false };
  }
}

// 飞书里的斜杠命令。全部以发命令那个人的身份执行（ash-client.ts），能做的事不超过他在网页上能做的。
//
// 会改东西、而且改了收不回来的先要他再点一下 —— 手机上误触、输入法联想补全都很常见：/stop 回一张确认卡（10 分钟
// 有效），/new 回一张建任务表单（选项目、填好再点提交，提交本身就是确认）。
//
// 飞书里没有「当前项目」：建任务时在表单上选，看任务时 /tasks 先选项目，助手派活由它按你说的话挑项目
// （chat/assistant.ts）。都只在他此刻看得见的项目里挑。
//
// 每一句回执都要说清凭什么能发给这个人（scope.ts）：不含 ash 数据的静态句是 system，他自己这次操作的
// 结局（接口报错）是 reply，带着任务、项目的按各自来源记、列着的项目逐个记，出口照此现核；都按消息进来
// 那一刻的绑定实例盖（scope.ts requestScope），不按办完时的现状。个人的东西（能看哪些项目）不进群；
// 群里看任务、建任务都只落在这个群绑定的项目上。
import type { Project } from "@ash/shared";
import { provisionalTitle } from "@ash/shared/provisional-title";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { imOutbox } from "../db/schema-im.js";
import type { ImPrincipal } from "../auth/im-actor.js";
import { failureOf, taskPath, type AshClient } from "./ash-client.js";
import type { BindingRow } from "./binding.js";
import { BROWSE_PAGE, browseCard, Browser, browseScope, PICK_LIMIT, type BrowseView } from "./browse.js";
import { confirmCard, newTaskCard, taskLink, todoText } from "./cards.js";
import { createEnvelope, ENVELOPE_TTL_MS } from "./envelopes.js";
import { summaryItems } from "./exits.js";
import { renderCard, type CardModel } from "./feishu/cards.js";
import { groupOf } from "./groups.js";
import { readOptions } from "./meta.js";
import { formAttachments } from "./new-form.js";
import { cardHeaderOf, type Destination, type OutboxRow } from "./outbox.js";
import type { Outcome } from "./actions.js";
import { versionOf } from "./attention.js";
import type { Reconciler } from "./reconcile.js";
import { admit, replyScope, requestScope, SYSTEM_SCOPE, type Origin, type OutboxScope, type ScopeBody } from "./scope.js";
import { scrubText, scrubTitle } from "./scrub.js";

export interface InboundContext {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  principal: ImPrincipal;
  binding: BindingRow;
  /** 回给这个人的去处：单聊按 open_id，群按 chat_id。 */
  dest: Destination;
  /** 这条消息进来那一刻的绑定实例（scope.ts originOf）：回给他这次操作结局的那一句按它核，不按办完时的现状。 */
  origin: Origin;
  /** 这条消息回复的是哪张任务卡（没回复卡片为 null）。 */
  card: OutboxRow | null;
  /** 马上要做一件不幂等的事（重启后不能照原文重办）：先把这一步记下来（inbound.ts 顶部）。 */
  commit?: (taskId: string | null) => Promise<void>;
}

const CONFIRM_TTL_MS = 10 * 60_000;
/** 建任务表单要填：放久一点，发完过一阵再点也行。提交那一刻按他的身份建，看不到的项目建不了。 */
const FORM_TTL_MS = 24 * 3600_000;
/** 表单上一个下拉框最多放几个项目。 */
const FORM_LIMIT = 100;
/** 飞书输入框的上限（feishu/cards.ts INPUT_MAX）：更长的要求不放进框里，随信封带着。 */
const INPUT_MAX = 1000;
const NO_GROUP_PROJECT = "这个群还没绑定 ash 项目：先在 ash 网页 设置 → 飞书 → 群 里绑定，或者在单聊里用。";

/** 按名字认项目：先认一模一样的，再认包含这几个字的（不分大小写）。 */
function projectNamed(list: Project[], name: string): Project | undefined {
  const lowered = name.toLowerCase();
  return list.find((project) => project.name.toLowerCase() === lowered)
    ?? list.find((project) => project.name.toLowerCase().includes(lowered));
}

export const HELP = [
  "直接回复提问卡 = 答复它（附图片、文件也行）；回复别的任务卡要以 /reply 开头，才会发给那个任务。",
  "单聊里直接说话 = 跟 ash 助手聊（它能帮你查任务、建任务）。",
  "/todo —— 还有哪些事等你；积压的卡逐张推过来",
  "/tasks —— 看某个项目的任务：先选项目，点任务直接打开；/tasks 项目名 直接看",
  "/new —— 弹出建任务卡片：选项目、写要做什么，提交就开跑（标题由智能体起）；/new 后面直接跟一段话会替你先填好；要带图片、文件就和 /new 一起发，或者回复那张卡发过来",
  "/stop —— 回复某张任务卡发送：停掉那个任务（会先让你确认）",
  "/retry —— 回复某张失败卡发送：重试",
  "/help —— 显示这段说明",
].join("\n");

// project 是 /tasks 的旧名（机器人菜单里可能还配着它）。
const KNOWN = new Set(["help", "todo", "tasks", "project", "new", "stop", "retry", "answer", "reply"]);

export function parseCommand(text: string): { name: string; rest: string } | null {
  const match = /^\/([a-z]+)\b[ \t]*([\s\S]*)$/i.exec(text.trim());
  if (!match || !KNOWN.has(match[1]!.toLowerCase())) return null;
  return { name: match[1]!.toLowerCase(), rest: match[2]!.trim() };
}

export class CommandRunner {
  /** /tasks 那张卡上的翻页、建任务（actions.ts 按信封的 browse 交给它）。 */
  readonly browser: Browser;

  constructor(private readonly deps: { appId: string; ash: AshClient; reconciler: Reconciler }) {
    this.browser = new Browser(deps);
  }

  /**
   * 回一句文字（回复用户那条消息）。scope = 这句话凭什么能发给他；brief = 项目设成只推标题时换上的那一句；
   * taskId = 回复这句话时该路由到哪个任务（inbound.ts cardOf），与授权无关。
   */
  async say(
    ctx: Pick<InboundContext, "messageId" | "dest">, text: string, scope: OutboxScope,
    opts: { subject?: string; taskId?: string | null; brief?: string } = {},
  ): Promise<void> {
    await this.deps.reconciler.run(() => this.deps.reconciler.insert({
      dest: ctx.dest, taskId: opts.taskId ?? null, kind: "reply", subject: opts.subject ?? `r:${ctx.messageId}`, msgType: "text",
      content: JSON.stringify({ text: scrubText(text, 3500) }), replyTo: ctx.messageId,
      scope, brief: opts.brief ? JSON.stringify({ text: opts.brief }) : null,
    }));
    this.deps.reconciler.kick();
  }

  /** 回给他这次请求的、带着 ash 数据的内容：按消息进来那一刻的来源（群里的还记着是他发起的），正文里有什么记什么。 */
  scoped(ctx: Pick<InboundContext, "origin">, body: ScopeBody): OutboxScope {
    return requestScope(ctx.origin, body);
  }

  /** 回给他的、他这次操作的结局（scope.ts reply）：按消息进来那一刻的来源。about = 这次操作落在哪个任务 / 项目上，办之前就算好。 */
  answered(ctx: Pick<InboundContext, "origin">, about: { taskId?: string | null; projectId?: string | null }): Promise<OutboxScope> {
    return replyScope(ctx.origin, about);
  }

  private card(
    ctx: InboundContext, title: string, text: string, payload: Record<string, unknown>, danger: boolean, scope: OutboxScope, brief?: string,
  ): Promise<void> {
    return this.buttons(ctx, (envelope) => confirmCard(title, text, envelope, danger), payload, scope, CONFIRM_TTL_MS,
      brief === undefined ? undefined : (envelope) => confirmCard(title, brief, envelope, danger));
  }

  /**
   * 回一张带按钮的卡：确认卡、建任务表单（action=confirm，按钮点下去走 actions.ts confirmJob，payload.command 说是哪一种），
   * /tasks 的卡（action=browse，按钮只读、能反复点，走 browse.ts）。
   */
  private async buttons(
    ctx: InboundContext, render: (envelope: string) => CardModel, payload: Record<string, unknown>, scope: OutboxScope, ttlMs: number,
    brief?: (envelope: string) => CardModel, action: "confirm" | "browse" = "confirm",
  ): Promise<void> {
    const rowId = `cf${ctx.messageId}`.slice(0, 40);
    const envelope = await createEnvelope({
      outboxId: rowId, taskId: typeof payload.taskId === "string" ? payload.taskId : null, action, payload,
      recipientOpenId: ctx.principal.openId, generation: "c", ttlMs,
    });
    await this.deps.reconciler.run(() => this.deps.reconciler.insert({
      id: rowId, dest: ctx.dest, taskId: null, kind: "confirm", subject: ctx.messageId,
      content: JSON.stringify(renderCard(render(envelope))), replyTo: ctx.messageId,
      scope, brief: brief === undefined ? null : JSON.stringify(renderCard(brief(envelope))),
    }));
    this.deps.reconciler.kick();
  }

  /** attachments：这条消息里带的、已经转存好的附件（只有 /new 用：挂到表单上）。 */
  async run(ctx: InboundContext, name: string, rest: string, attachments: string[] = []): Promise<void> {
    switch (name) {
      case "help": return this.say(ctx, HELP, SYSTEM_SCOPE);
      case "todo": return this.todo(ctx);
      case "tasks":
      case "project": return this.tasks(ctx, rest);
      case "new": return this.newForm(ctx, rest, attachments);
      case "stop": {
        if (!ctx.card?.taskId) return this.say(ctx, "回复某张任务卡片再发 /stop，才知道要停哪个任务。", SYSTEM_SCOPE);
        const taskId = ctx.card.taskId;
        const answer = await this.answered(ctx, { taskId });
        // 确认卡带着任务标题、按任务记来源：任务删了或他看不到时出口会把它拦下，所以先以他的身份问一句，
        // 不行就把原因回给他（否则只剩沉默）。
        const seen = await this.deps.ash.get(ctx.principal, taskPath(taskId));
        if (!seen.ok) return this.say(ctx, `停不了：${scrubText(seen.error, 300)}`, answer,
          { taskId, brief: "停不了，原因见 ash。" });
        const title = cardHeaderOf(ctx.card.content).title;
        return this.card(ctx, "停掉任务？", `「${title}」会被停掉（可以之后在 ash 里重试续跑）。`, { command: "stop", taskId }, true,
          this.scoped(ctx, { kind: "task", taskId }));
      }
      case "retry": {
        // 重试的是那张失败卡上的那一次（与卡上的「重试」按钮同一个判据，actions.ts）：别的卡认不出是哪一次。
        if (!ctx.card?.taskId || ctx.card.kind !== "failed") return this.say(ctx, "回复那张失败卡片再发 /retry（发 /todo 能找到它）。", SYSTEM_SCOPE);
        const taskId = ctx.card.taskId;
        await ctx.commit?.(taskId);
        const answer = await this.answered(ctx, { taskId });
        const result = await this.deps.ash.post(ctx.principal, taskPath(taskId, "/retry"), { expectedFailure: versionOf(ctx.card.subject) });
        return this.say(ctx, result.ok ? "已重试，任务重新开始跑了。" : `没能重试：${scrubText(result.error, 300)}`, answer,
          { taskId, ...(result.ok ? {} : { brief: "没能重试，原因见 ash。" }) });
      }
      default:
        // /answer、/reply 由调用方按回复卡片处理（inbound.ts toTask），走不到这里。
        return this.say(ctx, HELP, SYSTEM_SCOPE);
    }
  }

  /** 列出还在等这个收件人的卡。只列出口此刻放得行的（与发出时同一个判据），清单本身在出口还会再核一次。 */
  private async todo(ctx: InboundContext): Promise<void> {
    const open = await db.select().from(imOutbox).where(and(
      eq(imOutbox.appId, this.deps.appId), eq(imOutbox.receiveId, ctx.dest.receiveId),
      inArray(imOutbox.state, ["sent", "held", "pending"]),
      inArray(imOutbox.kind, ["question", "failed", "dispute", "duet_gate", "accept"]),
    ));
    const titleOnly = (await readOptions()).titleOnlyProjectIds;
    const shown: OutboxRow[] = [];
    for (const row of open) if ((await admit(this.deps.appId, row, titleOnly)).ok) shown.push(row);
    if (!shown.length) return this.say(ctx, "眼下没有等你处理的事。", SYSTEM_SCOPE);
    const { released, left } = await this.deps.reconciler.run(() => this.deps.reconciler.release(ctx.dest.receiveId));
    await this.say(ctx, todoText(summaryItems(shown).map((item) => item.title), shown.length,
      released ? `刚把其中 ${released} 张卡推了过来${left ? `，还有 ${left} 张，再发 /todo 继续` : ""}。` : "它们的卡片都已经在上面了。"),
    this.scoped(ctx, { kind: "digest", rowIds: shown.slice(0, 15).map((row) => row.id) }));
  }

  /** 他看得到的项目。没读到就是没读到（返回 null，已回过一句说明）：不能当成「一个都看不到」去答。 */
  private async projects(ctx: InboundContext): Promise<Project[] | null> {
    const result = await this.deps.ash.get<Project[]>(ctx.principal, "/api/projects");
    if (result.ok) return Array.isArray(result.data) ? result.data : [];
    await this.say(ctx, `这一下没读到你的项目列表（${scrubText(result.error, 120)}）：请稍后再试。`, await this.answered(ctx, {}));
    return null;
  }

  /**
   * /tasks（旧名 /project）：群里直接列这个群绑定的项目；单聊带项目名就直接列它，不带就先给一张项目选单（只有一个项目时
   * 直接列）。个人能看哪些项目只在单聊里说。卡上此后的翻页、建任务都在原地换（browse.ts）。
   */
  private async tasks(ctx: InboundContext, rest: string): Promise<void> {
    const inGroup = ctx.chatType !== "p2p";
    const fixed = inGroup ? (await groupOf(this.deps.appId, ctx.chatId))?.projectId ?? null : null;
    if (inGroup && !fixed) return this.say(ctx, NO_GROUP_PROJECT, SYSTEM_SCOPE);
    const list = await this.projects(ctx);
    if (!list) return;
    let project: Project | undefined;
    if (inGroup) {
      project = list.find((item) => item.id === fixed);
      if (!project) return this.say(ctx, "你看不到这个群绑定的项目。", SYSTEM_SCOPE);
    } else if (rest) {
      project = projectNamed(list, rest);
      // 只回显他自己刚打的字。
      if (!project) return this.say(ctx, `没找到「${scrubTitle(rest, 30)}」。发 /tasks 看看有哪些项目。`, SYSTEM_SCOPE);
    } else if (!list.length) return this.say(ctx, "你还看不到任何项目。", SYSTEM_SCOPE);
    else if (list.length === 1) project = list[0];

    if (!project) {
      const shown = list.slice(0, PICK_LIMIT);
      const view: BrowseView = { kind: "picker", entries: shown.map((item, index) => ({ project: item, index })), hidden: list.length - shown.length };
      return this.buttons(ctx, (envelope) => browseCard(view, envelope), { command: "browse", projectIds: shown.map((item) => item.id), picker: true },
        this.scoped(ctx, browseScope(view)), ENVELOPE_TTL_MS, undefined, "browse");
    }
    const view = await this.browser.tasksView(ctx.principal, project, 0, BROWSE_PAGE, false);
    if ("error" in view) {
      return this.say(ctx, `这一下没读到任务列表（${scrubText(view.error, 120)}）：请稍后再试。`, await this.answered(ctx, { projectId: project.id }));
    }
    return this.buttons(ctx, (envelope) => browseCard(view, envelope), { command: "browse", projectIds: [project.id], picker: false },
      this.scoped(ctx, browseScope(view)), ENVELOPE_TTL_MS, undefined, "browse");
  }

  /**
   * /new 回一张建任务表单：单聊列出他能看的项目（不替他选，只有一个时才选好），群里只有群绑定的那一个。
   * /new 后面那段话先填进表单；比输入框长就不放进框里，随信封带着、提交时一并带上。那条消息里带的附件同样随信封带着，
   * 之后回复这张表单发来的也挂上去（new-form.ts）。
   */
  private async newForm(ctx: InboundContext, rest: string, attachments: string[]): Promise<void> {
    const inGroup = ctx.chatType !== "p2p";
    const fixed = inGroup ? (await groupOf(this.deps.appId, ctx.chatId))?.projectId ?? null : null;
    if (inGroup && !fixed) return this.say(ctx, NO_GROUP_PROJECT, SYSTEM_SCOPE);
    const list = await this.projects(ctx);
    if (!list) return;
    const shown = inGroup ? list.filter((project) => project.id === fixed) : list.slice(0, FORM_LIMIT);
    if (!shown.length) return this.say(ctx, inGroup ? "你看不到这个群绑定的项目，建不了任务。" : "你还看不到任何项目。", SYSTEM_SCOPE);
    const body = rest.trim().slice(0, 20_000);
    const held = body.length > INPUT_MAX;
    const scope = shown.length === 1
      ? this.scoped(ctx, { kind: "project", projectId: shown[0]!.id })
      : this.scoped(ctx, { kind: "projects", projectIds: shown.map((project) => project.id) });
    return this.buttons(ctx, (envelope) => newTaskCard(shown.map((project) => project.name), inGroup ? 0 : list.length - shown.length, envelope,
      { body: held ? "" : body, heldBody: held ? body.length : 0, attachments: attachments.length }),
    { command: "newform", projectIds: shown.map((project) => project.id), ...(held ? { body } : {}), ...(attachments.length ? { attachments } : {}) },
    scope, FORM_TTL_MS);
  }

  /**
   * 建任务表单提交了：选的是信封里记着的第几个项目（建任务那一下接口按他的身份核还看不看得见）。
   * 首行当临时标题、首轮由智能体起正式标题，同网页上只写正文建任务；升级前发出的表单带着他填的标题，照用。
   */
  async submitted(
    principal: ImPrincipal, envelopeId: string, payload: Record<string, unknown>, form: { project: number; title: string; body: string },
  ): Promise<Outcome> {
    const ids = Array.isArray(payload.projectIds) ? payload.projectIds as unknown[] : [];
    const projectId = ids[form.project];
    if (typeof projectId !== "string") return { ok: false, text: "认不出选的是哪个项目", final: false };
    const held = typeof payload.body === "string" ? payload.body : "";
    const title = form.title.slice(0, 120);
    const attachments = await formAttachments(envelopeId);
    const body = (form.body || held || title).slice(0, 20_000);
    return this.createAndRun(principal, projectId, title || provisionalTitle(body), body, !title, attachments);
  }

  /** 确认卡上点了「确定」（/stop；/new 早先也走确认卡，升级前发出的那几张照样认）。 */
  async confirmed(principal: ImPrincipal, payload: Record<string, unknown>): Promise<Outcome> {
    if (payload.command === "stop" && typeof payload.taskId === "string") {
      const result = await this.deps.ash.post(principal, taskPath(payload.taskId, "/stop"));
      return result.ok ? { ok: true, text: "已停止。", final: true, tone: "grey" } : { ok: false, text: scrubText(result.error, 300), final: false };
    }
    if (payload.command === "new" && typeof payload.projectId === "string" && typeof payload.title === "string") {
      return this.createAndRun(principal, payload.projectId, payload.title, payload.body);
    }
    return { ok: false, text: "认不出这张确认卡", final: false };
  }

  /** 建任务并开跑（确认卡的「确定」、表单的提交）。 */
  private async createAndRun(
    principal: ImPrincipal, projectId: string, title: string, body: unknown, autoTitle = false, attachments: string[] = [],
  ): Promise<Outcome> {
    const created = await this.deps.ash.post<{ id: string }>(principal, "/api/tasks",
      { projectId, title, body, autoTitle, ...(attachments.length ? { attachments } : {}) });
    // 请求本身被拒（参数、权限）才放回信封让他再点；5xx、没调通的任务可能已经建出来了，再点一下就是第二个：
    // 按「办完了、结局不明」收起，跟 ash 重启打断确认卡同一个说法（actions.ts recoverOne）。
    if (!created.ok && failureOf(created) === "transient") {
      return { ok: true, final: true, tone: "orange", text: `不确定建成没有（${scrubText(created.error, 120)}）：请在 ash 里看一眼，需要的话重新发 /new。` };
    }
    if (!created.ok) return { ok: false, text: scrubText(created.error, 300), final: false };
    // 任务已经建出来了：后面再出什么错都不能算「没办成」—— 那会放回信封，再点一下就又建一个。
    const run = await this.deps.ash.post(principal, taskPath(created.data.id, "/run"));
    const base = await readOptions().then((options) => options.publicBaseUrl, () => null);
    const link = taskLink(base, { task: { id: created.data.id, projectId } });
    return {
      ok: true, final: true, tone: run.ok ? "green" : "orange", link,
      text: run.ok ? `已建任务「${title}」${attachments.length ? `（带 ${attachments.length} 个附件）` : ""}并开跑。` : `任务已建好，但没能开跑：${scrubText(run.error, 300)}`,
      ...(run.ok ? {} : { brief: "任务已建好，但没能开跑，原因见 ash。" }),
    };
  }
}

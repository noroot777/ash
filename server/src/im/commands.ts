// 飞书里的斜杠命令。全部以发命令那个人的身份执行（ash-client.ts），能做的事不超过他在网页上能做的。
//
// 会改东西、而且改了收不回来的（/new 建任务并开跑、/stop 停任务）先回一张确认卡，点「确定」
// 才执行 —— 手机上误触、输入法联想补全都很常见。确认卡 10 分钟有效。
//
// 每一句回执都要说清凭什么能发给这个人（scope.ts）：不含 ash 数据的静态句是 system，他自己这次操作的
// 结局（接口报错）是 reply，带着任务、项目的按各自来源记、列着的项目逐个记，出口照此现核；都按消息进来
// 那一刻的绑定实例盖（scope.ts requestScope），不按办完时的现状。个人的东西（能看哪些项目、当前项目）不进群；
// 群里建任务只建到这个群绑定的项目上。
import type { Project } from "@ash/shared";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { imOutbox } from "../db/schema-im.js";
import type { ImPrincipal } from "../auth/im-actor.js";
import { failureOf, taskPath, type AshClient } from "./ash-client.js";
import { updateBinding, type BindingRow } from "./binding.js";
import { confirmCard, newTaskCard, projectCard, taskLink, todoText } from "./cards.js";
import { createEnvelope } from "./envelopes.js";
import { renderCard, type CardModel } from "./feishu/cards.js";
import { groupOf } from "./groups.js";
import { readOptions } from "./meta.js";
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
/** 项目选单、建任务表单要选要填：放久一点，发完过一阵再点也行。点的那一刻按他的身份办，看不到的项目切不了也建不了。 */
const FORM_TTL_MS = 24 * 3600_000;

export const HELP = [
  "直接回复提问卡 = 答复它（附图片、文件也行）；回复别的任务卡要以 /reply 开头，才会发给那个任务。",
  "单聊里直接说话 = 跟 ash 助手聊（它能帮你查任务、建任务）。",
  "/todo —— 还有哪些事等你；积压的卡逐张推过来",
  "/project —— 弹出项目卡片，点一下就切成当前项目；也可以 /project 名字",
  "/new —— 弹出建任务卡片：选项目、填标题和要求，提交就开跑",
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

  /** 回一张带按钮的卡（确认卡、项目选单）：按钮点下去走 actions.ts confirmJob，payload.command 说是哪一种。 */
  private async buttons(
    ctx: InboundContext, render: (envelope: string) => CardModel, payload: Record<string, unknown>, scope: OutboxScope, ttlMs: number,
    brief?: (envelope: string) => CardModel,
  ): Promise<void> {
    const rowId = `cf${ctx.messageId}`.slice(0, 40);
    const envelope = await createEnvelope({
      outboxId: rowId, taskId: typeof payload.taskId === "string" ? payload.taskId : null, action: "confirm", payload,
      recipientOpenId: ctx.principal.openId, generation: "c", ttlMs,
    });
    await this.deps.reconciler.run(() => this.deps.reconciler.insert({
      id: rowId, dest: ctx.dest, taskId: null, kind: "confirm", subject: ctx.messageId,
      content: JSON.stringify(renderCard(render(envelope))), replyTo: ctx.messageId,
      scope, brief: brief === undefined ? null : JSON.stringify(renderCard(brief(envelope))),
    }));
    this.deps.reconciler.kick();
  }

  async run(ctx: InboundContext, name: string, rest: string): Promise<void> {
    switch (name) {
      case "help": return this.say(ctx, HELP, SYSTEM_SCOPE);
      case "todo": return this.todo(ctx);
      case "project": return this.project(ctx, rest);
      case "new": return this.newTask(ctx, rest);
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
    await this.say(ctx, todoText(shown.map((row) => cardHeaderOf(row.content).title), shown.length,
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
   * 他能看哪些项目、他的当前项目是哪个：只属于他本人，只在单聊里答。清单列着哪几个项目就记哪几个（当前项目也在其中），
   * 出口逐个核他此刻还看得见；切换只改消息进来那一次的绑定 —— 列表取回来之前换了绑，写进去就是改了另一个人的当前项目。
   * 不带参数回一张选单卡（点按钮切，见 picked）；带编号 / 名字直接切。
   */
  private async project(ctx: InboundContext, rest: string): Promise<void> {
    if (ctx.chatType !== "p2p") return this.say(ctx, "/project 请在和我的单聊里用：它会列出你个人能看到的项目。", SYSTEM_SCOPE);
    const list = await this.projects(ctx);
    if (!list) return;
    if (!rest) {
      if (!list.length) return this.say(ctx, "你还看不到任何项目。", SYSTEM_SCOPE);
      const current = list.find((project) => project.id === ctx.binding.projectId);
      const shown = list.slice(0, 30);
      const listed = [...new Set([...shown, ...(current ? [current] : [])].map((project) => project.id))];
      // 信封里记着按钮对应哪个项目、是哪一次绑定：点的时候按这一份切，不按点那一刻重新排出来的顺序。
      return this.buttons(ctx, (envelope) => projectCard(current?.name ?? null, shown.map((project) => project.name),
        shown.findIndex((project) => project.id === current?.id), envelope),
      { command: "project", projectIds: shown.map((project) => project.id), boundAt: ctx.binding.boundAt },
      this.scoped(ctx, { kind: "projects", projectIds: listed }), FORM_TTL_MS);
    }
    const index = /^\d+$/.test(rest) ? Number(rest) - 1 : -1;
    const lowered = rest.toLowerCase();
    const picked = index >= 0 ? list[index] : list.find((project) => project.name.toLowerCase() === lowered)
      ?? list.find((project) => project.name.toLowerCase().includes(lowered));
    // 只回显他自己刚打的字。
    if (!picked) return this.say(ctx, `没找到「${scrubTitle(rest, 30)}」。发 /project 看看能选哪些。`, SYSTEM_SCOPE);
    if (!await updateBinding(ctx.principal, { projectId: picked.id }, ctx.binding.boundAt)) {
      return this.say(ctx, "你刚换过绑定，这次没切：请再发一次。", SYSTEM_SCOPE);
    }
    return this.say(ctx, `当前项目已切到「${picked.name}」。/new 建的任务、助手派的活都会落在这里。`,
      this.scoped(ctx, { kind: "project", projectId: picked.id }));
  }

  /**
   * 单聊里建到他的当前项目；群里只建到这个群绑定的项目（群里的人看得到确认卡，不能把别的项目带进来）。
   * 不带参数回一张表单卡（项目在单聊里可选，见 newForm）。
   */
  private async newTask(ctx: InboundContext, rest: string): Promise<void> {
    if (!rest) return this.newForm(ctx);
    const inGroup = ctx.chatType !== "p2p";
    const projectId = inGroup ? (await groupOf(this.deps.appId, ctx.chatId))?.projectId ?? null : ctx.binding.projectId;
    if (inGroup && !projectId) return this.say(ctx, "这个群还没绑定 ash 项目：先在 ash 网页 设置 → 飞书 → 群 里绑定，或者在单聊里用 /new。", SYSTEM_SCOPE);
    const list = projectId ? await this.projects(ctx) : [];
    if (!list) return;
    const project = list.find((item) => item.id === projectId);
    if (!project) {
      return this.say(ctx, inGroup ? "你看不到这个群绑定的项目，建不了任务。" : "还没选当前项目（或你已经看不到它了）：先发 /project 选一个。", SYSTEM_SCOPE);
    }
    const [first, ...others] = rest.split("\n");
    const title = first!.trim().slice(0, 120);
    const body = (others.join("\n").trim() || title).slice(0, 20_000);
    const head = `项目：${project.name}\n标题：${title}`;
    return this.card(ctx, "建任务并开跑？", `${head}${body !== title ? `\n要求：${scrubText(body, 600)}` : ""}`,
      { command: "new", projectId: project.id, title, body }, false, this.scoped(ctx, { kind: "project", projectId: project.id }),
      body !== title ? `${head}\n（详细要求只在 ash 里看）` : undefined);
  }

  /**
   * 项目选单上点了一个项目。点的那一刻以他的身份重读一遍项目列表：发卡之后被移出了那个项目就不切；绑定按发卡那一次
   * 做 CAS（同 /project 名字），换过绑定这张卡就作废了。
   */
  async picked(principal: ImPrincipal, payload: Record<string, unknown>, index: number): Promise<Outcome> {
    const ids = Array.isArray(payload.projectIds) ? payload.projectIds as unknown[] : [];
    const projectId = ids[index];
    if (typeof projectId !== "string" || typeof payload.boundAt !== "string") return { ok: false, text: "认不出点的是哪个项目", final: false };
    const result = await this.deps.ash.get<Project[]>(principal, "/api/projects");
    if (!result.ok) return { ok: false, text: `没读到你的项目列表：${scrubText(result.error, 200)}`, final: false };
    const picked = (Array.isArray(result.data) ? result.data : []).find((project) => project.id === projectId);
    if (!picked) return { ok: false, text: "这个项目你已经看不到了。", final: false };
    if (!await updateBinding(principal, { projectId }, payload.boundAt)) {
      return { ok: true, final: true, tone: "orange", text: "你换过绑定，这张卡作废了：请重新发 /project。" };
    }
    return { ok: true, final: true, tone: "green", text: `当前项目已切到「${picked.name}」。/new 建的任务、助手派的活都会落在这里；再发 /project 可以重新选。` };
  }

  /** 建任务表单：单聊列出他能看的项目、默认选当前项目；群里只有群绑定的那一个。 */
  private async newForm(ctx: InboundContext): Promise<void> {
    const inGroup = ctx.chatType !== "p2p";
    const fixed = inGroup ? (await groupOf(this.deps.appId, ctx.chatId))?.projectId ?? null : null;
    if (inGroup && !fixed) return this.say(ctx, "这个群还没绑定 ash 项目：先在 ash 网页 设置 → 飞书 → 群 里绑定，或者在单聊里用 /new。", SYSTEM_SCOPE);
    const list = await this.projects(ctx);
    if (!list) return;
    const shown = inGroup ? list.filter((project) => project.id === fixed) : list.slice(0, 30);
    if (!shown.length) return this.say(ctx, inGroup ? "你看不到这个群绑定的项目，建不了任务。" : "你还看不到任何项目。", SYSTEM_SCOPE);
    const scope = inGroup
      ? this.scoped(ctx, { kind: "project", projectId: fixed! })
      : this.scoped(ctx, { kind: "projects", projectIds: shown.map((project) => project.id) });
    return this.buttons(ctx, (envelope) => newTaskCard(shown.map((project) => project.name),
      inGroup ? 0 : shown.findIndex((project) => project.id === ctx.binding.projectId), envelope),
    { command: "newform", projectIds: shown.map((project) => project.id) }, scope, FORM_TTL_MS);
  }

  /** 建任务表单提交了：选的是信封里记着的第几个项目（建任务那一下接口按他的身份核还看不看得见）。 */
  submitted(principal: ImPrincipal, payload: Record<string, unknown>, form: { project: number; title: string; body: string }): Promise<Outcome> {
    const ids = Array.isArray(payload.projectIds) ? payload.projectIds as unknown[] : [];
    const projectId = ids[form.project];
    if (typeof projectId !== "string") return Promise.resolve({ ok: false, text: "认不出选的是哪个项目", final: false });
    const title = form.title.slice(0, 120);
    return this.createAndRun(principal, projectId, title, (form.body || title).slice(0, 20_000));
  }

  /** 确认卡上点了「确定」。 */
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
  private async createAndRun(principal: ImPrincipal, projectId: string, title: string, body: unknown): Promise<Outcome> {
    const created = await this.deps.ash.post<{ id: string }>(principal, "/api/tasks", { projectId, title, body });
    // 请求本身被拒（参数、权限）才放回信封让他再点；5xx、没调通的任务可能已经建出来了，再点一下就是第二个：
    // 按「办完了、结局不明」收起，跟 ash 重启打断确认卡同一个说法（actions.ts recoverOne）。
    if (!created.ok && failureOf(created) === "transient") {
      return { ok: true, final: true, tone: "orange", text: `不确定建成没有（${scrubText(created.error, 120)}）：请在 ash 里看一眼，需要的话重新发 /new。` };
    }
    if (!created.ok) return { ok: false, text: scrubText(created.error, 300), final: false };
    // 任务已经建出来了：后面再出什么错都不能算「没办成」—— 那会放回信封，再点一下就又建一个。
    const run = await this.deps.ash.post(principal, taskPath(created.data.id, "/run"));
    const base = await readOptions().then((options) => options.publicBaseUrl, () => null);
    const link = taskLink(base, { task: { id: created.data.id, projectId } as never });
    return {
      ok: true, final: true, tone: run.ok ? "green" : "orange", link,
      text: run.ok ? `已建任务「${title}」并开跑。` : `任务已建好，但没能开跑：${scrubText(run.error, 300)}`,
      ...(run.ok ? {} : { brief: "任务已建好，但没能开跑，原因见 ash。" }),
    };
  }
}

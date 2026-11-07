// /tasks：在飞书里翻看一个项目的任务。
//
// 一张卡在原地翻：单聊先给一张项目选单，点一个项目 → 这张卡换成它的任务列表（先 5 个，「再显示 5 个」往下加），
// 每一行点一下就打开那个任务的 ash 链接；「在这里建任务」把这张卡换成落在这个项目上的建任务表单。群里只看这个群
// 绑定的项目，直接给列表。先后跟网页侧栏同一份规则（shared/src/task-order.ts）。
//
// 这张卡上的按钮只读不写，所以信封不占用（browse 这一种可以反复点）：点的那一刻照样过信封的前三关（是不是发给
// 他的、过没过期），再以他的身份重读项目和任务 —— 发卡之后被移出项目，翻不出那个项目的任何东西；发卡之后换过
// 绑定（解绑重绑、换了人），这张卡就不再翻，让他重新发一次。按钮上带的
// 「第几个项目、显示几个」只是在信封记着的那几个项目里挑，挑不出信封以外的项目。
// 换上去的卡和发件表里那一行同一份（actions.ts 文件头的约定：库里那份是卡上最终该有的样子），来源也跟着换成
// 卡上此刻列着的东西，出口按它核。
import { taskDisplayStatus, type Project, type TaskListItem } from "@ash/shared";
import { orderedListTasks } from "@ash/shared/task-order";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { imOutbox } from "../db/schema-im.js";
import type { ImPrincipal } from "../auth/im-actor.js";
import { now } from "../util.js";
import type { AshClient } from "./ash-client.js";
import { newTaskCard, taskLink } from "./cards.js";
import { createEnvelope, type EnvelopeRow } from "./envelopes.js";
import { renderCard, type CardBlock, type CardButton, type CardModel } from "./feishu/cards.js";
import { readOptions } from "./meta.js";
import type { OutboxRow } from "./outbox.js";
import type { Reconciler } from "./reconcile.js";
import { originOfScope, requestScope, scopeOfRow, type Origin, type ScopeBody } from "./scope.js";
import { scrubText, scrubTitle } from "./scrub.js";

export const BROWSE_PAGE = 5;
/** 一张卡最多列这么多个任务（再多卡片就太长了，剩下的去 ash 里看）。 */
const BROWSE_MAX = 30;
/** 选单一张卡放几个项目（每个一颗按钮）。 */
export const PICK_LIMIT = 30;
/** 回执里带回去的卡，等「回执已发出」的确认这么久（同 actions.ts）。 */
const ACK_GRACE_MS = 15_000;

/** 信封里记着的：这张卡能翻哪几个项目；picker = 是从选单进来的（列表上给「换个项目」）。 */
export interface BrowsePayload { command: "browse"; projectIds: string[]; picker: boolean }

export type BrowseView =
  /** index = 这个项目在信封 projectIds 里排第几（按钮上带的就是它）。 */
  | { kind: "picker"; entries: { project: Project; index: number }[]; hidden: number }
  | { kind: "tasks"; project: Project; index: number; tasks: TaskListItem[]; shown: number; picker: boolean; base: string | null };

const value = (envelope: string, op: string, extra: Record<string, string | number> = {}) => ({ e: envelope, op, ...extra });

function ago(iso: string, at = Date.now()): string {
  const minutes = Math.max(0, Math.floor((at - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days} 天前` : iso.slice(0, 10);
}

export function browseCard(view: BrowseView, envelope: string): CardModel {
  if (view.kind === "picker") {
    return {
      title: "看哪个项目的任务",
      tone: "blue",
      blocks: [
        { type: "buttons", buttons: view.entries.map(({ project, index }) => ({ text: scrubTitle(project.name, 24), value: value(envelope, "open", { i: index }) })) },
        ...(view.hidden ? [{ type: "note" as const, text: `还有 ${view.hidden} 个项目没列出：发 /tasks 项目名 直接看。` }] : []),
      ],
    };
  }
  const shown = view.tasks.slice(0, view.shown);
  const blocks: CardBlock[] = shown.length
    ? [{
      type: "links",
      items: shown.map((task) => ({
        text: scrubTitle(task.title, 60),
        note: `${taskDisplayStatus(task.status, task.stage, !!task.question).label} · ${ago(task.updatedAt)}`,
        url: taskLink(view.base, { task }),
      })),
    }]
    : [{ type: "note", text: "这个项目里还没有任务。" }];
  const more = Math.min(view.tasks.length, BROWSE_MAX) - shown.length;
  const buttons: CardButton[] = [
    ...(more > 0 ? [{ text: `再显示 ${Math.min(BROWSE_PAGE, more)} 个`, style: "primary" as const, value: value(envelope, "more", { i: view.index, n: view.shown + BROWSE_PAGE }) }] : []),
    { text: "在这里建任务", value: value(envelope, "new", { i: view.index }) },
    ...(view.picker ? [{ text: "换个项目", value: value(envelope, "back") }] : []),
  ];
  blocks.push({ type: "buttons", buttons });
  if (!view.base && shown.length) blocks.push({ type: "note", text: "设置 → 飞书 里填上 ash 的访问地址后，点任务就能直接打开。" });
  else if (view.tasks.length > BROWSE_MAX && more <= 0) blocks.push({ type: "note", text: `一共 ${view.tasks.length} 个，更早的去 ash 里看。` });
  return { title: scrubTitle(view.project.name, 40), subtitle: `${view.tasks.length} 个任务`, tone: "blue", blocks };
}

/** 卡上此刻列着什么，出口就按什么核（scope.ts）。 */
export function browseScope(view: BrowseView): ScopeBody {
  return view.kind === "picker"
    ? { kind: "projects", projectIds: view.entries.map(({ project }) => project.id) }
    : { kind: "project", projectId: view.project.id };
}

export class Browser {
  constructor(private readonly deps: { appId: string; ash: AshClient; reconciler: Reconciler }) {}

  /** 以他的身份读他看得到的项目；没读到返回报错原文。 */
  async projectsOf(principal: ImPrincipal): Promise<Project[] | { error: string }> {
    const result = await this.deps.ash.get<Project[]>(principal, "/api/projects");
    if (!result.ok) return { error: result.error };
    return Array.isArray(result.data) ? result.data : [];
  }

  /** 一个项目的任务列表视图（按网页侧栏的先后）。 */
  async tasksView(
    principal: ImPrincipal, project: Project, index: number, shown: number, picker: boolean,
  ): Promise<BrowseView | { error: string }> {
    const result = await this.deps.ash.get<TaskListItem[]>(principal, "/api/tasks");
    if (!result.ok) return { error: result.error };
    const tasks = orderedListTasks((Array.isArray(result.data) ? result.data : []).filter((task) => task.projectId === project.id));
    const base = await readOptions().then((options) => options.publicBaseUrl, () => null);
    return { kind: "tasks", project, index, tasks, shown: Math.max(BROWSE_PAGE, Math.min(shown, BROWSE_MAX)), picker, base };
  }

  /**
   * 卡上点了一下：按信封里记着的项目重读、重排，把这张卡换成点出来的样子（写进发件表那一行，回执里带回去）。
   * warn = 这一下没换卡，提示他一句。
   */
  async click(
    row: OutboxRow, envelope: EnvelopeRow, payload: Record<string, unknown>, op: string, input: Record<string, unknown>,
    principal: ImPrincipal, origin: Origin,
  ): Promise<{ card: Record<string, unknown> } | { warn: string }> {
    const sent = scopeOfRow(row);
    const was = sent ? originOfScope(sent, principal.openId) : null;
    if (!was || was.bound !== origin.bound || was.by.boundAt !== origin.by.boundAt) return { warn: "这张卡是换绑定之前发的：请重新发一次 /tasks" };
    const ids = Array.isArray(payload.projectIds) ? (payload.projectIds as unknown[]).filter((id): id is string => typeof id === "string") : [];
    const list = await this.projectsOf(principal);
    if ("error" in list) return { warn: `没读到你的项目列表：${scrubText(list.error, 60)}` };
    const byId = new Map(list.map((project) => [project.id, project] as const));
    let model: CardModel;
    let scope: ScopeBody;
    if (op === "back") {
      if (payload.picker !== true) return { warn: "认不出这个按钮" };
      // 下标跟着信封里那一份走（按钮上带的就是它）：已经看不到的项目空出来，不重新编号。
      const entries = ids.flatMap((id, index) => byId.has(id) ? [{ project: byId.get(id)!, index }] : []);
      if (!entries.length) return { warn: "这些项目你都已经看不到了" };
      const view: BrowseView = { kind: "picker", entries, hidden: list.length - entries.length };
      model = browseCard(view, envelope.id);
      scope = browseScope(view);
    } else {
      const index = Number(input.i);
      const project = Number.isInteger(index) ? byId.get(ids[index] ?? "") : undefined;
      if (!project) return { warn: "这个项目你已经看不到了" };
      if (op === "new") {
        // 表单是另一种按钮（提交即建任务、只能交一次）：配一个新信封，挂在同一行上。
        const form = await createEnvelope({
          outboxId: row.id, taskId: null, action: "confirm", payload: { command: "newform", projectIds: [project.id] },
          recipientOpenId: envelope.recipientOpenId || null, generation: "c", ttlMs: 24 * 3600_000,
        });
        model = newTaskCard([project.name], 0, form);
        scope = { kind: "project", projectId: project.id };
      } else if (op === "open" || op === "more") {
        const view = await this.tasksView(principal, project, index, op === "more" ? Number(input.n) || BROWSE_PAGE : BROWSE_PAGE, payload.picker === true);
        if ("error" in view) return { warn: `没读到任务列表：${scrubText(view.error, 60)}` };
        model = browseCard(view, envelope.id);
        scope = browseScope(view);
      } else return { warn: "认不出这个按钮" };
    }
    const content = JSON.stringify(renderCard(model));
    const next = { ...row, content, scope: JSON.stringify(requestScope(origin, scope)), brief: null };
    await this.deps.reconciler.run(() => db.update(imOutbox).set({
      content: next.content, scope: next.scope, brief: null, updatedAt: now(),
      ...(row.messageId ? { patchState: "acking", nextAt: new Date(Date.now() + ACK_GRACE_MS).toISOString() } : {}),
    }).where(eq(imOutbox.id, row.id)));
    return { card: await this.deps.reconciler.exits.outward(next, JSON.parse(content) as Record<string, unknown>) };
  }
}

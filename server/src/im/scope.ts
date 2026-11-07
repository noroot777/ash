// 发件授权：im_outbox 的每一行在入队时就记下「这份内容凭什么能给这个收件人看」（scope 列），三个
// 出口 —— 发出（outbox.ts sendOne）、改卡（patchOne）、卡片回调回执里直接带回去的卡（actions.ts）——
// 都按它现算一遍。入队那一刻的资格不是发出那一刻的：排队期间可能解了绑、换了人绑、被移出项目、群
// 换了项目、项目改成了只推标题。
//
// 不按 taskId 推断：taskId 列的意思是「回复这条消息该路由到哪个任务」（inbound.ts cardOf），助手
// 回复、确认卡、汇总卡都没有它，却都带着业务内容。
//
//   system     不含 ash 业务数据（绑定提示、用法说明、静态回执、接口报错）—— 给谁都能发，包括还没绑定的人；
//   task       某个任务的内容 —— 任务还在，收件人此刻能看它所在的项目（群：群此刻绑着这个项目）；
//   project    某个项目的内容（/new 的确认卡、/project 切换的回执）；
//   projects   列了一串项目（/project 的清单）—— 只发单聊，列着的每一个他此刻都还看得见；
//   room       聊天房间里智能体的回复 —— 房间还在、还归他、他还看得见；群聊房间还要群还绑着那个项目、
//              这间还是他在这个群里的那一间；回复下面列出的任务（taskIds）也逐个核他还看得见；
//   digest     列了一串别的卡（汇总卡、/todo）—— 逐行按那几行自己的来源核。
//   reply      回给发话人的、他自己这次操作的结局（接口报错、拒绝的原因）—— 话是接口以他的身份算出来的，可报错
//              原文常带着项目名、命令、路径，所以出口照样核：还是请求进来那一刻的那个人（单聊的绑定 / 群的绑定
//              加发起人的绑定，都按那一刻的实例 —— Origin，不在操作办完之后按「现在的收件人」重新盖）、他此刻
//              还看得见这个项目（群还绑着它）。核不过不发原文，换成一句不含 ash 数据的固定说明（exits.ts
//              withhold）：报错说的常常正是「看不到了 / 解绑了」这件事，一声不吭他只会以为没收到。
//
// 「还是那个收件人」按绑定实例认：入队时记下收件去处（单聊的个人绑定 / 群绑定）的 boundAt，解绑重绑、
// 换了人绑同一个飞书账号，boundAt 都会变（binding.ts confirmUserCode 每次重写）。群里由某个人发起的
// 内容（他点出来的确认卡、他的群聊房间的回复）还要这个人的绑定也还是那一个、还看得见。
// 任务通知（task）不认实例、只认此刻：任务的内容谁看得见项目谁就能看，换了绑定的人此刻能看就照发（决策卡的去处
// 本来就由对账按此刻的绑定算，recipients.ts）；其余几种是替某一个人做出来的东西，换了人就不给。
//
// 回给一次请求的东西（命令回执、确认卡、/todo 清单、房间回复、报错 —— request）一律按请求进来那一刻盖
// （requestScope，Origin），连 task 也认那一刻的实例：活是替那一次绑定的那个人办的，办着的时候换绑给了
// 另一个账号，此刻的绑定就是另一个人（审查第 2 轮实测：/project 取完列表时换绑，列表盖上新账号的实例照发）。
// 只有给此刻订阅者的通知（决策卡、汇总卡，reconcile.ts）才按此刻的绑定盖（scopeFor）。正文里列着哪些
// 资源也要记进来（projects、room 的 taskIds），出口逐个现核：只记「是谁」核不出列表里哪一项已经看不到了。
//
// 来源落了库（im_outbox / im_inbound 的 scope 列），会跨重启、跨升级活着：旧版本写下的那份缺什么，就当认不出
// 什么，不能当「没有」（gapOf）—— 没记列出的任务不等于没列任务（审查第 3 轮实测：升级前积压的助手回复按
// 空清单放行，发出了已经看不到的任务标题），没记 request 不等于实例就是请求进来那一刻（旧版本是办完才按
// 此刻的绑定盖的）。哪些行是回给请求的按 kind 列认：每一版都写这一列，来源 JSON 里的标记旧版本没有。
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { chatRooms, tasks } from "../db/schema.js";
import { imOutbox } from "../db/schema-im.js";
import { canSeeProject } from "../auth/visibility.js";
import { imActorFor } from "../auth/im-actor.js";
import type { Actor } from "../auth/context.js";
import { roomVisibleTo } from "../chat/route-access.js";
import { bindingOf, CHANNEL, ownerKeyOf, type BindingRow } from "./binding.js";
import { groupOf, groupRoomOf, type GroupRow } from "./groups.js";
import type { Destination, OutboxRow } from "./outbox.js";

/** 发起这条内容的那个人（群里的内容才记：单聊的收件人就是他自己；reply 两种都记）。 */
export interface Person { openId: string; boundAt: string }

/** 一次请求进来的那一刻：收件去处的绑定实例 + 发起的人。reply 按它在出口核。 */
export interface Origin { bound: string; by: Person }

export type ScopeBody =
  | { kind: "task"; taskId: string }
  | { kind: "project"; projectId: string }
  | { kind: "projects"; projectIds: string[] }
  | { kind: "room"; roomId: string; projectId: string | null; taskIds?: string[] }
  | { kind: "digest"; rowIds: string[] }
  | { kind: "reply"; projectId: string | null };

/**
 * bound = 入队时收件去处那一次绑定的 boundAt；null 只出现在旧版本入队、按 taskId 推出来的那种。
 * request = requestScope 写的（见顶部）：实例是请求进来那一刻的、正文列着的资源都记全了。
 * room 的 taskIds 缺 = 没记（旧版本，或投进房间时的那份底子 —— 回复来了才按回复填），不是「没列任务」。
 */
export type OutboxScope = { kind: "system" } | (ScopeBody & { bound: string | null; by?: Person; request?: true });

export const SYSTEM_SCOPE: OutboxScope = { kind: "system" };

export type Admission = { ok: true; titleOnly: boolean } | { ok: false; why: string };

const deny = (why: string): Admission => ({ ok: false, why });
const pass = (titleOnly = false): Admission => ({ ok: true, titleOnly });

/** 给一个收件去处盖上此刻的绑定实例（给此刻订阅者的通知用）。去处没有绑定时记空串 —— 出口一律不放行。 */
export async function scopeFor(appId: string, dest: Destination, body: ScopeBody, by?: BindingRow | null): Promise<OutboxScope> {
  const bound = dest.receiveType === "chat_id"
    ? (await groupOf(appId, dest.receiveId))?.boundAt
    : (await bindingOf(appId, dest.receiveId))?.boundAt;
  return {
    ...body,
    bound: bound ?? "",
    ...(by && dest.receiveType === "chat_id" ? { by: { openId: by.openId, boundAt: by.boundAt } } : {}),
  };
}

/**
 * 请求进来那一刻的来源。binding = 那一刻读到的发起人绑定（inbound.ts route、actions.ts handle）；群的实例也在这一刻读，
 * 之后不管操作办多久，回给他的那一句都按这一份核。单聊的收件人不是他本人（不该出现）记空串，出口一律不放行。
 */
export async function originOf(appId: string, dest: Destination, binding: Pick<BindingRow, "openId" | "boundAt">): Promise<Origin> {
  const bound = dest.receiveType === "chat_id"
    ? (await groupOf(appId, dest.receiveId))?.boundAt ?? ""
    : dest.receiveId === binding.openId ? binding.boundAt : "";
  return { bound, by: { openId: binding.openId, boundAt: binding.boundAt } };
}

/**
 * 已经盖好的来源（投进房间时按房间盖的那份，relay.ts）里记着的那一刻；单聊的收件人就是发起人。只认 requestScope 写的：
 * 旧版本那份是办完才按此刻的绑定盖的，拿它当「请求进来那一刻」就把认不出的来源洗成了可信的 —— 记空串，出口一律不放行。
 */
export function originOfScope(scope: OutboxScope, openId: string): Origin {
  if (scope.kind === "system" || scope.bound === null || scope.request !== true) return { bound: "", by: { openId, boundAt: "" } };
  return { bound: scope.bound, by: scope.by ?? { openId, boundAt: scope.bound } };
}

/** 回给一次请求的东西：按请求进来那一刻的来源盖（见顶部），不按办完时的现状。 */
export function requestScope(origin: Origin, body: ScopeBody): OutboxScope {
  return { ...body, bound: origin.bound, by: origin.by, request: true };
}

/** 回给一次请求的行：commands.ts 的回执（reply）和确认卡（confirm）、actions.ts 按钮没办成的原因（fail）。 */
const REQUEST_ROW_KINDS: readonly string[] = ["reply", "confirm", "fail"];
/** 给此刻订阅者的通知用的来源（reconcile.ts），写法从第一版起没变过；其余几种只该由 requestScope 写。 */
const SUBSCRIBER_SCOPES: readonly string[] = ["task", "digest"];

/** 这一行是不是回给一次请求的（核不过换成固定说明，exits.ts withhold）：按 kind 列认，旧版本的来源里没有标记。 */
export function answersRequest(row: Pick<OutboxRow, "scope" | "kind" | "taskId">): boolean {
  if (REQUEST_ROW_KINDS.includes(row.kind)) return true;
  const scope = scopeOfRow(row);
  return !!scope && scope.kind !== "system" && scope.request === true;
}

/**
 * 这份来源缺了放行要用的东西（见顶部）：返回缺的是什么，出口一律不放行。回给请求的（按行的 kind，或者来源本身
 * 只该由 requestScope 写）没有 request 标记 = 旧版本办完才盖的；列着资源的那几种，清单本身得在。
 */
function gapOf(row: Pick<OutboxRow, "kind">, scope: Exclude<OutboxScope, { kind: "system" }>): string | null {
  const requested = REQUEST_ROW_KINDS.includes(row.kind) || !SUBSCRIBER_SCOPES.includes(scope.kind);
  if (requested && scope.request !== true) return "旧版本入队，没记下是哪一次请求";
  switch (scope.kind) {
    case "room": return Array.isArray(scope.taskIds) ? null : "没记下列出的任务";
    case "projects": return Array.isArray(scope.projectIds) ? null : "没记下列出的项目";
    case "digest": return Array.isArray(scope.rowIds) ? null : "没记下列出的卡";
    case "reply": return scope.projectId === undefined ? "没记下是哪个项目" : null;
    default: return null;
  }
}

/**
 * 回给发话人的那一句（reply）：授权按请求进来那一刻（origin）；项目也按那一刻 —— 调用方在办之前算好，办着的时候任务被删了，
 * 出口照样核他还看不看得见那个项目（办完再查就查不到项目，核不了，审查对抗复核实测：删任务 + 移出项目，报错原文照发）。
 * 请求进来时任务就已经不在了才不挂项目。
 */
export async function replyScope(origin: Origin, about: { taskId?: string | null; projectId?: string | null }): Promise<OutboxScope> {
  const projectId = about.projectId ?? (about.taskId
    ? (await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, about.taskId))).at(0)?.projectId ?? null
    : null);
  return requestScope(origin, { kind: "reply", projectId });
}

/**
 * 行上记的授权来源。旧版本入队的行没有：上线通知 / 测试卡当 system，挂着任务的当 task（回给请求的推出来也过不了
 * gapOf：taskId 列只管回复路由到哪个任务，那句话不一定只说了这个任务），其余不认。
 */
export function scopeOfRow(row: Pick<OutboxRow, "scope" | "kind" | "taskId">): OutboxScope | null {
  if (row.scope) {
    try {
      return JSON.parse(row.scope) as OutboxScope;
    } catch {
      return null;
    }
  }
  if (row.kind === "online" || row.kind === "test") return SYSTEM_SCOPE;
  return row.taskId ? { kind: "task", taskId: row.taskId, bound: null } : null;
}

interface Viewer { group: GroupRow | null; actor: Actor | null; userKey: string | null }

/** 这一行此刻还能不能发到它的收件人、要不要换成只推标题的那一版。 */
export async function admit(appId: string, row: OutboxRow, titleOnly: readonly string[], nested = false): Promise<Admission> {
  const scope = scopeOfRow(row);
  if (!scope) return deny("没有授权来源（旧版本入队）");
  if (scope.kind === "system") return pass();
  const gap = gapOf(row, scope);
  if (gap) return deny(gap);
  const viewer = await viewerOf(appId, row, scope);
  if ("why" in viewer) return viewer;
  switch (scope.kind) {
    case "task": {
      const task = (await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, scope.taskId))).at(0);
      if (!task) return deny("任务已删除");
      return projectAdmission(viewer, task.projectId, titleOnly);
    }
    case "project":
      return projectAdmission(viewer, scope.projectId, titleOnly);
    case "projects": {
      if (viewer.group) return deny("个人的信息不发到群里");
      for (const projectId of scope.projectIds) {
        if (!(await projectAdmission(viewer, projectId, [])).ok) return deny("列出的某个项目已看不到了");
      }
      return pass();
    }
    case "room":
      return roomAdmission(appId, viewer, scope);
    case "reply":
      // 群里的这一句要认得出是谁发起的：旧版本入队的没记，不发原文。
      if (viewer.group && !viewer.actor) return deny("没记下是谁发起的");
      return scope.projectId ? projectAdmission(viewer, scope.projectId, titleOnly) : pass();
    case "digest": {
      if (nested) return deny("汇总里套汇总");
      for (const id of scope.rowIds) {
        const listed = (await db.select().from(imOutbox).where(eq(imOutbox.id, id))).at(0);
        if (listed && !(await admit(appId, listed, titleOnly, true)).ok) return deny("列出的某张卡已无权查看");
      }
      return pass();
    }
  }
  return deny("认不出的授权来源");
}

async function viewerOf(appId: string, row: OutboxRow, scope: Exclude<OutboxScope, { kind: "system" }>): Promise<Viewer | { ok: false; why: string }> {
  // 给此刻订阅者的任务通知不认实例（见顶部）；回给一次请求的、替某一个人做的都认那一次。
  const loose = scope.kind === "task" && !scope.request;
  const instance = loose ? null : scope.bound;
  if (row.receiveType === "chat_id") {
    const group = await groupOf(appId, row.receiveId);
    if (!group) return { ok: false, why: "群已解绑" };
    if (instance !== null && group.boundAt !== instance) return { ok: false, why: "群换过绑定" };
    if (!scope.by) return { group, actor: null, userKey: null };
    const person = await personOf(appId, scope.by.openId, loose ? null : scope.by.boundAt);
    return person ? { group, ...person } : { ok: false, why: "发起的人已解绑或换了绑定" };
  }
  const person = await personOf(appId, row.receiveId, instance);
  return person ? { group: null, ...person } : { ok: false, why: "收件人已解绑或换了绑定" };
}

async function personOf(appId: string, openId: string, boundAt: string | null): Promise<{ actor: Actor; userKey: string } | null> {
  const binding = await bindingOf(appId, openId);
  if (!binding || (boundAt !== null && binding.boundAt !== boundAt)) return null;
  const actor = await imActorFor({ channel: CHANNEL, appId, openId });
  return actor ? { actor, userKey: ownerKeyOf(binding.userId) } : null;
}

async function projectAdmission(viewer: Viewer, projectId: string, titleOnly: readonly string[]): Promise<Admission> {
  if (viewer.group && viewer.group.projectId !== projectId) return deny("群绑的已不是这个项目");
  if (viewer.actor && !await canSeeProject(viewer.actor, projectId)) return deny("看不到这个项目了");
  return pass(titleOnly.includes(projectId));
}

async function roomAdmission(
  appId: string, viewer: Viewer, scope: { roomId: string; projectId: string | null; taskIds?: string[] },
): Promise<Admission> {
  if (!viewer.actor) return deny("没有发起人");
  const room = (await db.select().from(chatRooms).where(eq(chatRooms.id, scope.roomId))).at(0);
  if (!room || !await roomVisibleTo(room, viewer.actor)) return deny("房间已不在或看不到了");
  if (viewer.group) {
    if (viewer.group.projectId !== scope.projectId || room.projectId !== scope.projectId) return deny("群绑的已不是这个项目");
    if (await groupRoomOf(appId, viewer.group.chatId, viewer.userKey ?? "") !== scope.roomId) return deny("这间已不是他在这个群里的房间");
  }
  // 回复下面列着的任务（标题 + 链接）：助手房间不限项目，列出来的可能在别的项目里。
  for (const taskId of scope.taskIds ?? []) {
    const task = (await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task) return deny("列出的任务已删除");
    if (!(await projectAdmission(viewer, task.projectId, [])).ok) return deny("列出的某个任务已看不到了");
  }
  return pass();
}

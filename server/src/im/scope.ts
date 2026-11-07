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
//   project    某个项目的内容（/new 的确认卡）；
//   principal  只属于这个人的（他能看哪些项目、他的当前项目）—— 只发单聊；
//   room       聊天房间里智能体的回复 —— 房间还在、还归他、他还看得见；群聊房间还要群还绑着那个项目、
//              这间还是他在这个群里的那一间；
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
// task 不认实例、只认此刻：任务的内容谁看得见项目谁就能看，换了绑定的人此刻能看就照发（决策卡的去处
// 本来就由对账按此刻的绑定算，recipients.ts）；其余几种是替某一个人做出来的东西，换了人就不给。
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
  | { kind: "principal" }
  | { kind: "room"; roomId: string; projectId: string | null }
  | { kind: "digest"; rowIds: string[] }
  | { kind: "reply"; projectId: string | null };

/** bound = 入队时收件去处那一次绑定的 boundAt；null 只出现在旧版本入队、按 taskId 推出来的那种。 */
export type OutboxScope = { kind: "system" } | (ScopeBody & { bound: string | null; by?: Person });

export const SYSTEM_SCOPE: OutboxScope = { kind: "system" };

export type Admission = { ok: true; titleOnly: boolean } | { ok: false; why: string };

const deny = (why: string): Admission => ({ ok: false, why });
const pass = (titleOnly = false): Admission => ({ ok: true, titleOnly });

/** 给一个收件去处盖上此刻的绑定实例。去处没有绑定时记空串 —— 出口一律不放行。 */
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

/** 已经盖好的来源（投进房间时按房间盖的那份，relay.ts）里记着的那一刻；单聊的收件人就是发起人。 */
export function originOfScope(scope: OutboxScope, openId: string): Origin {
  if (scope.kind === "system" || scope.bound === null) return { bound: "", by: { openId, boundAt: "" } };
  return { bound: scope.bound, by: scope.by ?? { openId, boundAt: scope.bound } };
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
  return { kind: "reply", projectId, bound: origin.bound, by: origin.by };
}

/** 行上记的授权来源。旧版本入队的行没有：上线通知 / 测试卡当 system，挂着任务的当 task，其余不认。 */
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
    case "principal":
      return viewer.group ? deny("个人的信息不发到群里") : pass();
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
}

async function viewerOf(appId: string, row: OutboxRow, scope: Exclude<OutboxScope, { kind: "system" }>): Promise<Viewer | { ok: false; why: string }> {
  const instance = scope.kind === "task" ? null : scope.bound;
  if (row.receiveType === "chat_id") {
    const group = await groupOf(appId, row.receiveId);
    if (!group) return { ok: false, why: "群已解绑" };
    if (instance !== null && group.boundAt !== instance) return { ok: false, why: "群换过绑定" };
    if (!scope.by) return { group, actor: null, userKey: null };
    const person = await personOf(appId, scope.by.openId, scope.kind === "task" ? null : scope.by.boundAt);
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

async function roomAdmission(appId: string, viewer: Viewer, scope: { roomId: string; projectId: string | null }): Promise<Admission> {
  if (!viewer.actor) return deny("没有发起人");
  const room = (await db.select().from(chatRooms).where(eq(chatRooms.id, scope.roomId))).at(0);
  if (!room || !await roomVisibleTo(room, viewer.actor)) return deny("房间已不在或看不到了");
  if (viewer.group) {
    if (viewer.group.projectId !== scope.projectId || room.projectId !== scope.projectId) return deny("群绑的已不是这个项目");
    if (await groupRoomOf(appId, viewer.group.chatId, viewer.userKey ?? "") !== scope.roomId) return deny("这间已不是他在这个群里的房间");
  }
  return pass();
}

// 交进来的两种清单怎么核（都是逐件核，有一件不对整批退回，不半收）：
//   · 智能体挂的一批（`normalizeSuggestions`，MCP suggest_dispatch）：标题、完整说明、一行为什么、交给谁、谁来审、
//     从哪开工、标签、同批 key 与前置，外加这一批的排法和要不要等用户；
//   · 用户按「派出去」交来的那几件（`normalizeSuggestionLaunch`）：此刻那一行上的样子。
// 收回（`normalizeWithdrawals`）要写明是哪一件、为什么：原因原样给用户看，是他知道「它为什么不在了」的唯一去处。
import { AGENT_TYPES, type AgentType } from "@navi/shared";
import type { DispatchRunTarget } from "@navi/shared/dispatch-target";
import {
  MAX_SUGGESTIONS_PER_CALL, MAX_SUGGESTION_NOTE_LEN, MAX_WITHDRAW_REASON_LEN,
  type DispatchOrder, type DispatchSuggestionLaunchItem, type DispatchSuggestionLaunchInput, type DispatchSuggestionWithdrawal,
  type DispatchWait, type StoredSuggestion,
} from "@navi/shared/dispatch-suggestion";
import { parseCreateReviewChoice, type CreateReviewChoice } from "@navi/shared/review-on-create";
import type { ExecutorScope } from "./auth/owned-executors.js";
import { batchPrerequisiteEdges } from "./prerequisite-routes.js";
import { id, now } from "./util.js";

type RawTarget = { agentType?: unknown; executorId?: unknown; model?: unknown; reasoningEffort?: unknown };
type RawItem = RawTarget & {
  key?: unknown; title?: unknown; body?: unknown; note?: unknown; base?: unknown;
  labels?: unknown; prerequisites?: unknown; review?: unknown;
};

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const stringArray = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;

/**
 * 一处「交给谁」收成那一行上的一格。都没给 = null（取这条任务「派出去的活交给谁」）；给了执行器就认它的类型，
 * 跟同处给的类型对不上算错（跟 batch_create_tasks 同一条口径）。看不见的执行器 id 归一成 null，按类型降级。
 */
export function normalizeTarget(raw: RawTarget, scope: ExecutorScope, where: string): DispatchRunTarget | null | { error: string } {
  const executorId = scope.keep(typeof raw.executorId === "string" && raw.executorId ? raw.executorId : undefined) ?? null;
  const executorType = scope.typeOf(executorId) ?? null;
  const agentType = typeof raw.agentType === "string" && raw.agentType ? raw.agentType : null;
  if (agentType && !AGENT_TYPES.includes(agentType as AgentType)) return { error: `${where}.agentType 未知: ${agentType}` };
  if (agentType && executorType && agentType !== executorType) {
    return { error: `${where}.executorId 属于 ${executorType}，但 agentType 是 ${agentType}` };
  }
  const type = (agentType ?? executorType) as AgentType | null;
  const model = text(raw.model) || null;
  const reasoningEffort = text(raw.reasoningEffort) || null;
  if (!type) {
    if (model || reasoningEffort) return { error: `${where} 给了模型或智能水平，就要同时给 agentType 或 executorId` };
    return null;
  }
  return { agentType: type, executorId, model, reasoningEffort };
}

/**
 * 一个接一个时，排在前面的那条不能等后面那条的成果：队列只放队首去跑，前面的等着后面的交成果，后面的又排不到，
 * 两条互相等住、谁都不开工。前置图本身无环也会这样，所以挂上来和派出去（那一下可以改成一个接一个）都按这一处核。
 */
export function serialOrderConflict(items: { title: string; key?: string; prerequisites?: string[] }[]): string | null {
  const position = new Map(items.flatMap((item, index) => (item.key ? [[item.key, index] as const] : [])));
  for (const [index, item] of items.entries()) {
    const later = item.prerequisites?.map((ref) => position.get(ref)).find((at) => at !== undefined && at > index);
    if (later !== undefined) return `「${item.title}」要等「${items[later]!.title}」先完成，可一个接一个时它排在前面，两条会互相等住`;
  }
  return null;
}

export type IncomingBatch = { items: StoredSuggestion[]; order: DispatchOrder; wait: DispatchWait };

/** 智能体交来要挂的一批。没给 tasks = 这一次只收回，交回空的一批。 */
export function normalizeSuggestions(body: { tasks?: unknown; order?: unknown; wait?: unknown }, scope: ExecutorScope): IncomingBatch | { error: string } {
  const order = body.order ?? "parallel";
  if (order !== "serial" && order !== "parallel") return { error: "order 只能是 parallel（同时）或 serial（一个接一个）" };
  const wait = body.wait ?? "none";
  if (wait !== "none" && wait !== "done" && wait !== "continue") return { error: "wait 只能是 none（不等）、done（等，派完就算完成）或 continue（等，派完把清单交给你）" };
  if (body.tasks === undefined || body.tasks === null) {
    return wait === "none" ? { items: [], order, wait } : { error: "wait 要等的是这一次挂上的活：tasks 不能为空" };
  }
  if (!Array.isArray(body.tasks)) return { error: "tasks 必须是数组" };
  if (wait !== "none" && !body.tasks.length) return { error: "wait 要等的是这一次挂上的活：tasks 不能为空" };
  if (body.tasks.length > MAX_SUGGESTIONS_PER_CALL) {
    return { error: `一次最多挂 ${MAX_SUGGESTIONS_PER_CALL} 件，收到 ${body.tasks.length} 件；拆成几批，或只挂最该做的` };
  }
  const at = now();
  const batch = id();
  const keys = new Set<string>();
  const items: StoredSuggestion[] = [];
  for (const [index, raw] of (body.tasks as RawItem[]).entries()) {
    const where = `tasks[${index}]`;
    if (!raw || typeof raw !== "object") return { error: `${where} 必须是对象` };
    const title = text(raw.title);
    const taskBody = text(raw.body);
    const note = text(raw.note);
    if (!title) return { error: `${where}.title 不能为空：框顶一行就是一个标题` };
    if (!taskBody) return { error: `${where}.body 不能为空：建出来的任务正文就是它，要自带完整上下文` };
    if (note.length > MAX_SUGGESTION_NOTE_LEN) return { error: `${where}.note 不超过 ${MAX_SUGGESTION_NOTE_LEN} 字；展开的话写进 body` };
    if (raw.base !== undefined && raw.base !== "trunk" && raw.base !== "here") {
      return { error: `${where}.base 只能是 trunk（从主分支开工）或 here（接着这条任务的代码）` };
    }
    const target = normalizeTarget(raw, scope, where);
    if (target && "error" in target) return target;
    const key = text(raw.key) || undefined;
    if (key && keys.has(key)) return { error: `${where}.key「${key}」跟前面的重复了` };
    if (key) keys.add(key);
    const labels = raw.labels === undefined ? undefined : stringArray(raw.labels);
    if (labels === null) return { error: `${where}.labels 要是字符串数组` };
    const prerequisites = raw.prerequisites === undefined ? undefined : stringArray(raw.prerequisites);
    if (prerequisites === null) return { error: `${where}.prerequisites 要是字符串数组` };
    const review = parseCreateReviewChoice(raw.review, `${where}.review`);
    if (review && typeof review === "object" && "error" in review) return review;
    items.push({
      id: id(), title, body: taskBody, note, target, base: raw.base === "here" ? "here" : "trunk", proposedAt: at,
      batch, order, wait, review: review ?? "default",
      ...(key ? { key } : {}),
      ...(labels?.length ? { labels } : {}),
      ...(prerequisites?.length ? { prerequisites } : {}),
    });
  }
  // 前置先核一遍形状（同一批里的 key、不自指），派出去那一下还会按那一刻留下的几件再核。
  const shape = batchPrerequisiteEdges(items, items.map((_item, index) => `#${index}`));
  if (typeof shape === "string") return { error: shape };
  const deadlock = order === "serial" ? serialOrderConflict(items) : null;
  if (deadlock) return { error: `${deadlock}：改成 parallel，或把被等的那条排到前面` };
  return { items, order, wait };
}

/** 智能体交来要收回的那几件。 */
export function normalizeWithdrawals(body: { withdraw?: unknown }): DispatchSuggestionWithdrawal[] | { error: string } {
  if (body.withdraw === undefined || body.withdraw === null) return [];
  if (!Array.isArray(body.withdraw)) return { error: "withdraw 必须是数组" };
  const picked = new Map<string, DispatchSuggestionWithdrawal>();
  for (const [index, raw] of (body.withdraw as { id?: unknown; reason?: unknown }[]).entries()) {
    const where = `withdraw[${index}]`;
    if (!raw || typeof raw !== "object") return { error: `${where} 必须是对象` };
    const suggestion = text(raw.id);
    const reason = text(raw.reason);
    if (!suggestion) return { error: `${where}.id 不能为空：挂的时候返回的那个 id（每次返回的 hanging 里也有）` };
    if (!reason) return { error: `${where}.reason 不能为空：用户靠这一句知道它为什么不在了` };
    if (reason.length > MAX_WITHDRAW_REASON_LEN) return { error: `${where}.reason 不超过 ${MAX_WITHDRAW_REASON_LEN} 字` };
    picked.set(suggestion, { id: suggestion, reason });
  }
  return [...picked.values()];
}

/** review / worktreeBase 没交 = 照那一件上记的。 */
export type LaunchPick = Omit<DispatchSuggestionLaunchItem, "review" | "worktreeBase"> & {
  target: DispatchRunTarget;
  review?: CreateReviewChoice;
  worktreeBase?: string | null;
};
export type LaunchRequest = { order: DispatchOrder; items: LaunchPick[]; attachments: string[] };

/** 用户交来的派出清单核一遍：每件写得齐、不重复、交给谁写得对。 */
export function normalizeSuggestionLaunch(body: Partial<DispatchSuggestionLaunchInput>, scope: ExecutorScope): LaunchRequest | { error: string } {
  const order = body.order ?? "parallel";
  if (order !== "serial" && order !== "parallel") return { error: "order 只能是 serial 或 parallel" };
  if (!Array.isArray(body.items) || !body.items.length) return { error: "一件都没选，派不出去" };
  const seen = new Set<string>();
  const items: LaunchPick[] = [];
  for (const [at, raw] of body.items.entries()) {
    const where = `items[${at}]`;
    if (!raw || typeof raw.id !== "string" || seen.has(raw.id)) return { error: `${where}.id 不对或重复了` };
    seen.add(raw.id);
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    const body = typeof raw.body === "string" ? raw.body.trim() : "";
    if (!title || !body) return { error: `「${title || "没写标题"}」的标题或说明是空的，派不出去` };
    const target = normalizeTarget(raw.target ?? {}, scope, `${where}.target`);
    if (!target) return { error: `${where}.target 要写明交给谁` };
    if ("error" in target) return target;
    if (raw.worktreeBase !== null && raw.worktreeBase !== undefined && typeof raw.worktreeBase !== "string") {
      return { error: `${where}.worktreeBase 要是分支名或 null` };
    }
    const review = parseCreateReviewChoice(raw.review, `${where}.review`);
    if (review && typeof review === "object" && "error" in review) return review;
    items.push({
      id: raw.id, title, body, target,
      ...(review ? { review } : {}),
      ...(typeof raw.extra === "string" ? { extra: raw.extra } : {}),
      ...(raw.worktreeBase !== undefined ? { worktreeBase: raw.worktreeBase?.trim() || null } : {}),
    });
  }
  const attachments = Array.isArray(body.attachments) ? body.attachments.filter((path): path is string => typeof path === "string") : [];
  return { order, items, attachments };
}

/** 派出去的这一件照什么审、从哪开工：用户这一下交了就照交的，没交照挂的时候说定的（再缺省是默认审查者、没指定起点）。 */
export function launchedSettings(pick: LaunchPick, item: StoredSuggestion): { review: CreateReviewChoice; worktreeBase: string | null } {
  return {
    review: pick.review ?? item.review ?? "default",
    worktreeBase: pick.worktreeBase !== undefined ? pick.worktreeBase : item.worktreeBase ?? null,
  };
}

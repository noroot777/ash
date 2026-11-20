// 派活单在服务端的那一半：智能体摆出来的清单怎么收（`normalizeProposal`）、写进 `task.question` 的那一句
// 清单长什么样（`planQuestionText`），以及「派出去」那一下按卡上此刻的样子留下的两段话——问答记录里
// 用户答的那一句（`launchBubble`）和续上智能体会话的那段答复（`launchReply`）。路由在 dispatch-plan-routes.ts，
// 建任务那一下在 dispatch-plan-launch.ts。
//
// 为什么是 navi 建、不是让智能体再调一次工具：用户在卡上换的人、去掉的条、选的一个接一个 / 同时，
// 只有照着卡建才保证「看到的就是派出去的」。智能体续上时拿到的是已经建好的清单，它不必、也不该再建一遍。
import { AGENT_TYPES, type AgentType } from "@navi/shared";
import {
  DISPATCH_LAUNCH_REPLY_LEAD, DISPATCH_ORDER_LABEL, MAX_DISPATCH_NOTE_LEN, MAX_DISPATCH_PLAN_ITEMS,
  type DispatchAfterLaunch, type DispatchOrder, type DispatchPlan, type DispatchPlanItem, type DispatchRunTarget,
} from "@navi/shared/dispatch-plan";
import { parseCreateReviewChoice, type CreateReviewChoice } from "@navi/shared/review-on-create";
import type { ExecutorScope } from "./auth/owned-executors.js";
import { id, now } from "./util.js";

export const DISPATCH_PLAN_BLOCKS_ASK =
  "这一回合已经摆了派活单在等用户过目，不能再提问：同一时刻只等用户一样东西。要问的话写进派活单的备注里，或等用户回了再问";
export const QUESTION_BLOCKS_PLAN =
  "这条任务已经有一个提问在等用户答复，不能再摆派活单：同一时刻只等用户一样东西。等用户答了再摆";

type RawTarget = { agentType?: unknown; executorId?: unknown; model?: unknown; reasoningEffort?: unknown };
type RawItem = RawTarget & {
  key?: unknown; title?: unknown; body?: unknown; note?: unknown;
  useWorktree?: unknown; worktreeBase?: unknown; mergeTargetBranch?: unknown; labels?: unknown; prerequisites?: unknown;
  review?: unknown;
};

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const optionalText = (value: unknown): string | null | undefined =>
  value === undefined ? undefined : value === null ? null : typeof value === "string" ? value.trim() || null : undefined;
const stringArray = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;

/**
 * 一处「交给谁」收成卡上那一格。都没给 = null（卡上那一格取这条任务的默认值）；给了执行器就认它的类型，
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

/** 智能体交来的一批：逐条核，有一条不对整批退回，不半收。 */
/**
 * 一个接一个时，排在前面的那条不能等后面那条的成果：队列只放队首去跑，前面的等着后面的交成果，后面的又排不到，
 * 两条互相等住、谁都不开工。前置图本身无环也会这样，所以摆单和派出（卡上可以把「同时」改成「一个接一个」）
 * 都按这一处核。同批之外的已有任务不在队列里，不受影响。
 */
export function serialOrderConflict(items: { title: string; key?: string; prerequisites?: string[] }[]): string | null {
  const position = new Map(items.flatMap((item, index) => (item.key ? [[item.key, index] as const] : [])));
  for (const [index, item] of items.entries()) {
    const later = item.prerequisites?.map((ref) => position.get(ref)).find((at) => at !== undefined && at > index);
    if (later !== undefined) return `「${item.title}」要等「${items[later]!.title}」先完成，可一个接一个时它排在前面，两条会互相等住`;
  }
  return null;
}

export function normalizeProposal(
  body: { order?: unknown; tasks?: unknown; afterLaunch?: unknown },
  scope: ExecutorScope,
): { order: DispatchOrder; items: DispatchPlanItem[]; afterLaunch: DispatchAfterLaunch } | { error: string } {
  const order = body.order === undefined ? "serial" : body.order;
  if (order !== "serial" && order !== "parallel") return { error: "order 只能是 serial（一个接一个）或 parallel（同时）" };
  const afterLaunch = body.afterLaunch === undefined ? "done" : body.afterLaunch;
  if (afterLaunch !== "done" && afterLaunch !== "continue") {
    return { error: "afterLaunch 只能是 done（派出去就算完成）或 continue（派出去后还要接着做）" };
  }
  if (!Array.isArray(body.tasks) || !body.tasks.length) return { error: "tasks 不能为空" };
  if (body.tasks.length > MAX_DISPATCH_PLAN_ITEMS) {
    return { error: `一张派活单最多 ${MAX_DISPATCH_PLAN_ITEMS} 条，收到 ${body.tasks.length} 条；拆成几批摆` };
  }
  const items: DispatchPlanItem[] = [];
  const keys = new Set<string>();
  for (const [index, raw] of (body.tasks as RawItem[]).entries()) {
    const where = `tasks[${index}]`;
    if (!raw || typeof raw !== "object") return { error: `${where} 必须是对象` };
    const title = text(raw.title);
    const taskBody = text(raw.body);
    const note = text(raw.note);
    if (!title) return { error: `${where}.title 不能为空：卡上一行就是一个标题` };
    if (!taskBody) return { error: `${where}.body 不能为空：建出来的任务正文就是它` };
    if (note.length > MAX_DISPATCH_NOTE_LEN) return { error: `${where}.note 是标题下那一行小字，不超过 ${MAX_DISPATCH_NOTE_LEN} 字；展开的话写进 body` };
    const target = normalizeTarget(raw, scope, where);
    if (target && "error" in target) return target;
    const key = text(raw.key) || undefined;
    if (key && keys.has(key)) return { error: `${where}.key「${key}」跟前面的重复了` };
    if (key) keys.add(key);
    const labels = raw.labels === undefined ? undefined : stringArray(raw.labels);
    if (labels === null) return { error: `${where}.labels 要是字符串数组` };
    const prerequisites = raw.prerequisites === undefined ? undefined : stringArray(raw.prerequisites);
    if (prerequisites === null) return { error: `${where}.prerequisites 要是字符串数组` };
    if (raw.useWorktree !== undefined && typeof raw.useWorktree !== "boolean") return { error: `${where}.useWorktree 要是布尔值` };
    const worktreeBase = optionalText(raw.worktreeBase);
    const mergeTargetBranch = optionalText(raw.mergeTargetBranch);
    const review = parseCreateReviewChoice(raw.review, `${where}.review`);
    if (review && typeof review === "object" && "error" in review) return review;
    items.push({
      ...(key ? { key } : {}),
      title, body: taskBody, note, target, review: review ?? "default",
      ...(raw.useWorktree !== undefined ? { useWorktree: raw.useWorktree as boolean } : {}),
      ...(worktreeBase !== undefined ? { worktreeBase } : {}),
      ...(mergeTargetBranch !== undefined ? { mergeTargetBranch } : {}),
      ...(labels?.length ? { labels } : {}),
      ...(prerequisites?.length ? { prerequisites } : {}),
    });
  }
  const deadlock = order === "serial" ? serialOrderConflict(items) : null;
  if (deadlock) return { error: `${deadlock}：改成 parallel，或把被等的那条排到前面` };
  return { order, items, afterLaunch };
}

/** 交给谁读成一个名字：执行器名，没有就类型名；模型、智能水平跟在后面。 */
export type TargetLabel = (target: DispatchRunTarget) => string;

/**
 * 写进 `task.question` 的那一句。网页上画成卡，这句话是给不认识这张卡的地方看的（手机、飞书、问答历史
 * 里的引文）：看得出它在等什么，回一句话就是「发回去改」。
 */
export function planQuestionText(order: DispatchOrder, items: DispatchPlanItem[], who: (item: DispatchPlanItem) => string): string {
  const lines = items.map((item, index) => `${index + 1}. ${item.title}${item.note ? ` —— ${item.note}` : ""}（交给 ${who(item)}）`);
  return [`派出这 ${items.length} 个任务（${DISPATCH_ORDER_LABEL[order]}）：`, ...lines].join("\n");
}

export function newPlan(order: DispatchOrder, items: DispatchPlanItem[], question: string, afterLaunch: DispatchAfterLaunch): DispatchPlan {
  return { id: id(), question, order, items, afterLaunch, proposedAt: now() };
}

const sameTarget = (left: DispatchRunTarget | null, right: DispatchRunTarget | null) =>
  !!left && !!right && left.agentType === right.agentType && (left.executorId ?? null) === (right.executorId ?? null)
  && (left.model ?? null) === (right.model ?? null) && (left.reasoningEffort ?? null) === (right.reasoningEffort ?? null);

/** review：用户在卡上那一格的样子；没交 = 照单子上的（再缺省是默认审查者）。 */
export type LaunchPick = { index: number; target: DispatchRunTarget; review: CreateReviewChoice };

/**
 * 问答记录里用户答的那一句：「派出这 N 个任务」，下一行一句改动——一个接一个还是同时、第几条换了人、
 * 去掉了哪几条。第几条按派出去的顺序数（卡上去掉一条之后，下面的序号跟着往上补）。
 */
export function launchBubble(
  plan: DispatchPlan,
  order: DispatchOrder,
  picks: LaunchPick[],
  proposedOf: (item: DispatchPlanItem) => DispatchRunTarget | null,
  label: TargetLabel,
): string {
  const kept = new Set(picks.map((pick) => pick.index));
  const changes = [DISPATCH_ORDER_LABEL[order]];
  picks.forEach((pick, at) => {
    if (!sameTarget(proposedOf(plan.items[pick.index]!), pick.target)) changes.push(`第 ${at + 1} 条交给 ${label(pick.target)}`);
  });
  const dropped = plan.items.filter((_item, index) => !kept.has(index));
  if (dropped.length) changes.push(`去掉了${dropped.map((item) => `「${item.title}」`).join("")}`);
  return `派出这 ${picks.length} 个任务\n${changes.join(" · ")}`;
}

/**
 * 交给智能体的那段话：建好了哪几条（任务号、标题、交给了谁），去掉了哪几条，别再建一遍。`settledDone` = 派出去
 * 就算完成（`afterLaunch: "done"`）：这段不是续上会话的答复，是它下一回合开头才收到的补交，所以不带【答复】、
 * 写明这条任务已经替它结成了完成。两种都以 `DISPATCH_LAUNCH_REPLY_LEAD` 开头，会话里据此认出它、不画成气泡。
 */
export function launchReply(
  order: DispatchOrder,
  launched: { id: string; title: string; target: DispatchRunTarget }[],
  dropped: DispatchPlanItem[],
  label: TargetLabel,
  settledDone = false,
): string {
  const lines = launched.map((task, index) => `${index + 1}. ${task.id}「${task.title}」→ ${label(task.target)}`);
  const built = `${DISPATCH_LAUNCH_REPLY_LEAD}Navi 已照${settledDone ? "你上次摆的" : ""}派活单此刻的样子建好下面 ${launched.length} 个任务`
    + `（${DISPATCH_ORDER_LABEL[order]}），挂在本任务名下、已交给调度（可能还在等名额、等前置或排队）。`;
  return [
    ...(settledDone ? [] : ["【答复】"]),
    built
      + (settledDone ? "本任务按你摆单时说定的（派出去就算完成）随即结成了完成，当时没有叫醒你。" : "")
      + "不要再调用建任务的工具重复建；要看进度用 list_tasks / get_task。",
    ...lines,
    ...(dropped.length ? [`用户去掉了：${dropped.map((item) => `「${item.title}」`).join("、")}（没有建）`] : []),
  ].join("\n");
}

/** 一条交给 navi 的派出清单核一遍：留下的行在单子里、不重复、交给谁写得对。 */
export function normalizeLaunch(
  plan: DispatchPlan,
  body: { planId?: unknown; order?: unknown; items?: unknown },
  scope: ExecutorScope,
): { order: DispatchOrder; picks: LaunchPick[] } | { error: string; status: 400 | 409 } {
  if (body.planId !== plan.id) return { error: "派活单已经换了一张，请看最新的那张再派", status: 409 };
  const order = body.order;
  if (order !== "serial" && order !== "parallel") return { error: "order 只能是 serial 或 parallel", status: 400 };
  if (!Array.isArray(body.items) || !body.items.length) return { error: "一条都没留，派不出去；写一句发回去改", status: 400 };
  const seen = new Set<number>();
  const picks: LaunchPick[] = [];
  for (const [at, raw] of (body.items as { index?: unknown; target?: RawTarget; review?: unknown }[]).entries()) {
    const index = raw?.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= plan.items.length || seen.has(index)) {
      return { error: `items[${at}].index 不在这张派活单里`, status: 400 };
    }
    seen.add(index);
    const target = normalizeTarget(raw.target ?? {}, scope, `items[${at}].target`);
    if (!target) return { error: `items[${at}].target 要写明交给谁`, status: 400 };
    if ("error" in target) return { ...target, status: 400 };
    const review = parseCreateReviewChoice(raw.review, `items[${at}].review`);
    if (review && typeof review === "object" && "error" in review) return { ...review, status: 400 };
    picks.push({ index, target, review: review ?? plan.items[index]!.review ?? "default" });
  }
  return { order, picks };
}

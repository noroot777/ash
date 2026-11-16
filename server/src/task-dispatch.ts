// 「派它的那条任务」（tasks.dispatched_by）：普通任务里派出去的独立任务收在谁名下。
//
// 这层关系原来只活在 creation_origin 那条审计记录里（`{kind:"agent", taskId}`），侧栏、详情页
// 一处都看不见。它跟 parentId 是两回事：parentId 是团队执行者 —— 不进顶层列表、共用调度台的
// 目录、跟团队一起验收；派出去的任务仍是完整独立的任务（自己的 worktree、审查、验收），只是
// 在界面上收在派它的那条下面。所以单开一列，parentId 的语义一处不碰。
//
// 规则只有一句：**从哪条任务里出来的，就收在哪条下面。**
//
// 判据（新建与存量回填同一份，回填的 SQL 在 db/migrate-dispatched-by.ts）：
//   · 显式给了 dispatchedBy（用户从回复框派出去、派活单）→ 以它为准；
//   · 系统替用户从一条任务里切出来的（裁定「转成独立任务」、合并结果审查的修复任务）→ 记来源那条
//     （carvedOutUnder）。它不是谁派的：任务头照旧说「来自任务」，执行器照来源那条，不问来源
//     「派出去的活交给谁」的默认值。认它的事实前后端同一个（isCarvedOut、web/src/lib/taskParent.ts）：
//     **系统建的**、而且收在自己的来源（originTaskId）名下。光看后半句不够 —— 那只说明挂在哪、
//     回链到哪：你或智能体派出去的普通任务也可以同时回链到派它的那条，那仍是派出去的活。创建来源
//     是服务端自己记的（建任务的接口只会记成用户 / 智能体），所以前半句冒充不了；
//   · 否则看创建来源：智能体在某条任务的回合里建的，且那条任务是普通的独立任务（不是团队调度台、
//     不是讨论、也不是团队执行者）、新任务自己也是普通任务、不是团队执行者 → 记那条任务。
// 两头都得是独立的普通任务：团队执行者（mode 也是 single，靠 parentId 认）另建的任务若记在它
// 名下，执行者详情里就会冒出「派出的任务」，团队那一侧就变了样。
// 团队调度台用 MCP 另建的任务不收进来：团队行底下已经是它的执行者，再挂一层就改了团队在
// 侧栏的样子（这一轮团队、讨论两种模式不动）。
import { eq, inArray } from "drizzle-orm";
import { parseTaskCreationOrigin } from "@ash/shared/task-origin";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import type { Actor } from "./auth/context.js";
import { canSeeProject } from "./auth/visibility.js";
import { executorScopeForOwner } from "./auth/owned-executors.js";
import { dispatchDefaultTarget, parseDispatchTarget } from "@ash/shared/dispatch-plan";
import type { AgentType } from "@ash/shared";

type DispatchCandidate = {
  id: string;
  parentId?: string | null;
  mode?: string | null;
  creationOrigin?: string | null;
  dispatchedBy?: string | null;
};

/** 能收在别人名下的：普通任务、不是团队执行者。 */
function canBeDispatched(row: { mode?: string | null; parentId?: string | null }): boolean {
  return !row.parentId && (row.mode ?? "single") === "single";
}

/** 来源记录里认得出的派活人（还没查它是不是普通任务）。 */
function originDispatcher(row: DispatchCandidate): string | null {
  if (!canBeDispatched(row)) return null;
  const origin = parseTaskCreationOrigin(row.creationOrigin ?? null);
  if (origin?.kind !== "agent" || !origin.taskId || origin.taskId === row.id) return null;
  return origin.taskId;
}

/** 能当派活人的：普通的独立任务（团队调度台、讨论、团队执行者都不算）。 */
function canDispatch(source: { mode: string | null; parentId: string | null }): boolean {
  return source.mode === "single" && !source.parentId;
}

/**
 * 从 source 里切出来的那一行收在谁名下：两头都是独立的普通任务就是 source，否则不收（来源是团队
 * 执行者 / 讨论 / 团队调度台时，各自那一侧的样子不动）。建任务的那两条路拿它包一下待建的行。
 */
export function carvedOutUnder<T extends { mode?: string | null; parentId?: string | null }>(
  source: { id: string; mode: string | null; parentId: string | null },
  row: T,
): T & { dispatchedBy: string | null } {
  return { ...row, dispatchedBy: canDispatch(source) && canBeDispatched(row) ? source.id : null };
}

/** 切出来的 = 系统建的、收在自己的来源名下（文件头）。创建来源要的是落库的那一份（createTasks 已补上缺省）。 */
function isCarvedOut(
  row: { originTaskId?: string | null; creationOrigin?: string | null },
  dispatchedBy: string | null | undefined,
): boolean {
  return !!dispatchedBy && row.originTaskId === dispatchedBy
    && parseTaskCreationOrigin(row.creationOrigin ?? null)?.kind === "system";
}

/** 一批待建的行各自归在谁名下。显式给了的（含 null）原样留着。 */
export async function resolveDispatchedBy(rows: DispatchCandidate[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const pending = new Map<string, string>();
  for (const row of rows) {
    if (row.dispatchedBy !== undefined) result.set(row.id, row.dispatchedBy ?? null);
    else {
      const source = originDispatcher(row);
      if (source) pending.set(row.id, source);
      else result.set(row.id, null);
    }
  }
  const sourceIds = [...new Set(pending.values())];
  const sources = sourceIds.length
    ? await db.select({ id: tasks.id, mode: tasks.mode, parentId: tasks.parentId }).from(tasks).where(inArray(tasks.id, sourceIds))
    : [];
  const singles = new Set(sources.filter(canDispatch).map((source) => source.id));
  for (const [rowId, source] of pending) result.set(rowId, singles.has(source) ? source : null);
  return result;
}

/**
 * `POST /tasks` 显式给的 dispatchedBy 能不能收。派活人可以在别的项目里（派到另一个仓库去
 * 干活），所以不走同项目判据，只要求看得见、是普通的独立任务；团队执行者自有归属（parentId），
 * 既不当派活人，也不收第二层。「看不见」与「不存在」回同一句话，免得这里变成 id 探测器。
 */
export async function dispatcherRefusal(
  actor: Actor,
  body: { dispatchedBy?: string | null; parentId?: string | null; mode?: string | null },
): Promise<{ status: 400 | 404; body: Record<string, unknown> } | null> {
  if (!body.dispatchedBy) return null;
  const dispatcher = (await db.select({ projectId: tasks.projectId, mode: tasks.mode, parentId: tasks.parentId })
    .from(tasks).where(eq(tasks.id, body.dispatchedBy))).at(0);
  if (!dispatcher || !(await canSeeProject(actor, dispatcher.projectId))) {
    return { status: 404, body: { error: "task not found", dispatchedBy: body.dispatchedBy } };
  }
  if (!canDispatch(dispatcher) || !canBeDispatched(body)) {
    return { status: 400, body: { error: "只有普通任务能收派出去的普通任务", dispatchedBy: body.dispatchedBy } };
  }
  return null;
}

/**
 * 没指明交给谁的那几行，交给派它的那条任务「派出去的活交给谁」的默认值（`dispatchDefaultTarget`：
 * 设了就是设的那个，没设就同这条任务自己）。智能体绕过派活单直接 batch_create_tasks / create_task_chain、
 * 又没给 agentType / executorId 时走的就是这一条；指明了的（含只给了类型的）一个字不碰。
 * 切出来的那几行（isCarvedOut）也不碰：它们不是派出去的活，执行器照来源那条 —— 来源自己两样都
 * 空着（跟随默认）时，行上也空着，不能被当成「没指明」。
 *
 * 执行器是个人面资源：默认值里那个 id 归属人看不见就当没给，按类型默认执行器降级（同建任务的口径）。
 */
export async function withDispatchDefaults<T extends {
  id: string;
  agentType?: string | null;
  executorId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  ownerUserId?: string | null;
  originTaskId?: string | null;
  creationOrigin?: string | null;
}>(rows: T[], dispatchedBy: Map<string, string | null>): Promise<T[]> {
  const unassigned = (row: T) => !row.agentType && !row.executorId && !isCarvedOut(row, dispatchedBy.get(row.id));
  const open = rows.filter((row) => unassigned(row) && dispatchedBy.get(row.id));
  if (!open.length) return rows;
  const sourceIds = [...new Set(open.map((row) => dispatchedBy.get(row.id)!))];
  const sources = await db.select({
    id: tasks.id, agentType: tasks.agentType, executorId: tasks.executorId, model: tasks.model,
    reasoningEffort: tasks.reasoningEffort, dispatchTarget: tasks.dispatchTarget,
  }).from(tasks).where(inArray(tasks.id, sourceIds));
  const defaults = new Map(sources.map((source) => [source.id, dispatchDefaultTarget({
    ...source,
    agentType: source.agentType as AgentType | null,
    dispatchTarget: parseDispatchTarget(source.dispatchTarget),
  })] as const));
  const scopes = new Map<string | null, Awaited<ReturnType<typeof executorScopeForOwner>>>();
  const scopeOf = async (owner: string | null) => {
    if (!scopes.has(owner)) scopes.set(owner, await executorScopeForOwner(owner));
    return scopes.get(owner)!;
  };
  return Promise.all(rows.map(async (row) => {
    if (!unassigned(row)) return row;
    const source = dispatchedBy.get(row.id);
    const target = source ? defaults.get(source) : null;
    if (!target) return row;
    const executorId = (await scopeOf(row.ownerUserId ?? null)).keep(target.executorId) ?? null;
    return {
      ...row,
      agentType: target.agentType,
      executorId,
      model: row.model ?? target.model,
      reasoningEffort: row.reasoningEffort ?? target.reasoningEffort,
    };
  }));
}

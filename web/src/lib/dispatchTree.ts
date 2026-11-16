import type { TaskListItem } from "@ash/shared";
import { awaitsRuling, hasFailed } from "./taskAttention.ts";

// 「派它的那条任务」（Task.dispatchedBy）在前端的几样读法：谁名下有谁、整棵往下算有没有要你
// 处理的。侧栏的收纳（workspace/dispatchForest.ts）、侧栏那个数、详情页右侧「派出的任务」那一格
// 都从这里取，判据只有一份。
//
// 跟团队执行者（parentId）不是一回事：派出去的任务是完整独立的任务，只是收在派它的那条下面。

export function byCreated(a: Pick<TaskListItem, "createdAt">, b: Pick<TaskListItem, "createdAt">): number {
  return a.createdAt.localeCompare(b.createdAt);
}

/** 名下整棵往下（不含自己）。脏数据成环时每条只走一次。 */
export function dispatchSubtree<T extends { id: string }>(children: ReadonlyMap<string, readonly T[]>, taskId: string): T[] {
  const seen = new Set([taskId]);
  const result: T[] = [];
  const stack = [...(children.get(taskId) ?? [])];
  while (stack.length) {
    const next = stack.shift()!;
    if (seen.has(next.id)) continue;
    seen.add(next.id);
    result.push(next);
    stack.push(...(children.get(next.id) ?? []));
  }
  return result;
}

/** 需要你处理的那几种：在等答复、等你裁定、失败（含验证没过）。只有它们在「派出的任务」里带颜色。 */
export function dispatchNeedsYou(task: TaskListItem): boolean {
  return !!task.question || awaitsRuling(task) || hasFailed(task);
}

/**
 * 这条边在不在派活关系里：记着派活人、不是团队执行者、不是自己派自己。**不看归档**：归档是
 * 「这一条我不用再看了」，不是「它名下那几条跟上面断了」—— 中间那条归档了，它底下还在跑、
 * 还失败着的那条照样是上面那条派出去的活。
 */
function isDispatchEdge(task: TaskListItem): task is TaskListItem & { dispatchedBy: string } {
  return !!task.dispatchedBy && !task.parentId && task.dispatchedBy !== task.id;
}

/** 列出来、算进数里的那几条：关系里的、而且没归档。 */
function isListedDispatch(task: TaskListItem): task is TaskListItem & { dispatchedBy: string } {
  return isDispatchEdge(task) && !task.archived;
}

/** 一条任务直接派出去的那几条（没归档的，按派出的先后）。只问一条时用它，省得建整张表。 */
export function dispatchedOf(tasks: readonly TaskListItem[], taskId: string): TaskListItem[] {
  return tasks.filter((task) => isListedDispatch(task) && task.dispatchedBy === taskId).sort(byCreated);
}

/**
 * 关系事实：名下直接派了几条、整棵往下有没有要你处理的。**从全量任务算**，不从侧栏此刻画出来的
 * 那批行算 —— 筛选（状态）、置顶、作用域只决定画哪几行，改不了「它名下有一条失败了」这件事。
 *
 * 两个判据分开：**能不能顺着往下走**看边（isDispatchEdge，归档的照样走得过去），**算不算、
 * 要不要你处理**看那一条自己（没归档的才算）。数字与右侧「派出的任务」那一格同一个口径
 * （dispatchedOf）；名下直接的那几条全归档了、底下还有一条失败着，数是 0、照样变色。
 */
export type DispatchFacts = {
  count: (taskId: string) => number;
  needsYou: (taskId: string) => boolean;
  /** 名下整棵往下还有没归档的（中间那层归档了也算）：有就是父任务，行尾要有那句短语。 */
  hasBelow: (taskId: string) => boolean;
};

/**
 * 一行带不带那个数、变不变色：名下整棵往下还有没归档的才带（直接那几条全归档了、更底下还有，数是 0
 * 也带着），整棵往下有要你处理的就变色。右侧「派出的任务」格里的一行用它，口径同侧栏那一行
 * （workspace/DispatchTreeRows.tsx：hasBelow 定是不是父任务，count / needsYou 定那个数和颜色）。
 */
export function dispatchTally(facts: DispatchFacts, taskId: string): { count: number; warn: boolean } | null {
  return facts.hasBelow(taskId) ? { count: facts.count(taskId), warn: facts.needsYou(taskId) } : null;
}

/** 那个数念出来的那句（数本身只给眼睛看）。 */
export function dispatchTallySaid(tally: { count: number; warn: boolean }): string {
  return `${tally.count} 个派出的任务${tally.warn ? "，有要你处理的" : ""}`;
}

/** 「派活人 id → 它直接派出去的那几条」，含归档的（能不能往下走只看边，见 isDispatchEdge）。 */
export function dispatchEdges(tasks: readonly TaskListItem[]): Map<string, TaskListItem[]> {
  const edges = new Map<string, TaskListItem[]>();
  for (const task of tasks) {
    if (!isDispatchEdge(task)) continue;
    const bucket = edges.get(task.dispatchedBy);
    if (bucket) bucket.push(task);
    else edges.set(task.dispatchedBy, [task]);
  }
  return edges;
}

export function dispatchFacts(tasks: readonly TaskListItem[]): DispatchFacts {
  const edges = dispatchEdges(tasks);
  const needs = new Map<string, boolean>();
  const below = new Map<string, boolean>();
  return {
    hasBelow: (taskId) => {
      const known = below.get(taskId);
      if (known !== undefined) return known;
      const result = dispatchSubtree(edges, taskId).some((task) => !task.archived);
      below.set(taskId, result);
      return result;
    },
    count: (taskId) => edges.get(taskId)?.filter((task) => !task.archived).length ?? 0,
    needsYou: (taskId) => {
      const known = needs.get(taskId);
      if (known !== undefined) return known;
      const result = dispatchSubtree(edges, taskId).some((task) => !task.archived && dispatchNeedsYou(task));
      needs.set(taskId, result);
      return result;
    },
  };
}

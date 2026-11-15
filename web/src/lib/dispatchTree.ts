import type { TaskListItem } from "@ash/shared";
import { hasFailed } from "./taskAttention.ts";

// 「派它的那条任务」（Task.dispatchedBy）在前端的几样读法：谁名下有谁、整棵往下算有没有要你
// 处理的。侧栏的收纳（workspace/dispatchForest.ts）、详情页右侧
// 「派出的任务」那一格都从这里取，判据只有一份。
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

/** 需要你处理的那几种：在等答复、失败（含验证没过）。只有它们在「派出的任务」里带颜色。 */
export function dispatchNeedsYou(task: Pick<TaskListItem, "question" | "status" | "stage">): boolean {
  return !!task.question || hasFailed(task);
}

/** 一条任务直接派出去的那几条（没归档的，按派出的先后）。只问一条时用它，省得建整张表。 */
export function dispatchedOf(tasks: readonly TaskListItem[], taskId: string): TaskListItem[] {
  return tasks
    .filter((task) => task.dispatchedBy === taskId && !task.archived && !task.parentId && task.id !== taskId)
    .sort(byCreated);
}

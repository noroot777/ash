import type { TaskListItem } from "@navi/shared";
import { dispatchSubtree } from "./dispatchTree.ts";

// 「名下全部停下」在前端的读法：这条任务被谁按住了、它名下此刻还有没有在动的。判据跟服务端
// （server/src/task-hold.ts）同一个：顺着 dispatchedBy 往上，第一条带 dispatchHoldAt 的就是按住它的
// 那条（不含自己）；名下整棵往下算，归档的照样走得过去。数据就是任务列表本身，随 SSE 合并，
// 别的窗口按了停 / 接着跑，这里不用刷新就跟着变。

type Row = Pick<TaskListItem, "id" | "dispatchedBy" | "dispatchHoldAt" | "parentId">;

/** 按住这一条的那条任务；没被按住（或那条不在列表里）是 null。成环时每条只走一次。 */
export function dispatchHolderOf<T extends Row>(taskId: string, byId: ReadonlyMap<string, T>): T | null {
  const seen = new Set([taskId]);
  let next = byId.get(taskId)?.dispatchedBy ?? null;
  while (next && !seen.has(next)) {
    seen.add(next);
    const up = byId.get(next);
    if (!up) return null;
    if (up.dispatchHoldAt) return up;
    next = up.dispatchedBy ?? null;
  }
  return null;
}

/** 名下（整棵往下）有在跑或排着的吗 —— 没有就不出「全部停下」。 */
export function dispatchedLive(tasks: readonly TaskListItem[], taskId: string): boolean {
  const children = new Map<string, TaskListItem[]>();
  for (const task of tasks) {
    if (!task.dispatchedBy || task.parentId || task.dispatchedBy === task.id) continue;
    const bucket = children.get(task.dispatchedBy);
    if (bucket) bucket.push(task);
    else children.set(task.dispatchedBy, [task]);
  }
  return dispatchSubtree(children, taskId).some((task) => task.status === "running" || task.status === "queued");
}

/**
 * 格头那颗键此刻是哪一颗：hold = 全部停下、release = 接着跑、retry = 再停一次（按了停、还没停完，
 * 服务端在补停 —— 这时给「接着跑」就是把没停下的当成停好了）；null = 不出（没停着、名下也没在动的）。
 */
export function dispatchHoldKey(task: Pick<TaskListItem, "dispatchHoldAt" | "dispatchHoldPendingAt">, live: boolean): "hold" | "release" | "retry" | null {
  if (task.dispatchHoldAt) return task.dispatchHoldPendingAt ? "retry" : "release";
  return live ? "hold" : null;
}

export function dispatchHoldPhrase(holder: Pick<TaskListItem, "title">): string {
  return `「${holder.title || "未命名任务"}」名下已全部停下`;
}

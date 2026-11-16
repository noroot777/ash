import type { TaskListItem } from "@ash/shared";
import { dispatchedOf } from "../../lib/dispatchTree.ts";

export type DispatchArrivals = {
  taskId: string;
  enteredAt: number;
  seen: ReadonlySet<string>;
  revision: number;
};

export function startDispatchArrivals(taskId: string, tasks: readonly TaskListItem[], enteredAt: number): DispatchArrivals {
  return { taskId, enteredAt, seen: new Set(tasks.map((task) => task.id)), revision: 0 };
}

export function observeDispatchArrivals(current: DispatchArrivals, tasks: readonly TaskListItem[]): DispatchArrivals {
  const added = tasks.filter((task) => !current.seen.has(task.id));
  if (!added.length) return current;
  const created = dispatchedOf(added, current.taskId).some((task) => Date.parse(task.createdAt) > current.enteredAt);
  return {
    ...current,
    seen: new Set([...current.seen, ...added.map((task) => task.id)]),
    revision: current.revision + Number(created),
  };
}

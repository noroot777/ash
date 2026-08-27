import type { TaskListItem } from "@ash/shared";

export interface ResumeQueueModel {
  ordered: TaskListItem[];
  doneCount: number;
}

export function activeGroupTasks<T extends TaskListItem>(tasks: T[], groupId: string): T[] {
  return tasks.filter((task) => task.groupId === groupId && !task.archived);
}

export function resumeQueueModel(tasks: TaskListItem[]): ResumeQueueModel | null {
  if (!tasks.some((task) => task.status === "paused")) return null;
  const inSet = new Set(tasks.map((task) => task.id));
  const placed = new Set<string>();
  const ordered: TaskListItem[] = [];
  const pool = [...tasks].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  while (pool.length) {
    const ready = pool.findIndex((task) => task.resumeDependsOn.every((dependency) => !inSet.has(dependency) || placed.has(dependency)));
    const task = ready >= 0 ? pool.splice(ready, 1)[0]! : pool.shift()!;
    placed.add(task.id);
    ordered.push(task);
  }
  return { ordered, doneCount: tasks.filter((task) => task.status === "done").length };
}

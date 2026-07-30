import type { Task } from "@harness/shared";

export interface ResumeQueueModel {
  ordered: Task[];
  doneCount: number;
}

export function activeGroupTasks(tasks: Task[], groupId: string): Task[] {
  return tasks.filter((task) => task.groupId === groupId && !task.archived);
}

export function resumeQueueModel(tasks: Task[]): ResumeQueueModel | null {
  if (!tasks.some((task) => task.status === "paused")) return null;
  const inSet = new Set(tasks.map((task) => task.id));
  const placed = new Set<string>();
  const ordered: Task[] = [];
  const pool = [...tasks].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  while (pool.length) {
    const ready = pool.findIndex((task) => task.resumeDependsOn.every((dependency) => !inSet.has(dependency) || placed.has(dependency)));
    const task = ready >= 0 ? pool.splice(ready, 1)[0]! : pool.shift()!;
    placed.add(task.id);
    ordered.push(task);
  }
  return { ordered, doneCount: tasks.filter((task) => task.status === "done").length };
}

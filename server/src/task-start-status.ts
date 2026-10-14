import type { TaskStatus } from "@ash/shared";

type StartTask = { id: string; status: string; followUpFrom?: string | null };
const queuedFrom = new Map<string, TaskStatus>();

export function taskStartStatus(task: StartTask): TaskStatus {
  return (task.status === "queued" ? queuedFrom.get(task.id) : undefined)
    ?? (task.followUpFrom as TaskStatus | null | undefined)
    ?? task.status as TaskStatus;
}

export function recordTaskStatus(task: StartTask | undefined, status: TaskStatus): void {
  if (!task) return;
  if (status === "queued" && task.status !== "queued") queuedFrom.set(task.id, taskStartStatus(task));
  else if (status !== "queued" && status !== "running") queuedFrom.delete(task.id);
}

import type { Task } from "@harness/shared";

export type ReadWatermarks = Record<string, number>;

export type TaskActivity = ReadonlyMap<string, number>;

function updatedAtMs(task: Pick<Task, "updatedAt">): number {
  const timestamp = Date.parse(task.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function taskActivity(tasks: Pick<Task, "id" | "updatedAt">[]): TaskActivity {
  return new Map(tasks.map((task) => [task.id, updatedAtMs(task)]));
}

export function teamActivity(
  tasks: Pick<Task, "id" | "mode" | "parentId" | "updatedAt">[],
): TaskActivity {
  const teamIds = new Set(
    tasks.filter((task) => task.mode === "team" && !task.parentId).map((task) => task.id),
  );
  const latest = new Map<string, number>();

  for (const task of tasks) {
    const teamId = teamIds.has(task.id) ? task.id : task.parentId;
    if (!teamId || !teamIds.has(teamId)) continue;
    latest.set(teamId, Math.max(latest.get(teamId) ?? 0, updatedAtMs(task)));
  }

  return latest;
}

export function advanceReadWatermarks(
  current: ReadWatermarks,
  activity: TaskActivity,
  readTaskIds: Iterable<string> = [],
): ReadWatermarks {
  let next = current;

  for (const [taskId, latest] of activity) {
    if (current[taskId] == null) {
      if (next === current) next = { ...current };
      next[taskId] = latest;
    }
  }

  for (const taskId of readTaskIds) {
    const latest = activity.get(taskId);
    if (latest == null || next[taskId] === latest) continue;
    if (next === current) next = { ...current };
    next[taskId] = latest;
  }

  return next;
}

export function unreadTaskIds(
  activity: TaskActivity,
  watermarks: ReadWatermarks,
  visibleTaskIds: Iterable<string> = [],
): Set<string> {
  const visible = new Set(visibleTaskIds);
  return new Set(
    [...activity].flatMap(([taskId, latest]) =>
      !visible.has(taskId) && watermarks[taskId] != null && latest > watermarks[taskId]
        ? [taskId]
        : [],
    ),
  );
}

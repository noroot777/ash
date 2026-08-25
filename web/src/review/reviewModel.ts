import type { TaskListItem } from "@ash/shared";

// Mirrors the deterministic server guard: a child without its own worktree is
// part of the parent team's shared acceptance boundary, never a mergeable task.
export function sharedTeamParent(task: TaskListItem, allTasks: TaskListItem[]): TaskListItem | null {
  if (!task.parentId || task.useWorktree) return null;
  const parent = allTasks.find((candidate) => candidate.id === task.parentId) ?? null;
  return parent?.mode === "team" ? parent : null;
}

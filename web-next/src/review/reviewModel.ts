import type { Task } from "@harness/shared";

// Mirrors the deterministic server guard: a child without its own worktree is
// part of the parent team's shared acceptance boundary, never a mergeable task.
export function sharedTeamParent(task: Task, allTasks: Task[]): Task | null {
  if (!task.parentId || task.useWorktree) return null;
  const parent = allTasks.find((candidate) => candidate.id === task.parentId) ?? null;
  return parent?.mode === "team" ? parent : null;
}

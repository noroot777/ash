import type { Task } from "@harness/shared";

// Team dispatch creates real child tasks. Their metadata and lifecycle ownership
// stay with the team lead; the web UI only exposes observation/progress actions.
export function isDispatchedWorker(task: Pick<Task, "parentId">): boolean {
  return task.parentId !== null;
}

export function isSharedTeamWorker(
  task: Pick<Task, "parentId" | "useWorktree">,
  parent: Pick<Task, "id" | "mode"> | null | undefined,
): boolean {
  return !!task.parentId && !task.useWorktree && parent?.id === task.parentId && parent.mode === "team";
}

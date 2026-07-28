import { STAGE_LABELS, type Task, type TaskStage } from "@harness/shared";

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

// Historical shared workers may already carry awaiting_acceptance/merged from
// the old protocol. Their UI still collapses those legacy values into verified:
// shared workers now stop after validation and only become complete when the
// team-level acceptance links them to accepted.
export function sharedWorkerDisplayStage(stage?: TaskStage | null): TaskStage | null {
  if (stage === "awaiting_acceptance" || stage === "merged") return "verified";
  return stage ?? null;
}

export function sharedWorkerStageLabel(stage?: TaskStage | null): string | null {
  const displayStage = sharedWorkerDisplayStage(stage);
  if (!displayStage) return null;
  return displayStage === "accepted" ? "完成" : STAGE_LABELS[displayStage];
}

export const ARCHIVED_DECISION_HINT = "已归档，取消归档后再裁决";

export function taskInteractionAvailability(task: { archived?: boolean }): "archived" | "ready" {
  return task.archived ? "archived" : "ready";
}

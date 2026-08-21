// The single primary action for a task in a given status. Team is a resident
// console, so its idle state is runnable and resumes the same CLI session.
import type { TaskMode, TaskStatus } from "@ash/shared";

export type RunActionKind = "run" | "retry" | "busy" | "gate" | "done";
export interface RunAction {
  kind: RunActionKind;
  label: string;
  canClick: boolean;
}

export function runAction(
  status: TaskStatus,
  context: { mode?: TaskMode; awaitingAnswer?: boolean } = {},
): RunAction {
  const { mode = "single", awaitingAnswer = false } = context;

  // ask_question is resumed only through /answer. Showing Continue/Retry here
  // would imply the question can be bypassed by the normal run endpoint.
  if (awaitingAnswer && (status === "paused" || mode === "team")) {
    return { kind: "gate", label: "等待答复", canClick: false };
  }

  if (mode === "team") {
    switch (status) {
      case "running":
        return { kind: "busy", label: "进行中…", canClick: false };
      case "queued":
        return { kind: "busy", label: "排队中", canClick: false };
      case "awaiting_review":
        return { kind: "gate", label: "等待裁决", canClick: false };
      default:
        // idle is not terminal. /run reconnects the resident console to its
        // existing CLI session; the fallback also repairs stale team statuses.
        return { kind: "run", label: "运行", canClick: true };
    }
  }

  switch (status) {
    case "backlog":
    case "canceled":
      return { kind: "run", label: "运行", canClick: true };
    case "queued":
      return { kind: "busy", label: "排队中", canClick: false };
    case "running":
      return { kind: "busy", label: "进行中…", canClick: false };
    case "awaiting_review":
      return { kind: "gate", label: "等待裁决", canClick: false };
    case "paused":
      return { kind: "run", label: "继续", canClick: true };
    case "failed":
      return { kind: "retry", label: "重试", canClick: true };
    case "done":
      return { kind: "done", label: "已完成", canClick: false };
    default:
      return { kind: "busy", label: status, canClick: false };
  }
}

// A live agent subprocess exists only while `running`, so that's the only status
// a manual stop applies to. This intentionally includes a running team console;
// its server-side stop settles back to idle rather than creating a terminal state.
export function canStopTask(status: TaskStatus): boolean {
  return status === "running";
}

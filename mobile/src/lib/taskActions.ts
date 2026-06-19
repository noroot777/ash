// The single primary action for a task in a given status — ported verbatim from
// web/src/taskActions.ts so the mobile button agrees with the web/server guard
// (a `done` task shows a disabled「已完成」, never a casual re-run).
import type { TaskStatus } from "@harness/shared";

export type RunActionKind = "run" | "retry" | "busy" | "gate" | "done";
export interface RunAction {
  kind: RunActionKind;
  label: string;
  canClick: boolean;
}

export function runAction(status: TaskStatus): RunAction {
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
    case "failed":
      return { kind: "retry", label: "重试", canClick: true };
    case "done":
      return { kind: "done", label: "已完成", canClick: false };
    default:
      return { kind: "busy", label: status, canClick: false };
  }
}

// A live agent subprocess exists only while `running`, so that's the only status
// a manual stop applies to.
export function canStopTask(status: TaskStatus): boolean {
  return status === "running";
}

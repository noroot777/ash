import type { ReactNode } from "react";
import type { TaskMode, TaskStatus } from "@harness/shared";
import { runActivityCopy } from "../lib/runActivity.ts";

export function RunActivity({
  status,
  mode,
  executor,
  queuePosition,
  idle,
}: {
  status: TaskStatus;
  mode: TaskMode;
  executor?: string | null;
  queuePosition?: number | null;
  idle?: ReactNode;
}) {
  const copy = runActivityCopy({ status, mode, executor, queuePosition });
  if (!copy) return idle ?? null;
  return (
    <div className="run-activity" role="status" aria-live="polite">
      <span className="run-activity-signal" aria-hidden="true"><i /><i /><i /></span>
      <span className="run-activity-copy">
        <b>{copy.title}</b>
        <small>{copy.detail}</small>
      </span>
    </div>
  );
}

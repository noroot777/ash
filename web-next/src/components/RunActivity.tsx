import type { TaskMode, TaskStatus } from "@harness/shared";
import { runActivityCopy, type RunActivityPhase } from "@harness/shared/run-activity";

export function RunActivity({
  status,
  mode,
  phase,
  executor,
  queuePosition,
}: {
  status: TaskStatus;
  mode: TaskMode;
  phase: RunActivityPhase;
  executor?: string | null;
  queuePosition?: number | null;
}) {
  const copy = runActivityCopy({ status, mode, phase, executor, queuePosition });
  if (!copy) return null;
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

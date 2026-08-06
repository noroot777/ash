import type { TaskMode, TaskStatus } from "@harness/shared";
import { runActivityCopy, type RunActivityCopy, type RunActivityPhase } from "@harness/shared/run-activity";

export function RunActivity({
  status,
  mode,
  phase,
  executor,
  queuePosition,
  copy,
}: {
  status: TaskStatus;
  mode: TaskMode;
  phase: RunActivityPhase;
  executor?: string | null;
  queuePosition?: number | null;
  copy?: RunActivityCopy;
}) {
  const defaultCopy = runActivityCopy({ status, mode, phase, executor, queuePosition });
  if (!defaultCopy) return null;
  const shownCopy = copy ?? defaultCopy;
  return (
    <div className="run-activity" role="status" aria-live="polite">
      <span className="run-activity-signal" aria-hidden="true"><i /><i /><i /></span>
      <span className="run-activity-copy">
        <b>{shownCopy.title}</b>
        <small>{shownCopy.detail}</small>
      </span>
    </div>
  );
}

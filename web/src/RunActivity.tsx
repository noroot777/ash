import type { ReactNode } from "react";
import type { TaskMode, TaskStatus } from "@harness/shared";
import { runActivityCopy, type RunActivityPhase } from "./runActivityCopy";

export function ActivityDots({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 ${className || "text-accent"}`} aria-hidden="true">
      <span className="typing-dot" style={{ animationDelay: "0ms" }} />
      <span className="typing-dot" style={{ animationDelay: "150ms" }} />
      <span className="typing-dot" style={{ animationDelay: "300ms" }} />
    </span>
  );
}

export function RunActivity({
  status,
  mode,
  phase = "starting",
  executor,
  queuePosition,
  queueSize,
  idleText,
}: {
  status: TaskStatus;
  mode: TaskMode;
  phase?: RunActivityPhase;
  executor?: string | null;
  queuePosition?: number | null;
  queueSize?: number | null;
  idleText?: ReactNode;
}) {
  const copy = runActivityCopy({ status, mode, phase, executor, queuePosition, queueSize });
  if (!copy) return idleText ? <p className="font-sans text-faint">{idleText}</p> : null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-3 flex items-center gap-2 text-[11px]"
    >
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-overlay">
        <ActivityDots className="scale-75 text-accent/55" />
      </span>
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
        <span className="font-medium text-muted">{copy.title}</span>
        <span className="text-line2">·</span>
        <span className="text-faint">{copy.detail}</span>
      </span>
    </div>
  );
}

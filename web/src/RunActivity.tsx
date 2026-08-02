import type { ReactNode } from "react";
import type { TaskMode, TaskStatus } from "@harness/shared";
import { runActivityCopy } from "./runActivityCopy";

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
  executor,
  queuePosition,
  queueSize,
  idleText,
}: {
  status: TaskStatus;
  mode: TaskMode;
  executor?: string | null;
  queuePosition?: number | null;
  queueSize?: number | null;
  idleText?: ReactNode;
}) {
  const copy = runActivityCopy({ status, mode, executor, queuePosition, queueSize });
  if (!copy) return idleText ? <p className="font-sans text-faint">{idleText}</p> : null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-3 flex w-full items-start gap-3 rounded-lg border border-accent/20 bg-accent/[0.045] px-3 py-2.5"
    >
      <span className="mt-0.5 grid h-7 w-9 shrink-0 place-items-center rounded-md border border-accent/15 bg-panel">
        <ActivityDots />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-ink">{copy.title}</span>
        <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">{copy.detail}</span>
      </span>
    </div>
  );
}

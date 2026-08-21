import { useEffect, useState } from "react";
import type { Task } from "@ash/shared";
import { Clock } from "@phosphor-icons/react";
import { formatInstant, taskDurationInfo } from "./utils.ts";

export function TaskTimeMeta({ task }: { task: Task }) {
  const ticking = !!task.startedAt && !task.endedAt && (task.status === "running" || task.status === "queued");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);

  const duration = taskDurationInfo(task, now);
  return (
    <span className="task-time-meta">
      <Clock size={12} aria-hidden="true" />
      <span>创建 {formatInstant(task.createdAt)}</span>
      {duration && (
        <>
          <i aria-hidden="true">·</i>
          <span title={duration.title}>{duration.label} {duration.text}</span>
        </>
      )}
    </span>
  );
}

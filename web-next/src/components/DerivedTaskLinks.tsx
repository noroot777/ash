import { taskDisplayStatus, type Task } from "@harness/shared";
import { ArrowRight } from "@phosphor-icons/react";
import { StatusChip } from "./ui.tsx";
import { TaskModeIcon, taskModeLabel } from "./TaskOrigin.tsx";

type DisplayStatus = ReturnType<typeof taskDisplayStatus>;
type StatusTone = "neutral" | "green" | "amber" | "red" | "cyan";

function derivedStatusTone(status: DisplayStatus): StatusTone {
  if (status.key === "awaiting_answer" || status.key === "paused") return "cyan";
  if (["done", "verified", "merged", "accepted"].includes(status.key)) return "green";
  if (["queued", "awaiting_review", "verifying", "awaiting_acceptance"].includes(status.key)) return "amber";
  if (status.key === "failed" || status.key === "verify_failed") return "red";
  return "neutral";
}

export function DerivedTaskLinks({
  sourceTaskId,
  allTasks,
  onOpen,
}: {
  sourceTaskId: string;
  allTasks: Task[];
  onOpen: (taskId: string) => void;
}) {
  const derived = allTasks
    .filter((task) => task.originTaskId === sourceTaskId && (task.mode === "team" || task.mode === "duet"))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  if (!derived.length) return null;

  return (
    <nav className="task-derived-links" aria-label="派生任务">
      <span>派生任务</span>
      <div>
        {derived.map((task) => {
          const status = taskDisplayStatus(task.status, task.stage, !!task.question);
          return (
            <button
              type="button"
              key={task.id}
              aria-label={`打开${taskModeLabel(task.mode)}任务：${task.title}`}
              onClick={() => onOpen(task.id)}
            >
              <span className="task-derived-mode">
                <TaskModeIcon mode={task.mode} size={12} />
                {taskModeLabel(task.mode)}
              </span>
              <b>{task.title || `未命名${taskModeLabel(task.mode)}`}</b>
              <StatusChip tone={derivedStatusTone(status)}>{task.archived ? "已归档" : status.label}</StatusChip>
              <ArrowRight size={12} aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </nav>
  );
}

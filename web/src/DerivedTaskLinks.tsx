import { taskDisplayStatus, type Task } from "@harness/shared";
import { StatusIcon } from "./StatusIcon";
import { TaskModeIcon } from "./taskOrigin";
import { Tip } from "./Tip";

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
    .filter((task) => task.originTaskId === sourceTaskId && (task.mode === "team" || task.mode === "debate"))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (derived.length === 0) return null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-line bg-panel px-6 py-2">
      <span className="mr-0.5 text-[11px] font-medium text-faint">派生任务</span>
      {derived.map((task) => {
        const team = task.mode === "team";
        const display = taskDisplayStatus(task.status, task.stage, !!task.question);
        return (
          <button
            key={task.id}
            type="button"
            onClick={() => onOpen(task.id)}
            className="inline-flex min-w-0 max-w-[280px] items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1 text-[11.5px] text-muted transition-colors hover:border-line2 hover:bg-raised hover:text-ink"
            title={`打开${team ? "团队" : "辩论"}任务：${task.title}`}
          >
            <Tip label={team ? "团队任务" : "辩论任务"} className="inline-flex shrink-0 text-muted">
              <TaskModeIcon mode={task.mode} size={12} />
            </Tip>
            <span className="truncate text-ink">{task.title}</span>
            <span className="inline-flex shrink-0 items-center gap-1 text-faint">
              <StatusIcon status={task.status} stage={task.stage} awaitingAnswer={!!task.question} />
              {task.archived ? "已归档" : display.label}
            </span>
            <span className="shrink-0 text-faint">→</span>
          </button>
        );
      })}
    </div>
  );
}

import { taskDisplayStatus, type Task } from "@harness/shared";
import { Scales, UsersThree } from "@phosphor-icons/react";
import { StatusIcon } from "./StatusIcon";

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
            className={`inline-flex min-w-0 max-w-[280px] items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] transition-colors ${team ? "border-cyan-500/25 bg-cyan-500/[0.06] hover:bg-cyan-500/10" : "border-violet-500/25 bg-violet-500/[0.06] hover:bg-violet-500/10"}`}
            title={`打开${team ? "团队" : "辩论"}任务：${task.title}`}
          >
            {team ? <UsersThree size={12} weight="fill" className="shrink-0 text-cyan-700" /> : <Scales size={12} weight="fill" className="shrink-0 text-violet-700" />}
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

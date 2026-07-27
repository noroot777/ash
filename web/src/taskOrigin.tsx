import type { MouseEvent } from "react";
import type { Task } from "@harness/shared";

function sourceLabel(source: Task | undefined): string {
  if (source?.mode === "debate") return "辩论";
  if (source?.mode === "team") return "团队";
  return "来源";
}

export function OriginTaskChip({
  task,
  allTasks,
  onOpen,
}: {
  task: Task;
  allTasks: Task[];
  onOpen: (taskId: string) => void;
}) {
  if (!task.originTaskId) return null;
  const source = allTasks.find((item) => item.id === task.originTaskId);
  return (
    <button
      type="button"
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        onOpen(task.originTaskId!);
      }}
      className="shrink-0 rounded border border-line bg-panel px-1.5 py-0.5 text-[10px] font-medium text-muted transition-colors hover:border-accent/40 hover:text-accent"
      title={source ? `回到来源${sourceLabel(source)}：${source.title}` : "回到来源任务"}
    >
      ←{sourceLabel(source)}
    </button>
  );
}

export function OriginTaskBar({
  task,
  allTasks,
  onOpen,
}: {
  task: Task;
  allTasks: Task[];
  onOpen: (taskId: string) => void;
}) {
  if (!task.originTaskId) return null;
  const source = allTasks.find((item) => item.id === task.originTaskId);
  const label = sourceLabel(source);
  return (
    <button
      type="button"
      onClick={() => onOpen(task.originTaskId!)}
      className="flex shrink-0 items-center gap-2 border-b border-line bg-[color-mix(in_srgb,var(--color-accent)_6%,#fff)] px-3.5 py-2 text-left text-[12.5px] text-accent transition-colors hover:bg-[color-mix(in_srgb,var(--color-accent)_11%,#fff)]"
      title={source ? `打开来源${label}：${source.title}` : "打开来源任务"}
    >
      <span>← 来自{label}</span>
      {source && <span className="min-w-0 truncate text-muted">· {source.title}</span>}
    </button>
  );
}

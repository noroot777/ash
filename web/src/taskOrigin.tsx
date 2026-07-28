import type { MouseEvent } from "react";
import type { Task } from "@harness/shared";
import { UsersThree } from "@phosphor-icons/react";

type ParentLink = {
  taskId: string;
  task: Task | undefined;
  kind: "team" | "origin";
};

function originSourceLabel(source: Task | undefined): string {
  if (source?.mode === "debate") return "辩论";
  if (source?.mode === "team") return "团队";
  return "来源";
}

function parentLink(task: Task, allTasks: Task[]): ParentLink | null {
  // A dispatched worker's team is its immediate home, so it wins over an
  // origin backlink if older or imported data happens to contain both.
  const taskId = task.parentId ?? task.originTaskId;
  if (!taskId) return null;
  return {
    taskId,
    task: allTasks.find((item) => item.id === taskId),
    kind: task.parentId ? "team" : "origin",
  };
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
  const link = parentLink(task, allTasks);
  if (!link) return null;
  const isTeam = link.kind === "team";
  const label = isTeam ? "所属团队" : originSourceLabel(link.task);
  const title = isTeam
    ? link.task
      ? `打开所属团队：${link.task.title}`
      : "打开所属团队"
    : link.task
      ? `回到来源${label}：${link.task.title}`
      : "回到来源任务";
  return (
    <button
      type="button"
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        onOpen(link.taskId);
      }}
      className="flex shrink-0 items-center gap-1 rounded border border-line bg-panel px-1.5 py-0.5 text-[10px] font-medium text-muted transition-colors hover:border-accent/40 hover:text-accent"
      title={title}
    >
      {isTeam ? <UsersThree size={10} weight="fill" /> : "←"}
      {label}
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
  const link = parentLink(task, allTasks);
  if (!link) return null;
  const isTeam = link.kind === "team";
  const label = isTeam ? "所属团队" : `来自${originSourceLabel(link.task)}`;
  const title = isTeam
    ? link.task
      ? `打开所属团队：${link.task.title}`
      : "打开所属团队"
    : link.task
      ? `打开来源${originSourceLabel(link.task)}：${link.task.title}`
      : "打开来源任务";
  return (
    <button
      type="button"
      onClick={() => onOpen(link.taskId)}
      className="flex shrink-0 items-center gap-2 border-b border-line bg-[color-mix(in_srgb,var(--color-accent)_6%,#fff)] px-3.5 py-2 text-left text-[12.5px] text-accent transition-colors hover:bg-[color-mix(in_srgb,var(--color-accent)_11%,#fff)]"
      title={title}
    >
      {isTeam ? <UsersThree size={14} weight="fill" className="shrink-0" /> : <span>←</span>}
      <span className="font-medium">{label}</span>
      {link.task && <span className="min-w-0 truncate text-muted">· {link.task.title}</span>}
    </button>
  );
}

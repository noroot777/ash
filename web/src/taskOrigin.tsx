import type { MouseEvent } from "react";
import type { Task } from "@harness/shared";
import { FileText, Scales, UsersThree } from "@phosphor-icons/react";
import { Tip } from "./Tip";

type ParentLink = {
  taskId: string;
  task: Task | undefined;
  kind: "team" | "origin";
};

function taskModeLabel(mode: Task["mode"]): string {
  if (mode === "debate") return "辩论";
  if (mode === "team") return "团队";
  return "任务";
}

export function TaskModeIcon({
  mode,
  size = 14,
  className,
  "aria-label": ariaLabel,
}: {
  mode: Task["mode"];
  size?: number;
  className?: string;
  "aria-label"?: string;
}) {
  const accessibility = ariaLabel ? { "aria-label": ariaLabel } : { "aria-hidden": true as const };
  if (mode === "debate") return <Scales size={size} className={className} {...accessibility} />;
  if (mode === "team") return <UsersThree size={size} className={className} {...accessibility} />;
  return <FileText size={size} className={className} {...accessibility} />;
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
  const mode = isTeam ? "team" : (link.task?.mode ?? "single");
  const relation = isTeam ? "所属团队" : `来自${taskModeLabel(mode)}`;
  const tip = link.task ? `${relation}：${link.task.title}` : relation;
  return (
    <Tip label={tip} className="inline-flex shrink-0">
      <button
        type="button"
        onClick={(event: MouseEvent<HTMLButtonElement>) => {
          event.stopPropagation();
          onOpen(link.taskId);
        }}
        className="grid h-5 w-5 shrink-0 place-items-center rounded text-faint transition-colors hover:bg-overlay hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line2"
      >
        <TaskModeIcon mode={mode} size={12} />
      </button>
    </Tip>
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
  const mode = isTeam ? "team" : (link.task?.mode ?? "single");
  const relation = isTeam ? "所属团队" : `来自${taskModeLabel(mode)}`;
  return (
    <button
      type="button"
      onClick={() => onOpen(link.taskId)}
      className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-3.5 py-2 text-left text-[12.5px] text-muted transition-colors hover:bg-raised hover:text-ink"
    >
      <TaskModeIcon mode={mode} size={14} className="shrink-0" />
      <span className="font-medium">{relation}</span>
      {link.task && <span className="min-w-0 truncate text-muted">· {link.task.title}</span>}
    </button>
  );
}

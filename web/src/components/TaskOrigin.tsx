import { useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import type { Task } from "@ash/shared";
import { FileText, ChatsCircle, UsersThree } from "@phosphor-icons/react";

export type TaskParentLink = {
  taskId: string;
  task: Task | undefined;
  kind: "team" | "origin";
};

export function taskModeLabel(mode: Task["mode"]): string {
  if (mode === "duet") return "讨论";
  if (mode === "team") return "团队";
  return "任务";
}

export function taskParentLink(task: Task, allTasks: Task[]): TaskParentLink | null {
  // 执行者首先属于直接派出它的团队；旧数据即使同时带来源任务，也以团队为准。
  const taskId = task.parentId ?? task.originTaskId;
  if (!taskId) return null;
  return {
    taskId,
    task: allTasks.find((item) => item.id === taskId),
    kind: task.parentId ? "team" : "origin",
  };
}

export function taskParentMode(link: TaskParentLink): Task["mode"] {
  return link.kind === "team" ? "team" : (link.task?.mode ?? "single");
}

export function taskParentRelation(link: TaskParentLink): string {
  return link.kind === "team" ? "所属团队" : `来自${taskModeLabel(taskParentMode(link))}`;
}

export function TaskModeIcon({ mode, size = 14 }: { mode: Task["mode"]; size?: number }) {
  if (mode === "duet") return <ChatsCircle size={size} aria-hidden="true" />;
  if (mode === "team") return <UsersThree size={size} aria-hidden="true" />;
  return <FileText size={size} aria-hidden="true" />;
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
  const link = taskParentLink(task, allTasks);
  const root = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  if (!link) return null;
  const relation = taskParentRelation(link);
  const label = link.task ? `${relation}：${link.task.title}` : relation;
  const showTip = () => {
    const rect = root.current?.getBoundingClientRect();
    if (!rect) return;
    const edge = Math.min(140, window.innerWidth / 2);
    setPosition({
      x: Math.min(Math.max(rect.left + rect.width / 2, edge), window.innerWidth - edge),
      y: rect.bottom,
    });
  };
  return (
    <span
      ref={root}
      className="task-origin-chip"
      onMouseEnter={showTip}
      onMouseLeave={() => setPosition(null)}
      onFocus={showTip}
      onBlur={() => setPosition(null)}
    >
      <button
        type="button"
        aria-label={label}
        onClick={(event: MouseEvent<HTMLButtonElement>) => {
          event.stopPropagation();
          setPosition(null);
          onOpen(link.taskId);
        }}
      >
        <TaskModeIcon mode={taskParentMode(link)} size={12} />
      </button>
      {position && createPortal(
        <span className="task-origin-tooltip" role="tooltip" style={{ left: position.x, top: position.y + 6 }}>
          {label}
        </span>,
        document.body,
      )}
    </span>
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
  const link = taskParentLink(task, allTasks);
  if (!link) return null;
  const relation = taskParentRelation(link);
  return (
    <button className="task-origin-bar" type="button" onClick={() => onOpen(link.taskId)}>
      <TaskModeIcon mode={taskParentMode(link)} />
      <b>{relation}</b>
      {link.task && <span>· {link.task.title}</span>}
    </button>
  );
}

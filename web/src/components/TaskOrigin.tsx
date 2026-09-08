import { type MouseEvent } from "react";
import type { Task, TaskListItem } from "@ash/shared";
import { FileText, ChatsCircle, UsersThree, Robot, User } from "@phosphor-icons/react";
import { taskCreationLabel } from "@ash/shared/task-origin";
import { HoverTip, useHoverTip } from "./HoverTip.tsx";

export type TaskParentLink = {
  taskId: string;
  task: TaskListItem | undefined;
  kind: "team" | "origin";
};

export function taskModeLabel(mode: Task["mode"]): string {
  if (mode === "duet") return "讨论";
  if (mode === "team") return "团队";
  return "任务";
}

export function taskParentLink(task: TaskListItem, allTasks: TaskListItem[]): TaskParentLink | null {
  // 执行者首先属于直接派出它的团队；旧数据即使同时带来源任务，也以团队为准。
  const creator = task.creationOrigin?.kind === "agent" ? task.creationOrigin.taskId : null;
  const taskId = task.parentId ?? task.originTaskId ?? creator ?? task.baseTaskId;
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

export function TaskCreationBadge({ task }: { task: TaskListItem }) {
  const origin = task.creationOrigin;
  if (!origin) return null;
  const Icon = origin.kind === "agent" ? Robot : origin.kind === "user" ? User : null;
  return <span className={`task-creation-badge is-${origin.kind}`}>
    {Icon && <Icon size={11} aria-hidden="true" />}{taskCreationLabel(origin)}
  </span>;
}

export function OriginTaskChip({
  task,
  allTasks,
  onOpen,
}: {
  task: TaskListItem;
  allTasks: TaskListItem[];
  onOpen: (taskId: string) => void;
}) {
  const link = taskParentLink(task, allTasks);
  const tip = useHoverTip();
  if (!link) return null;
  const relation = taskParentRelation(link);
  const label = link.task ? `${relation}：${link.task.title}` : relation;
  return (
    <span className="task-origin-chip" {...tip.anchorProps}>
      <button
        type="button"
        aria-label={label}
        onClick={(event: MouseEvent<HTMLButtonElement>) => {
          event.stopPropagation();
          // 点了就要跳走，气泡不能留在原地悬着——它是 portal 到 body 的，锚点那一片
          // 内容马上就换了，没人再给它发 mouseleave。
          tip.hide();
          onOpen(link.taskId);
        }}
      >
        <TaskModeIcon mode={taskParentMode(link)} size={12} />
      </button>
      <HoverTip at={tip.at}>{label}</HoverTip>
    </span>
  );
}

export function OriginTaskBar({
  task,
  allTasks,
  onOpen,
}: {
  task: TaskListItem;
  allTasks: TaskListItem[];
  onOpen: (taskId: string) => void;
}) {
  const link = taskParentLink(task, allTasks);
  const origin = task.creationOrigin;
  const creator = origin?.kind === "agent" ? origin : null;
  const relation = link ? taskParentRelation(link) : null;
  const sourceTitle = link?.task?.title || (creator?.taskId === link?.taskId ? creator?.taskTitle : null) || link?.taskId;
  return (
    <div className="task-origin-bar">
      <TaskCreationBadge task={task} />
      {!origin && <span>来源未记录</span>}
      {creator?.executorLabel && <span>{creator.executorLabel}</span>}
      {link && (link.task
        ? <button type="button" onClick={() => onOpen(link.taskId)}>{relation} · {sourceTitle}</button>
        : <span>{relation} · {sourceTitle}</span>)}
    </div>
  );
}

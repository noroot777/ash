import { Fragment, useRef, useState } from "react";
import type { TaskListItem } from "@ash/shared";
import { dispatchPath } from "../lib/dispatchFamily.ts";
import { useDismissable } from "../lib/useDismissable.ts";

export function taskAncestryLabel(taskId: string, tasks: readonly TaskListItem[]): string {
  const task = tasks.find((item) => item.id === taskId);
  return task ? dispatchPath(task, tasks).slice(0, -1).map((item) => item.title || "未命名任务").join(" › ") : "";
}

export function TaskAncestry({ task, tasks, onOpen }: {
  task: TaskListItem;
  tasks: readonly TaskListItem[];
  onOpen: (taskId: string) => void;
}) {
  const parents = dispatchPath(task, tasks).slice(0, -1);
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismissable({ enabled: open, containerRef: menu, restoreFocusRef: trigger, onClose: () => setOpen(false) });
  if (!parents.length) return null;
  const link = (parent: TaskListItem) => <button type="button" className="task-crumb" aria-label={`父任务：${parent.title || "未命名任务"}`} onClick={() => { setOpen(false); onOpen(parent.id); }}>{parent.title || "未命名任务"}</button>;
  const visible = parents.length > 2 ? [parents[0], parents[parents.length - 1]] : parents;
  return <span className="task-ancestry" aria-label="父任务来路">
    {visible.map((parent, index) => <Fragment key={parent.id}>
      {index > 0 && parents.length > 2 && <span className="task-crumb-overflow" ref={menu}>
        <button type="button" ref={trigger} className="task-crumb" aria-label="展开中间的父任务" aria-expanded={open} onClick={() => setOpen((value) => !value)}>…</button>
        <span className="task-crumb-sep" aria-hidden="true">›</span>
        {open && <span className="task-crumb-menu">{parents.slice(1, -1).map((item) => <Fragment key={item.id}>{link(item)}</Fragment>)}</span>}
      </span>}
      {link(parent)}<span className="task-crumb-sep" aria-hidden="true">›</span>
    </Fragment>)}
  </span>;
}

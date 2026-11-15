import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { TaskListItem } from "@ash/shared";
import { CaretRight } from "@phosphor-icons/react";
import { type LookForTask } from "../lib/useTaskReadState.ts";
import { dispatchSubtree } from "../lib/dispatchTree.ts";
import { forestNeedsYou, type DispatchForest } from "./dispatchForest.ts";
import { RowMark, TaskRow } from "./TaskTreeRows.tsx";

// 侧栏里派出去的任务收在派它的那条下面：那一行行首多一颗箭头（平时是状态点，指到、聚焦、
// 展开时换成箭头 —— 跟团队行同一种做法），行尾一个数（名下几条）。名下整棵有在等答复或失败
// 的，那个数变琥珀色。默认收着；开过的记在本机，刷新后还开着。
//
// 收在谁下面由 dispatchForest.ts 算（只在画出来的那批行之间收），这里只管画。

const OPEN_STORAGE_KEY = "ash:task-tree:dispatch-open";
// 记得住的上限：开过的 id 只增不减的话这份 localStorage 会一直长；超出就丢最早开的。
const OPEN_LIMIT = 400;

function readOpen(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(OPEN_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

type DispatchOpen = {
  isOpen: (taskId: string) => boolean;
  toggle: (taskId: string) => void;
  open: (taskIds: readonly string[]) => void;
};

const DispatchOpenContext = createContext<DispatchOpen | null>(null);

export function useDispatchOpenState(): DispatchOpen {
  const [ids, setIds] = useState<string[]>(readOpen);
  useEffect(() => {
    try {
      window.localStorage.setItem(OPEN_STORAGE_KEY, JSON.stringify(ids.slice(-OPEN_LIMIT)));
    } catch {
      // 存不下就只在这一次会话里记得。
    }
  }, [ids]);
  const set = useMemo(() => new Set(ids), [ids]);
  const isOpen = useCallback((taskId: string) => set.has(taskId), [set]);
  const toggle = useCallback((taskId: string) => setIds((current) => (
    current.includes(taskId) ? current.filter((id) => id !== taskId) : [...current, taskId]
  )), []);
  const open = useCallback((taskIds: readonly string[]) => setIds((current) => {
    const missing = taskIds.filter((id) => !current.includes(id));
    return missing.length ? [...current, ...missing] : current;
  }), []);
  return useMemo(() => ({ isOpen, toggle, open }), [isOpen, open, toggle]);
}

export const DispatchOpenProvider = DispatchOpenContext.Provider;

type RowProps = {
  task: TaskListItem;
  forest: DispatchForest;
  allTasks: TaskListItem[];
  selectedTaskId: string | null;
  onTask: (task: TaskListItem) => void;
  lookForTask: LookForTask;
  showProject?: boolean;
  child?: boolean;
  /** 收在别人下面时不再画「从哪来」那颗图标：位置已经说了。 */
  showOrigin?: boolean;
};

/** 一行任务；名下收着派出去的任务时带箭头和数，展开后底下是它们。 */
export function DispatchAwareRow(props: RowProps) {
  const kids = props.forest.children.get(props.task.id);
  if (!kids?.length) {
    return (
      <TaskRow
        task={props.task}
        allTasks={props.allTasks}
        selectedTaskId={props.selectedTaskId}
        onTask={props.onTask}
        lookForTask={props.lookForTask}
        showProject={props.showProject}
        child={props.child}
        showOrigin={props.showOrigin}
      />
    );
  }
  return <DispatcherRow {...props} kids={kids} />;
}

function DispatcherRow({ task, forest, allTasks, selectedTaskId, onTask, lookForTask, showProject = true, child = false, showOrigin = true, kids }: RowProps & { kids: TaskListItem[] }) {
  const state = useContext(DispatchOpenContext);
  const expanded = state?.isOpen(task.id) ?? false;
  const needs = forestNeedsYou(forest, task.id);
  // 选中的是收在底下的某一条（侧栏里点开过、搜索命中的、J/K 走到的）：把这一层打开，
  // 让它看得见。只在「选中落进来」那一刻开一次 —— 之后用户自己收起，不再顶开。
  const selectedInside = !!selectedTaskId && dispatchSubtree(forest.children, task.id).some((row) => row.id === selectedTaskId);
  const openRows = state?.open;
  useEffect(() => {
    if (selectedInside) openRows?.([task.id]);
  }, [openRows, selectedInside, task.id]);
  const look = lookForTask(task);
  const needsSaid = needs ? "，有要你处理的" : "";
  return (
    <>
      <TaskRow
        task={task}
        allTasks={allTasks}
        selectedTaskId={selectedTaskId}
        onTask={onTask}
        lookForTask={lookForTask}
        showProject={showProject}
        child={child}
        showOrigin={showOrigin}
        wrapperClassName={`workspace-dispatch-row${expanded ? " is-expanded" : ""}`}
        leading={
          <span className="workspace-team-leading">
            <RowMark look={look} />
            <button
              className="workspace-team-caret"
              type="button"
              aria-label={`${expanded ? "收起" : "展开"} ${kids.length} 个派出的任务${needsSaid}`}
              aria-expanded={expanded}
              onClick={() => state?.toggle(task.id)}
            >
              <CaretRight size={10} weight="bold" className={expanded ? "is-open" : ""} aria-hidden="true" />
            </button>
          </span>
        }
        tally={<em className={`workspace-dispatch-count${needs ? " is-warn" : ""}`} aria-hidden="true">{kids.length}</em>}
      />
      {expanded && (
        <div className="workspace-dispatch-list" role="group" aria-label={`${task.title || "未命名任务"} 派出的任务`}>
          {kids.map((kid) => (
            <DispatchAwareRow
              key={kid.id}
              task={kid}
              forest={forest}
              allTasks={allTasks}
              selectedTaskId={selectedTaskId}
              onTask={onTask}
              lookForTask={lookForTask}
              // 跟派它的那条不在同一个项目里（派到别的仓库去干活）时，项目徽标才有信息量。
              showProject={kid.projectId !== task.projectId}
              child
              showOrigin={false}
            />
          ))}
        </div>
      )}
    </>
  );
}

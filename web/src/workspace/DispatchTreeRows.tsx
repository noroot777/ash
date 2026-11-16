import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { TaskListItem } from "@ash/shared";
import { type LookForTask } from "../lib/useTaskReadState.ts";
import { dispatchSubtree, type DispatchFacts } from "../lib/dispatchTree.ts";
import { type DispatchForest } from "./dispatchForest.ts";
import { ParentCaret, TaskRow } from "./TaskTreeRows.tsx";

// 侧栏里派出去的任务收在派它的那条下面：那一行行首是展开箭头、不画状态点（跟团队行同一种做法），
// 它自己和名下此刻怎么样写成行尾一句短语（lib/taskLook 的 phrase），后面一个数（名下几条）。名下
// 整棵有在等答复或失败的，那个数变琥珀色。默认收着；点开这一行就展开名下那一层（只开不收，收起
// 用箭头）；开过的记在本机，刷新后还开着。
//
// 收在谁下面由 dispatchForest.ts 算（只在画出来的那批行之间收）；那个数和它的颜色是关系事实，
// 从全量任务算（dispatchFacts，经 DispatchFactsProvider 递下来）—— 筛选把名下几条筛掉了，数照旧、
// 该变色照旧变色，只是没有可展开的行时不画箭头。这里只管画。

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

const NO_FACTS: DispatchFacts = { count: () => 0, needsYou: () => false, hasBelow: () => false };
const DispatchFactsContext = createContext<DispatchFacts>(NO_FACTS);
export const DispatchFactsProvider = DispatchFactsContext.Provider;
export const useDispatchFacts = () => useContext(DispatchFactsContext);

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
  const facts = useContext(DispatchFactsContext);
  const kids = props.forest.children.get(props.task.id) ?? [];
  const count = facts.count(props.task.id);
  const needs = facts.needsYou(props.task.id);
  // 是不是父任务看完整的派活关系：名下直接的那几条全归档了、更底下还有一条在跑 / 在等你，数是 0，
  // 照样是父任务（行尾那句短语就是在说那一条）。
  if (!kids.length && !facts.hasBelow(props.task.id)) {
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
  return <DispatcherRow {...props} kids={kids} count={count} needs={needs} />;
}

function DispatcherRow({ task, forest, allTasks, selectedTaskId, onTask, lookForTask, showProject = true, child = false, showOrigin = true, kids, count, needs }: RowProps & {
  /** 这份列表里画在它底下的那几条（可能被筛得一条不剩）。 */
  kids: TaskListItem[];
  /** 名下直接派了几条、整棵有没有要你处理的：全量关系，不随筛选变。 */
  count: number;
  needs: boolean;
}) {
  const state = useContext(DispatchOpenContext);
  const expandable = kids.length > 0;
  const expanded = expandable && (state?.isOpen(task.id) ?? false);
  // 选中的是收在底下的某一条（侧栏里点开过、搜索命中的、J/K 走到的）：把这一层打开，
  // 让它看得见。只在「选中落进来」那一刻开一次 —— 之后用户自己收起，不再顶开。
  const selectedInside = !!selectedTaskId && dispatchSubtree(forest.children, task.id).some((row) => row.id === selectedTaskId);
  const openRows = state?.open;
  useEffect(() => {
    if (selectedInside) openRows?.([task.id]);
  }, [openRows, selectedInside, task.id]);
  const said = `${count} 个派出的任务${needs ? "，有要你处理的" : ""}`;
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
        parent
        onExpand={expandable ? () => state?.open([task.id]) : undefined}
        wrapperClassName={expandable ? `workspace-dispatch-row${expanded ? " is-expanded" : ""}` : undefined}
        leading={expandable ? (
          <ParentCaret expanded={expanded} label={`${expanded ? "收起" : "展开"} ${said}`} onToggle={() => state?.toggle(task.id)} />
        ) : null}
        tally={
          // 有箭头时数和颜色由箭头那颗键念出来；名下几条都被筛掉了、没有箭头时，读屏得在这里听到。
          <em className={`workspace-dispatch-count${needs ? " is-warn" : ""}`}>
            <span aria-hidden="true">{count}</span>
            {!expandable && <span className="task-visually-hidden">{said}</span>}
          </em>
        }
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

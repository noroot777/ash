import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ProjectView, Task } from "@ash/shared";
import { statusCounts, workersOf } from "@ash/shared/team";
import { CaretRight, ChatsCircle, Star, UsersThree } from "@phosphor-icons/react";
import { OriginTaskChip, taskParentLink } from "../components/TaskOrigin.tsx";
import { TaskStatusDot } from "../components/TaskStatusDot.tsx";
import { api } from "../lib/api.ts";
import { readRenamedStorage } from "../lib/renamedStorage.ts";
import { type IndicatorForTask } from "../lib/useTaskReadState.ts";
import { ProjectAvatar } from "./ProjectAvatar.tsx";
import { SpreadRowCells, useSpreadRow } from "./TaskSpread.tsx";
import { advanceHiddenReveal } from "./taskTreeModel.ts";
import { spreadBucket } from "./useSidebarSpread.ts";

// 侧栏任务树的**一行**长什么样：状态点、星标、团队展开、铺开后多出来的那几格。
// 分节、排序和「哪些行进来」在 TaskTree.tsx / taskTreeModel.ts。

export const TASK_PREVIEW_LIMIT = 12;
const COLLAPSED_SECTIONS_STORAGE_KEY = "ash:task-tree:collapsed-sections";

// 星标按钮埋在 TaskRow 里、TaskRow 又埋在几种列表里：回写和报错的通道用 context 递，
// 免得每层组件都为它多两个 props。行首那枚项目徽标同理 —— 它只在「全部项目」态出现，
// 给的是 id→项目 的表；没有表就是单项目态，不画徽标。
type TaskTreeActions = {
  onStarred: (taskId: string, starredAt: number | null) => void;
  notify: (message: string) => void;
  projectBadges: Map<string, ProjectView> | null;
};

const TaskTreeActionsContext = createContext<TaskTreeActions | null>(null);
export const TaskTreeActionsProvider = TaskTreeActionsContext.Provider;
export type { TaskTreeActions };

export function useRevealHiddenSelection(revealKey: string | null, onReveal: () => void) {
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    const next = advanceHiddenReveal(lastKey.current, revealKey);
    lastKey.current = next.lastKey;
    if (next.reveal) onReveal();
  }, [onReveal, revealKey]);
}

function readCollapsedSections(): Set<string> {
  try {
    const raw = readRenamedStorage(COLLAPSED_SECTIONS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

export function useCollapsedSections() {
  const [collapsed, setCollapsed] = useState(readCollapsedSections);
  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_SECTIONS_STORAGE_KEY, JSON.stringify([...collapsed]));
    } catch {
      // Section folding remains usable for the current session if storage is unavailable.
    }
  }, [collapsed]);
  const toggle = (sectionKey: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(sectionKey)) next.delete(sectionKey);
    else next.add(sectionKey);
    return next;
  });
  return { collapsed, toggle };
}

export function StatusMarker({ indicator }: { indicator: ReturnType<IndicatorForTask> }) {
  return indicator
    ? <TaskStatusDot indicator={indicator} surface="workspace" />
    : <i className="workspace-status-dot workspace-status-dot--quiet" aria-hidden="true" />;
}

// 星标：用户手动的软记号（与自动状态正交）。已标的常驻行尾，未标的 hover 才浮出。
// 成功回写只取响应里的 starredAt（onStarred 合并进列表）—— HTTP 响应可能晚于更新
// 的 SSE 到达，整条 Task 快照直接替换会把状态/标题回滚到点星那一刻。SSE 断线窗口
// 里点的星也因此能立刻落到界面上；失败走 notify 让用户看得见。in-flight 期间忽略
// 重复点击，避免拿同一份旧 props 连发同方向请求。
function TaskStarButton({ task }: { task: Task }) {
  const actions = useContext(TaskTreeActionsContext);
  const [busy, setBusy] = useState(false);
  const starred = task.starredAt != null;
  return (
    <button
      className={`workspace-task-star${starred ? " is-starred" : ""}`}
      type="button"
      aria-pressed={starred}
      aria-label={starred ? "取消星标" : "加星标"}
      onClick={() => {
        if (busy) return;
        setBusy(true);
        api.patchTask(task.id, { starredAt: starred ? null : Date.now() })
          .then((updated) => actions?.onStarred(task.id, updated.starredAt ?? null))
          .catch(() => actions?.notify(starred ? "取消星标失败" : "加星标失败"))
          .finally(() => setBusy(false));
      }}
    >
      <Star size={13} weight={starred ? "fill" : "regular"} aria-hidden="true" />
    </button>
  );
}

// 「全部项目」态下每行标题前的项目徽标：混着看的时候，一行来自哪个项目是**必须先读到的
// 那个字段**，否则跨项目的同名任务根本分不开。窄侧栏只摆得下那个色块，铺开变宽了才把
// 项目名补出来（由 CSS 决定）—— 名字对读屏永远给足，挂在 aria-label 上。
function TaskProjectBadge({ project }: { project: ProjectView }) {
  return (
    <span className="workspace-task-project" aria-label={`项目 ${project.name}`}>
      <ProjectAvatar project={project} size="small" />
      <small aria-hidden="true">{project.name}</small>
    </span>
  );
}

export function TaskRow({
  task,
  allTasks,
  selectedTaskId,
  onTask,
  indicatorForTask,
  child = false,
  showOrigin = true,
  leading,
  wrapperClassName = "",
  trailing,
}: {
  task: Task;
  allTasks: Task[];
  selectedTaskId: string | null;
  onTask: (task: Task) => void;
  indicatorForTask: IndicatorForTask;
  child?: boolean;
  showOrigin?: boolean;
  leading?: React.ReactNode;
  wrapperClassName?: string;
  trailing?: React.ReactNode;
}) {
  const selected = selectedTaskId === task.id;
  const indicator = indicatorForTask(task);
  const hasOrigin = showOrigin && taskParentLink(task, allTasks) !== null;
  const hasMeta = task.mode === "duet" || trailing != null;
  const canStar = task.parentId === null;
  const spreadRow = useSpreadRow();
  const spreadCells = spreadRow?.spread.laidOut ? spreadRow : null;
  // 执行者行不挂徽标：它缩进在团队行底下，跟着上面那行走，同一个项目再标一次只是噪音。
  const badges = useContext(TaskTreeActionsContext)?.projectBadges;
  const project = canStar ? badges?.get(task.projectId) : undefined;
  return (
    <div className={`workspace-task-row-wrap ui-selectable${selected ? " is-selected" : ""}${wrapperClassName ? ` ${wrapperClassName}` : ""}${spreadCells && spreadBucket(task) === "todo" ? " is-todo" : ""}${task.starredAt != null ? " has-star" : ""}${canStar ? " can-star" : ""}`}>
      <span className="workspace-task-leading">
        {leading ?? <StatusMarker indicator={indicator} />}
      </span>
      <button
        className={`workspace-task-row${child ? " workspace-task-row--child" : ""}${hasOrigin ? " workspace-task-row--has-origin" : ""}`}
        type="button"
        aria-selected={selected}
        data-task-id={task.id}
        onClick={() => onTask(task)}
        title={task.title}
      >
        {project && <TaskProjectBadge project={project} />}
        <span className="workspace-task-title">{task.title || "未命名任务"}</span>
        {hasMeta && (
          <span className="workspace-task-meta">
            {task.mode === "duet" && <ChatsCircle size={12} weight="bold" className="workspace-task-kind" aria-label="讨论" />}
            {trailing}
          </span>
        )}
      </button>
      {canStar && <TaskStarButton task={task} />}
      {spreadCells && <SpreadRowCells task={task} ctx={spreadCells} onOpen={() => onTask(task)} />}
      {hasOrigin && (
        <OriginTaskChip
          task={task}
          allTasks={allTasks}
          onOpen={(taskId) => {
            const linked = allTasks.find((item) => item.id === taskId);
            if (linked) onTask(linked);
          }}
        />
      )}
    </div>
  );
}

function WorkerSummary({ workers, indicatorForTask }: { workers: Task[]; indicatorForTask: IndicatorForTask }) {
  if (!workers.length) return null;
  const buckets = statusCounts(workers);
  const summary = buckets.map((bucket) => `${bucket.n} ${bucket.label}`).join(" · ");
  return (
    <span className="workspace-worker-summary" title={`${workers.length} 个执行者 · ${summary}`}>
      <span>{workers.length}</span>
      <span className="workspace-worker-dots" aria-label={summary}>
        {buckets.map((bucket) => {
          const sample = workers.find((worker) =>
            (bucket.awaitingAnswer
              ? !!worker.question
              : bucket.status === "queued"
                ? !worker.question && (worker.status === "queued" || worker.status === "backlog")
                : !worker.question && worker.status === bucket.status)
            && indicatorForTask(worker) != null,
          );
          const indicator = sample ? indicatorForTask(sample) : null;
          return sample && indicator
            ? <TaskStatusDot key={bucket.label} indicator={indicator} surface="workspace" small />
            : null;
        })}
      </span>
    </span>
  );
}

export function TeamRow({
  task,
  tasks,
  allTasks,
  selectedTaskId,
  onTask,
  indicatorForTask,
}: {
  task: Task;
  tasks: Task[];
  allTasks: Task[];
  selectedTaskId: string | null;
  onTask: (task: Task) => void;
  indicatorForTask: IndicatorForTask;
}) {
  const workers = workersOf(tasks, task.id);
  const selectedWorkerIndex = workers.findIndex((worker) => worker.id === selectedTaskId);
  const selectedWorker = selectedWorkerIndex >= 0;
  const overflowSelectedId = selectedWorkerIndex >= TASK_PREVIEW_LIMIT ? workers[selectedWorkerIndex]?.id ?? null : null;
  const [expanded, setExpanded] = useState(selectedWorker);
  const [showAllWorkers, setShowAllWorkers] = useState(() => overflowSelectedId != null);
  const revealOverflowWorkers = useCallback(() => setShowAllWorkers(true), []);
  useRevealHiddenSelection(overflowSelectedId, revealOverflowWorkers);
  const indicator = indicatorForTask(task);
  const workersExpanded = showAllWorkers;
  const visibleWorkers = workersExpanded ? workers : workers.slice(0, TASK_PREVIEW_LIMIT);
  useEffect(() => {
    if (selectedWorker) setExpanded(true);
  }, [selectedWorker]);
  return (
    <>
      <TaskRow
        task={task}
        allTasks={allTasks}
        selectedTaskId={selectedTaskId}
        onTask={onTask}
        indicatorForTask={indicatorForTask}
        wrapperClassName={`workspace-team-row${expanded ? " is-expanded" : ""}`}
        leading={
          <span className="workspace-team-leading">
            <StatusMarker indicator={indicator} />
            <button
              className="workspace-team-caret"
              type="button"
              disabled={!workers.length}
              aria-label={expanded ? "折叠执行者" : `展开 ${workers.length} 个执行者`}
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              <CaretRight size={10} weight="bold" className={expanded ? "is-open" : ""} aria-hidden="true" />
            </button>
          </span>
        }
        trailing={
          <>
            <WorkerSummary workers={workers} indicatorForTask={indicatorForTask} />
            <UsersThree size={13} weight="fill" className="workspace-task-kind" aria-label="团队任务" />
          </>
        }
      />
      {expanded && workers.length > 0 && (
        <div className="workspace-worker-list">
          {visibleWorkers.map((worker) => (
            <TaskRow
              key={worker.id}
              task={worker}
              allTasks={allTasks}
              child
              showOrigin={false}
              selectedTaskId={selectedTaskId}
              onTask={onTask}
              indicatorForTask={indicatorForTask}
              trailing={<span className="workspace-worker-executor">{worker.executorLabel || worker.agentType || "执行者"}</span>}
            />
          ))}
          {workers.length > TASK_PREVIEW_LIMIT && (
            <button className="workspace-task-more" type="button" onClick={() => setShowAllWorkers((value) => !value)}>
              {workersExpanded ? "收起" : `显示另外 ${workers.length - TASK_PREVIEW_LIMIT} 条`}
            </button>
          )}
        </div>
      )}
    </>
  );
}

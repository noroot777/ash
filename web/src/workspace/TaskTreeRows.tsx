import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ProjectView, TaskListItem } from "@ash/shared";
import { statusCounts, workersOf } from "@ash/shared/team";
import { CaretRight, ChatsCircle, ListNumbers, PaperPlaneTilt, PushPin, Robot, Star, UsersThree, type Icon } from "@phosphor-icons/react";
import { OriginTaskChip, taskParentLink } from "../components/TaskOrigin.tsx";
import { taskCreationLabel } from "@ash/shared/task-origin";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { api } from "../lib/api.ts";
import { readRenamedStorage } from "../lib/renamedStorage.ts";
import type { TaskLook } from "../lib/taskLook.ts";
import { type LookForTask } from "../lib/useTaskReadState.ts";
import { ProjectAvatar } from "./ProjectAvatar.tsx";
import { RevealMore, useReveal } from "./TaskReveal.tsx";
import { SpreadRowCells, useSpreadRow } from "./TaskSpread.tsx";
import { advanceHiddenReveal } from "./taskTreeModel.ts";

// 侧栏任务树的**一行**长什么样：状态点、星标、团队展开、铺开后多出来的那几格。
// 分节、排序和「哪些行进来」在 TaskTree.tsx / taskTreeModel.ts。

export const TASK_PREVIEW_LIMIT = 12;
const COLLAPSED_SECTIONS_STORAGE_KEY = "ash:task-tree:collapsed-sections";

// 星标按钮埋在 TaskRow 里、TaskRow 又埋在几种列表里：回写和报错的通道用 context 递，
// 免得每层组件都为它多两个 props。行首那枚项目徽标同理 —— 它只在「任务模式」出现，
// 给的是 id→项目 的表；没有表就是单项目态，不画徽标。
type TaskTreeActions = {
  onStarred: (taskId: string, starredAt: number | null) => void;
  notify: (message: string) => void;
  projectBadges: Map<string, ProjectView> | null;
  // 行尾队列徽标点开队列抽屉;抽屉挂在 TaskTree 顶层,入口用 context 递下来。
  onOpenQueue: (queueId: string) => void;
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

// 行首那颗记号：画什么、指上去说什么都查 lib/taskLook 的那张表（顶上的筛选也查它）。
// 验收过也看过的什么都不画 —— 槽位还在（外面那格 22px），标题照样对齐。
export function RowMark({ look, small = false }: { look: TaskLook; small?: boolean }) {
  const tip = useHoverTip();
  if (!look.mark) return null;
  return (
    <>
      <i
        className={`workspace-status-dot workspace-status-dot--${look.mark}${small ? " workspace-status-dot--small" : ""}`}
        role="img"
        aria-label={look.say}
        {...(small ? {} : tip.anchorProps)}
      />
      {!small && <HoverTip at={tip.at}>{look.say}</HoverTip>}
    </>
  );
}

// 行尾那两三个字（等你答复）：定长、不截，标题让它；问题本身指上去再看。
function RowWord({ look }: { look: TaskLook }) {
  const tip = useHoverTip();
  if (!look.word) return null;
  return (
    <>
      <span className="workspace-task-word" {...(look.detail ? tip.anchorProps : {})}>{look.word}</span>
      {look.detail && <HoverTip at={tip.at}>{look.detail}</HoverTip>}
    </>
  );
}

// 行尾常驻的灰图标（团队任务、已置顶）：只是让你认得出这是哪种行，点了跟点整行一样。
// 名字在提示里。
function RowGlyph({ icon: Glyph, label, weight = "regular" }: { icon: Icon; label: string; weight?: "regular" | "fill" }) {
  const tip = useHoverTip();
  return (
    <>
      <Glyph size={13} weight={weight} className="workspace-task-glyph" role="img" aria-label={label} {...tip.anchorProps} />
      <HoverTip at={tip.at}>{label}</HoverTip>
    </>
  );
}

// 星标：用户手动的软记号（与自动状态正交）。已标的常驻行尾，未标的 hover 才浮出。
// 成功回写只取响应里的 starredAt（onStarred 合并进列表）—— HTTP 响应可能晚于更新
// 的 SSE 到达，整条 Task 快照直接替换会把状态/标题回滚到点星那一刻。SSE 断线窗口
// 里点的星也因此能立刻落到界面上；失败走 notify 让用户看得见。in-flight 期间忽略
// 重复点击，避免拿同一份旧 props 连发同方向请求。
function TaskStarButton({ task }: { task: TaskListItem }) {
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

// 「任务模式」下每行标题前的项目徽标：跨项目混着看时，一行来自哪个项目是**必须先读到的
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
  lookForTask,
  child = false,
  showOrigin = true,
  showProject = true,
  leading,
  wrapperClassName = "",
  trailing,
}: {
  task: TaskListItem;
  allTasks: TaskListItem[];
  selectedTaskId: string | null;
  onTask: (task: TaskListItem) => void;
  lookForTask: LookForTask;
  child?: boolean;
  showOrigin?: boolean;
  // 行首那枚项目徽标画不画。默认画（有徽标表就说明是任务模式）；**被项目分组装着的行
  // 传 false** —— 组头已经写着项目名，每行再标一次就是把「弱化」做反了。
  showProject?: boolean;
  leading?: React.ReactNode;
  wrapperClassName?: string;
  trailing?: React.ReactNode;
}) {
  const selected = selectedTaskId === task.id;
  const look = lookForTask(task);
  const hasOrigin = showOrigin && taskParentLink(task, allTasks) !== null;
  // 当前就在本机运行的任务（含接力转入、已经移回）按普通任务展示；接力只在真正
  // 离开本机但尚未确认的存档行上留图标。确认转出的任务本来就只出现在“其他机器”。
  const showHandoffMeta = task.handoff?.direction === "out";
  const canStar = task.parentId === null;
  const spreadRow = useSpreadRow();
  const spreadCells = spreadRow?.spread.laidOut ? spreadRow : null;
  // 执行者行不挂徽标：它缩进在团队行底下，跟着上面那行走，同一个项目再标一次只是噪音。
  const actions = useContext(TaskTreeActionsContext);
  // 行尾队列徽标「位次/总数」：谁在等谁本来只有点进详情才看得到。执行者行不挂 ——
  // 它们的队列由调度者管理，抽屉也只读。总数从列表就地数（抽屉打开才取权威数据）。
  const queueTotal = task.queueId != null ? allTasks.filter((item) => item.queueId === task.queueId).length : 0;
  const openQueue = actions?.onOpenQueue;
  const queueBadge = task.queueId != null && task.parentId === null && openQueue
    ? (
      <span className="workspace-queue-badge" role="button" tabIndex={0}
        aria-label={`队列第 ${(task.queuePosition ?? 0) + 1} / ${queueTotal} 位，查看队列`}
        onClick={(event) => { event.stopPropagation(); openQueue(task.queueId!); }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          openQueue(task.queueId!);
        }}>
        <ListNumbers size={11} weight="bold" aria-hidden="true" />
        {(task.queuePosition ?? 0) + 1}/{queueTotal}
      </span>
    )
    : null;
  const hasMeta = task.mode === "duet" || showHandoffMeta || trailing != null || queueBadge != null;
  const project = canStar && showProject ? actions?.projectBadges?.get(task.projectId) : undefined;
  // 行尾常驻的那几样：等什么（两三个字）、团队任务、置顶。都是灰的，平时就在；智能体开的
  // 那颗机器人图标是能点的（去来源任务），所以它跟星标一样是行外面的兄弟，不在这一组里。
  const isTeam = task.mode === "team" && task.parentId === null;
  const pinned = canStar && task.pinnedAt != null;
  // 智能体开的、却查不到来源任务的（外部智能体自报、群聊委派）：没地方可去，就只画一颗看的
  // 机器人。查得到来源的那种由下面的 OriginTaskChip 画成能点的那一颗。
  const agentOnly = showOrigin && !hasOrigin && task.creationOrigin?.kind === "agent" ? taskCreationLabel(task.creationOrigin) : null;
  const hasEnd = !!look.word || isTeam || pinned || !!agentOnly;
  return (
    <div className={`workspace-task-row-wrap ui-selectable${selected ? " is-selected" : ""}${wrapperClassName ? ` ${wrapperClassName}` : ""}${spreadCells && look.bucket === "todo" ? " is-todo" : ""}${hasEnd ? " has-end" : ""}${task.starredAt != null ? " has-star" : ""}${queueBadge ? " has-queue" : ""}${canStar ? " can-star" : ""}`}>
      <span className="workspace-task-leading">
        {leading ?? <RowMark look={look} />}
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
        {hasEnd && (
          <span className="workspace-task-end">
            <RowWord look={look} />
            {isTeam && <RowGlyph icon={UsersThree} label="团队任务" />}
            {agentOnly && <RowGlyph icon={Robot} label={agentOnly} />}
            {pinned && <RowGlyph icon={PushPin} label="已置顶" />}
          </span>
        )}
        {hasMeta && (
          <span className="workspace-task-meta">
            {task.mode === "duet" && <ChatsCircle size={12} weight="bold" className="workspace-task-kind" aria-label="讨论" />}
            {showHandoffMeta && task.handoff && (
              <PaperPlaneTilt
                size={12}
                weight="bold"
                className="workspace-task-kind"
                aria-label={task.handoff.pending
                  && Object.prototype.hasOwnProperty.call(task.handoff, "returnTransferId")
                  ? "移回未确认"
                  : "接力转出"}
              />
            )}
            {queueBadge}
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

function WorkerSummary({ workers, lookForTask }: { workers: TaskListItem[]; lookForTask: LookForTask }) {
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
            && lookForTask(worker).mark != null,
          );
          return sample ? <RowMark key={bucket.label} look={lookForTask(sample)} small /> : null;
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
  lookForTask,
  showProject = true,
}: {
  task: TaskListItem;
  tasks: TaskListItem[];
  allTasks: TaskListItem[];
  selectedTaskId: string | null;
  onTask: (task: TaskListItem) => void;
  lookForTask: LookForTask;
  showProject?: boolean;
}) {
  const workers = workersOf(tasks, task.id);
  const selectedWorkerIndex = workers.findIndex((worker) => worker.id === selectedTaskId);
  const selectedWorker = selectedWorkerIndex >= 0;
  const overflowSelectedId = selectedWorkerIndex >= TASK_PREVIEW_LIMIT ? workers[selectedWorkerIndex]?.id ?? null : null;
  const [expanded, setExpanded] = useState(selectedWorker);
  // 执行者多的时候也是一次一页（跟主列表同一套，见 TaskReveal）：几十个执行者的团队
  // 点一下全铺出来，上下文里其它任务全被挤走。
  const overflowWorkers = Math.max(0, workers.length - TASK_PREVIEW_LIMIT);
  const { revealed, more, collapse, revealIndex } = useReveal(overflowWorkers);
  const revealOverflowWorkers = useCallback(
    () => revealIndex(selectedWorkerIndex - TASK_PREVIEW_LIMIT),
    [revealIndex, selectedWorkerIndex],
  );
  useRevealHiddenSelection(overflowSelectedId, revealOverflowWorkers);
  const look = lookForTask(task);
  const visibleWorkers = workers.slice(0, TASK_PREVIEW_LIMIT + revealed);
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
        lookForTask={lookForTask}
        showProject={showProject}
        wrapperClassName={`workspace-team-row${expanded ? " is-expanded" : ""}`}
        leading={
          <span className="workspace-team-leading">
            <RowMark look={look} />
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
        trailing={<WorkerSummary workers={workers} lookForTask={lookForTask} />}
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
              lookForTask={lookForTask}
              trailing={<span className="workspace-worker-executor">{worker.executorLabel || worker.agentType || "执行者"}</span>}
            />
          ))}
          {workers.length > TASK_PREVIEW_LIMIT && (
            <RevealMore revealed={revealed} total={overflowWorkers} onMore={more} onCollapse={collapse} />
          )}
        </div>
      )}
    </>
  );
}

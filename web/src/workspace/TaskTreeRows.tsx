import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ProjectView, TaskListItem } from "@ash/shared";
import { statusCounts, workersOf } from "@ash/shared/team";
import { CaretRight, ChatsCircle, PaperPlaneTilt, PushPin, Robot, UsersThree, type Icon } from "@phosphor-icons/react";
import { OriginTaskChip, taskParentLink } from "../components/TaskOrigin.tsx";
import { taskCreationLabel } from "@ash/shared/task-origin";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { readRenamedStorage } from "../lib/renamedStorage.ts";
import type { TaskLook } from "../lib/taskLook.ts";
import { type LookForTask } from "../lib/useTaskReadState.ts";
import { ProjectAvatar } from "./ProjectAvatar.tsx";
import { RevealMore, useReveal } from "./TaskReveal.tsx";
import { SpreadRowCells, useSpreadRow } from "./TaskSpread.tsx";
import { advanceHiddenReveal } from "./taskTreeModel.ts";

// 侧栏任务树的**一行**长什么样：状态点、团队展开、铺开后多出来的那几格。
// 分节、排序和「哪些行进来」在 TaskTree.tsx / taskTreeModel.ts。

export const TASK_PREVIEW_LIMIT = 12;
const COLLAPSED_SECTIONS_STORAGE_KEY = "ash:task-tree:collapsed-sections";

// TaskRow 埋在几种列表里，行上要用的表和入口用 context 递，免得每层组件都多几个 props。
// 行首那枚项目徽标只在「任务模式」出现，给的是 id→项目 的表；没有表就是单项目态，不画徽标。
type TaskTreeActions = {
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

// 父任务行尾那句短语（运行中、等你答复……，表在 lib/taskLook 的 phraseWord）：它不画圆点，
// 箭头占着行首那一格。琥珀 = 轮到你，红 = 出事了，其余淡灰。指上去说是谁、在等什么。
function RowPhrase({ look }: { look: TaskLook }) {
  const tip = useHoverTip();
  const phrase = look.phrase;
  if (!phrase) return null;
  return (
    <>
      <span className={`workspace-task-word workspace-task-phrase${phrase.tone ? ` is-${phrase.tone}` : ""}`} {...tip.anchorProps}>{phrase.word}</span>
      <HoverTip at={tip.at}>{phrase.tip}</HoverTip>
    </>
  );
}

// 父任务行首那颗展开箭头：一直在（这一格不再画圆点）。名下一条可展开的都没有时不画，槽位留着。
export function ParentCaret({ expanded, label, disabled = false, onToggle }: {
  expanded: boolean;
  label: string;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className="workspace-team-caret"
      type="button"
      disabled={disabled}
      aria-label={label}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <CaretRight size={10} weight="bold" className={expanded ? "is-open" : ""} aria-hidden="true" />
    </button>
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

// 行尾「第几位/共几位」：谁在等谁本来只有点进详情才看得到。跟等什么、置顶一样常驻在行尾那组，
// 只是两个灰数字；点它打开队列抽屉（抽屉挂在 TaskTree 顶层）。
function QueueRank({ queueId, rank, total, onOpen }: { queueId: string; rank: number; total: number; onOpen: (queueId: string) => void }) {
  const tip = useHoverTip();
  const label = `队列第 ${rank} / ${total} 位，点开看队列`;
  return (
    <>
      <span
        className="workspace-queue-rank"
        role="button"
        tabIndex={0}
        aria-label={label}
        {...tip.anchorProps}
        onClick={(event) => { event.stopPropagation(); onOpen(queueId); }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          onOpen(queueId);
        }}
      >
        {rank}<small>/{total}</small>
      </span>
      <HoverTip at={tip.at}>{label}</HoverTip>
    </>
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
  parent = false,
  onExpand,
  showOrigin = true,
  showProject = true,
  leading,
  wrapperClassName = "",
  trailing,
  tally,
}: {
  task: TaskListItem;
  allTasks: TaskListItem[];
  selectedTaskId: string | null;
  onTask: (task: TaskListItem) => void;
  lookForTask: LookForTask;
  child?: boolean;
  /** 父任务（名下收着派出去的任务、团队调度台）：行首不画圆点（leading 只放箭头），行尾写短语。 */
  parent?: boolean;
  /** 父任务：点这一行（打开它自己）时把名下那一层展开。只开不收，收起用行首箭头。 */
  onExpand?: () => void;
  showOrigin?: boolean;
  // 行首那枚项目徽标画不画。默认画（有徽标表就说明是任务模式）；**被项目分组装着的行
  // 传 false** —— 组头已经写着项目名，每行再标一次就是把「弱化」做反了。
  showProject?: boolean;
  leading?: React.ReactNode;
  wrapperClassName?: string;
  trailing?: React.ReactNode;
  // 行尾常驻的那个数（名下收着几条派出去的任务，见 DispatchTreeRows）。
  tally?: React.ReactNode;
}) {
  const selected = selectedTaskId === task.id;
  const open = () => { onExpand?.(); onTask(task); };
  const look = lookForTask(task);
  const hasOrigin = showOrigin && taskParentLink(task, allTasks) !== null;
  // 当前就在本机运行的任务（含接力转入、已经移回）按普通任务展示；接力只在真正
  // 离开本机但尚未确认的存档行上留图标。确认转出的任务本来就只出现在“其他机器”。
  const showHandoffMeta = task.handoff?.direction === "out";
  const topLevel = task.parentId === null;
  const spreadRow = useSpreadRow();
  const spreadCells = spreadRow?.spread.laidOut ? spreadRow : null;
  // 执行者行不挂徽标：它缩进在团队行底下，跟着上面那行走，同一个项目再标一次只是噪音。
  const actions = useContext(TaskTreeActionsContext);
  // 执行者行不挂队列名次 —— 它们的队列由调度者管理，抽屉也只读。名次是服务端给的（连续，
  // 0 起）；总数从列表就地数，同队成员同属一个项目，列表里一定都在。
  const openQueue = actions?.onOpenQueue;
  const queueRank = task.queueId != null && task.queuePosition != null && topLevel && openQueue
    ? <QueueRank queueId={task.queueId} rank={task.queuePosition + 1} total={allTasks.filter((item) => item.queueId === task.queueId).length} onOpen={openQueue} />
    : null;
  const hasMeta = task.mode === "duet" || showHandoffMeta || trailing != null;
  const project = topLevel && showProject ? actions?.projectBadges?.get(task.projectId) : undefined;
  // 行尾常驻的那几样：等什么（两三个字）、团队任务、置顶、排第几。都是灰的，平时就在；智能体开的
  // 那颗机器人图标是能点的（去来源任务），所以它是行外面的兄弟，不在这一组里。
  const isTeam = task.mode === "team" && topLevel;
  const pinned = topLevel && task.pinnedAt != null;
  // 智能体开的、却查不到来源任务的（外部智能体自报、群聊委派）：没地方可去，就只画一颗看的
  // 机器人。查得到来源的那种由下面的 OriginTaskChip 画成能点的那一颗。
  const agentOnly = showOrigin && !hasOrigin && task.creationOrigin?.kind === "agent" ? taskCreationLabel(task.creationOrigin) : null;
  const hasEnd = (parent ? !!look.phrase : !!look.word) || isTeam || pinned || !!agentOnly || queueRank != null || tally != null;
  return (
    <div className={`workspace-task-row-wrap ui-selectable${selected ? " is-selected" : ""}${wrapperClassName ? ` ${wrapperClassName}` : ""}${spreadCells && look.bucket === "todo" ? " is-todo" : ""}${hasEnd ? " has-end" : ""}`}>
      <span className="workspace-task-leading">
        {parent ? leading : leading ?? <RowMark look={look} />}
      </span>
      <button
        className={`workspace-task-row${child ? " workspace-task-row--child" : ""}${hasOrigin ? " workspace-task-row--has-origin" : ""}`}
        type="button"
        aria-selected={selected}
        data-task-id={task.id}
        onClick={open}
        title={task.title}
      >
        {project && <TaskProjectBadge project={project} />}
        <span className="workspace-task-title">{task.title || "未命名任务"}</span>
        {hasEnd && (
          <span className="workspace-task-end">
            {parent ? <RowPhrase look={look} /> : <RowWord look={look} />}
            {isTeam && <RowGlyph icon={UsersThree} label="团队任务" />}
            {agentOnly && <RowGlyph icon={Robot} label={agentOnly} />}
            {pinned && <RowGlyph icon={PushPin} label="已置顶" />}
            {queueRank}
            {tally}
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
            {trailing}
          </span>
        )}
      </button>
      {spreadCells && <SpreadRowCells task={task} ctx={spreadCells} onOpen={open} />}
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
        parent
        onExpand={workers.length ? () => setExpanded(true) : undefined}
        wrapperClassName={`workspace-team-row${expanded ? " is-expanded" : ""}`}
        leading={
          <ParentCaret
            expanded={expanded}
            disabled={!workers.length}
            label={expanded ? "折叠执行者" : `展开 ${workers.length} 个执行者`}
            onToggle={() => setExpanded((value) => !value)}
          />
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

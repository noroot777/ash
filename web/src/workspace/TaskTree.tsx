import { useCallback, useMemo, useState } from "react";
import type { HandoffTarget, ProjectView, TaskListItem } from "@ash/shared";
import { CaretRight } from "@phosphor-icons/react";
import { useTaskReadState, type IndicatorForTask } from "../lib/useTaskReadState.ts";
import { ProjectAvatar } from "./ProjectAvatar.tsx";
import { SpreadPeekLayer, SpreadRowProvider, useSpreadPeek } from "./TaskSpread.tsx";
import {
  TASK_PREVIEW_LIMIT,
  TaskRow,
  TaskTreeActionsProvider,
  TeamRow,
  useCollapsedSections,
  useRevealHiddenSelection,
} from "./TaskTreeRows.tsx";
import { scopeTasks, type TaskScope } from "./taskScope.ts";
import {
  indexWorkers,
  matchesSpreadFilter,
  SPREAD_FILTERS,
  workersFrom,
  type SidebarSpread,
  type SpreadFilter,
  type WorkerIndex,
} from "./useSidebarSpread.ts";
import { buildTaskTree, groupTasksByProject, orderedTopLevelTasks, previewTasksByAge } from "./taskTreeModel.ts";
import { OutboundStatusBar, type OutboundBar } from "./OutboundStatusBar.tsx";
import { HandoffMachines } from "./HandoffMachines.tsx";

type TaskTreeProps = {
  projects: ProjectView[];
  currentProjectId: string | null;
  scope: TaskScope;
  tasks: TaskListItem[];
  selectedTaskId: string | null;
  selectedRemoteTaskId: string | null;
  spread: SidebarSpread;
  onTask: (task: TaskListItem) => void;
  onRemoteTask: (task: TaskListItem, target: HandoffTarget) => void;
  onTaskStarred: (taskId: string, starredAt: number | null) => void;
  onHandoffFinished: () => Promise<void> | void;
  outbound: OutboundBar;
  notify: (message: string) => void;
};

// 主列表：作用域里的顶层任务，按 taskTreeModel 的第一原则（更新时间倒序，置顶除外）分节。
// 「当前项目」和「任务模式」共用它 —— 两态的区别只有喂进来的是哪一批任务，以及「任务」那
// 一节要不要再按项目分一层；另起一套「全局列表」组件只会让排序、年龄闸、筛选空态三处各活一份。
function ScopedTaskTree({
  tasks,
  allTasks,
  selectedTaskId,
  onTask,
  indicatorForTask,
  filter,
  onClearFilter,
  emptyText,
  machineSection,
  workerIndex,
  projectIndex,
  includeElsewhere,
  outbound,
}: {
  tasks: TaskListItem[];
  allTasks: TaskListItem[];
  selectedTaskId: string | null;
  onTask: (task: TaskListItem) => void;
  indicatorForTask: IndicatorForTask;
  filter: SpreadFilter;
  onClearFilter: () => void;
  // 一条不剩时说什么。单项目态是「还没有任务」，任务模式得说清它本来就只收两类行，
  // 否则空列表看着像「所有项目的任务都不见了」。
  emptyText: string;
  machineSection: React.ReactNode;
  // 团队的桶写在执行者身上（见 lib/taskAttention 的 spreadBucket），筛选这一层也要它。
  workerIndex: WorkerIndex;
  // 给了表就把「任务」那一节再按项目分组（任务模式）；null = 不分组（单项目态，
  // 一节里全是同一个项目，分了等于给每一行加个没信息量的帽子）。
  projectIndex: Map<string, ProjectView> | null;
  // 接力出去的行留不留在这份列表里（判据见 taskScope 的 visibleInScope）。
  includeElsewhere: boolean;
  // 这一轮联系不上的持有机。它们上面那些行只能显示接力当时的旧状态 —— 列表要么说出来，
  // 要么就是在拿冻住的状态冒充实时。
  outbound: OutboundBar;
}) {
  const sections = useMemo(
    () => buildTaskTree(tasks, { unifiedPinned: true, includeElsewhere }),
    [includeElsewhere, tasks],
  );
  const { collapsed, toggle: toggleCollapsed } = useCollapsedSections();
  // 星标和「等你验收」的行永不因为旧被藏起来：一个是用户手动按的记号，一个是没盖的章，
  // 两者都属于「我要一直看得见」。判据跟行首那颗点同源，标出来的和留下来的必须是同一批。
  const keepVisible = useCallback(
    (task: TaskListItem) => task.starredAt != null || task.pinnedAt != null || indicatorForTask(task) === "unaccepted",
    [indicatorForTask],
  );
  const keptBySection = useMemo(
    () => sections.map((section) => ({
      section,
      kept: section.tasks.filter((task) => matchesSpreadFilter(task, filter, workersFrom(workerIndex, task.id))),
    })),
    [filter, sections, workerIndex],
  );
  // 真正画出来的一个个「行块」。分组与否只改这一层：下面的年龄闸、展开状态、选中揭示
  // 全按 group.key 走，所以两种排法共用同一套逻辑，不会一边修好另一边还漏着。
  //
  // 只有「任务」那一节分组。置顶不分 —— 它是用户手动摁下去的一小撮，按项目切开等于
  // 把「我要一直盯着这几条」拆成好几段。
  const layout = useMemo(
    () => keptBySection.map(({ section, kept }) => {
      const grouped = !!projectIndex && section.key === "rest";
      return {
        section,
        kept,
        grouped,
        groups: grouped
          ? groupTasksByProject(kept).map((group) => ({
            key: `project:${group.projectId}`,
            project: projectIndex?.get(group.projectId) ?? null,
            tasks: group.tasks,
          }))
          : [{ key: section.key, project: null as ProjectView | null, tasks: kept }],
      };
    }),
    [keptBySection, projectIndex],
  );
  const hiddenSelection = useMemo(() => {
    if (!selectedTaskId) return null;
    for (const entry of layout) {
      for (const group of entry.groups) {
        if (previewTasksByAge(group.tasks, Date.now(), keepVisible).hidden.some((task) => task.id === selectedTaskId)) {
          return { sectionKey: group.key, taskId: selectedTaskId };
        }
      }
    }
    return null;
  }, [keepVisible, layout, selectedTaskId]);
  const [previewExpandedSections, setPreviewExpandedSections] = useState<Set<string>>(
    () => hiddenSelection ? new Set([hiddenSelection.sectionKey]) : new Set(),
  );
  const revealHiddenSection = useCallback(() => {
    const sectionKey = hiddenSelection?.sectionKey;
    if (!sectionKey) return;
    setPreviewExpandedSections((current) => {
      if (current.has(sectionKey)) return current;
      const next = new Set(current);
      next.add(sectionKey);
      return next;
    });
  }, [hiddenSelection?.sectionKey]);
  useRevealHiddenSelection(
    hiddenSelection ? `${hiddenSelection.sectionKey}:${hiddenSelection.taskId}` : null,
    revealHiddenSection,
  );
  const togglePreview = (sectionKey: string) => setPreviewExpandedSections((current) => {
    const next = new Set(current);
    if (next.has(sectionKey)) next.delete(sectionKey);
    else next.add(sectionKey);
    return next;
  });
  // 空态**只有下面那一处**。这里曾经还有一个提前 return：一条行都不剩时直接返回那句
  // 「没有任务」，把后面正常分支里的东西全绕过去 —— 于是最需要解释的那一刻反而没了解释：
  // 出站行因为持有机联系不上退回冻住的状态、正好又是唯一候选时，用户看到的是
  // 「没有在跑、等你答复或待验收的任务」，而屏幕上本该写着「联系不上 mac-mini」。
  // 同一句话有两份拷贝，补一处漏一处；删掉那份，让所有情况都走同一条渲染路径。
  type RenderGroup = (typeof layout)[number]["groups"][number];
  // 一个行块的内容：年龄闸筛过的那几行 +「显示另外 N 条」。分节和项目分组共用它。
  const renderRows = (group: RenderGroup, showProject: boolean) => {
    const preview = previewTasksByAge(group.tasks, Date.now(), keepVisible);
    const previewExpanded = previewExpandedSections.has(group.key);
    const visibleTasks = previewExpanded ? group.tasks : preview.visible;
    const hiddenCount = preview.hidden.length;
    return (
      <>
        {visibleTasks.map((task) =>
          task.mode === "team" ? (
            <TeamRow
              key={task.id}
              task={task}
              tasks={tasks}
              allTasks={allTasks}
              selectedTaskId={selectedTaskId}
              onTask={onTask}
              indicatorForTask={indicatorForTask}
              showProject={showProject}
            />
          ) : (
            <TaskRow key={task.id} task={task} allTasks={allTasks} selectedTaskId={selectedTaskId} onTask={onTask} indicatorForTask={indicatorForTask} showProject={showProject} />
          ),
        )}
        {hiddenCount > 0 && (
          <button className="workspace-task-more" type="button" onClick={() => togglePreview(group.key)}>
            {previewExpanded ? "收起" : `显示另外 ${hiddenCount} 条`}
          </button>
        )}
      </>
    );
  };
  // 项目分组头。**要求就是别显眼**：它给列表分段，不是一级导航，所以没有底色没有边框、
  // 没有项目色点，字比分节标题还小一号。折叠状态跟分节共用同一份 localStorage
  //（键加了 `project:` 前缀），刷新后还记得你收起过谁。
  const renderProjectGroup = (group: RenderGroup) => {
    const name = group.project?.name ?? "未知项目";
    const groupCollapsed = collapsed.has(group.key);
    return (
      <div className={`workspace-task-project-group${groupCollapsed ? " is-collapsed" : ""}`} key={group.key}>
        <button
          className="workspace-task-project-head"
          type="button"
          aria-expanded={!groupCollapsed}
          aria-label={`${groupCollapsed ? "展开" : "折叠"}项目 ${name}`}
          onClick={() => toggleCollapsed(group.key)}
        >
          <CaretRight size={9} weight="bold" aria-hidden="true" />
          <b>{name}</b>
          <em>{group.tasks.length}</em>
        </button>
        {!groupCollapsed && renderRows(group, false)}
      </div>
    );
  };
  const renderSection = (entry: (typeof layout)[number] | undefined) => {
    if (!entry?.kept.length) return null;
    const { section, grouped, groups } = entry;
    // 分组时这一节自己不再顶一个「任务」标题：项目那一行已经在分段了，再压一层标题
    // 就是三级帽子叠在一起，跟「弱化」正好反着来。
    const sectionCollapsed = !grouped && collapsed.has(section.key);
    return (
      <section className={`workspace-task-section${sectionCollapsed ? " is-collapsed" : ""}${grouped ? " workspace-task-section--grouped" : ""}`} data-task-section={section.key} key={section.key}>
        {!grouped && (
          <button
            className="workspace-task-section-title workspace-task-section-toggle"
            type="button"
            aria-expanded={!sectionCollapsed}
            aria-label={`${sectionCollapsed ? "展开" : "折叠"}${section.label}`}
            onClick={() => toggleCollapsed(section.key)}
          >
            <span>{section.label}</span>
            <CaretRight size={10} weight="bold" aria-hidden="true" />
          </button>
        )}
        {grouped
          ? groups.map(renderProjectGroup)
          : !sectionCollapsed && renderRows(groups[0]!, true)}
      </section>
    );
  };
  const pinned = layout.find((entry) => entry.section.key === "pinned");
  const rest = layout.find((entry) => entry.section.key === "rest");
  const noVisibleTasks = !layout.some((entry) => entry.kept.length);
  return (
    <>
      <OutboundStatusBar {...outbound} />
      {renderSection(pinned)}
      {machineSection}
      {renderSection(rest)}
      {/* 一条不剩时必须自己说出来，还得给条退路：窄态那排点很小，不说清楚的话看着就是
          「任务全没了」。它排在离线提示**之后** —— 两句话可以同时出现，而且先说清楚
          「有台机器问不到」，再说「剩下的没有」。 */}
      {noVisibleTasks && (
        <p className="workspace-task-empty">
          {filter === "all" ? emptyText : `当前「${SPREAD_FILTERS.find((item) => item.key === filter)?.label ?? filter}」筛选下没有任务`}
          {filter !== "all" && <button className="workspace-task-empty-action" type="button" onClick={onClearFilter}>显示全部</button>}
        </p>
      )}
    </>
  );
}

// 单项目态下方那一叠折叠起来的别家项目。任务模式不画它 —— 那时候别家的行已经按
// 「在跑 / 待验收」混在上面同一份列表里了，再摆一遍等于同一条任务在侧栏出现两次，
// 而且这一叠是不筛状态的全集，跟模式本身的口径也对不上。
function OtherProject({
  project,
  tasks,
  allTasks,
  selectedTaskId,
  onTask,
  indicatorForTask,
}: {
  project: ProjectView;
  tasks: TaskListItem[];
  allTasks: TaskListItem[];
  selectedTaskId: string | null;
  onTask: (task: TaskListItem) => void;
  indicatorForTask: IndicatorForTask;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const ordered = useMemo(() => orderedTopLevelTasks(tasks), [tasks]);
  const visible = showAll ? ordered : ordered.slice(0, TASK_PREVIEW_LIMIT);
  return (
    <div className="workspace-other-project">
      <button
        className="workspace-other-project-head ui-selectable"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <CaretRight size={10} weight="bold" className={expanded ? "is-open" : ""} aria-hidden="true" />
        <ProjectAvatar project={project} size="small" />
        <span>{project.name}</span>
      </button>
      {expanded && (
        <div className="workspace-other-project-tasks">
          {visible.map((task) => (
            <TaskRow key={task.id} task={task} allTasks={allTasks} selectedTaskId={selectedTaskId} onTask={onTask} indicatorForTask={indicatorForTask} />
          ))}
          {ordered.length > TASK_PREVIEW_LIMIT && (
            <button className="workspace-task-more" type="button" onClick={() => setShowAll((value) => !value)}>
              {showAll ? "收起" : `显示另外 ${ordered.length - TASK_PREVIEW_LIMIT} 条`}
            </button>
          )}
          {!ordered.length && <p>没有任务</p>}
        </div>
      )}
    </div>
  );
}

export function TaskTree({ projects, currentProjectId, scope, tasks, selectedTaskId, selectedRemoteTaskId, spread, onTask, onRemoteTask, onTaskStarred, onHandoffFinished, outbound, notify }: TaskTreeProps) {
  const { indicatorForTask } = useTaskReadState(tasks, selectedTaskId);
  const activeTasks = useMemo(() => tasks.filter((task) => !task.archived), [tasks]);
  // 主列表看哪些行只由作用域决定（scopeTasks 是唯一判据，跟计数、筛选、J/K 遍历同源）。
  const scopedTasks = useMemo(() => scopeTasks(activeTasks, scope), [activeTasks, scope]);
  const taskMode = scope.kind === "tasks";
  const otherProjects = taskMode ? [] : projects.filter((project) => project.id !== currentProjectId);
  const currentProject = projects.find((project) => project.id === currentProjectId) ?? null;
  // 徽标表只在任务模式给：单项目态下每行都是同一个项目，标了纯属占地方。
  const projectBadges = useMemo(
    () => taskMode ? new Map(projects.map((project) => [project.id, project])) : null,
    [projects, taskMode],
  );
  const { peek, peekAt, peekOut, hold, hide } = useSpreadPeek(spread.laidOut);
  const rowContext = useMemo(() => ({ spread, peekAt, peekOut }), [peekAt, peekOut, spread]);
  // 执行者表按**全量**建（不是 scopedTasks）：团队的桶要它真实的执行者集合。
  const workerIndex = useMemo(() => indexWorkers(tasks), [tasks]);
  const treeActions = useMemo(
    () => ({ onStarred: onTaskStarred, notify, projectBadges, workerIndex }),
    [notify, onTaskStarred, projectBadges, workerIndex],
  );
  return (
    <TaskTreeActionsProvider value={treeActions}>
    <SpreadRowProvider value={rowContext}>
      <nav className="workspace-task-tree" aria-label={taskMode ? "任务模式列表" : "任务树"} onScroll={hide}>
        <ScopedTaskTree
          tasks={scopedTasks}
          allTasks={tasks}
          selectedTaskId={selectedTaskId}
          onTask={onTask}
          indicatorForTask={indicatorForTask}
          filter={spread.filter}
          onClearFilter={() => spread.setFilter("all")}
          emptyText={taskMode ? "没有在跑、等你答复或待验收的任务" : "还没有任务"}
          workerIndex={workerIndex}
          projectIndex={projectBadges}
          includeElsewhere={taskMode}
          outbound={taskMode ? outbound : { ...outbound, outboundCount: 0 }}
          machineSection={taskMode ? null : <HandoffMachines project={currentProject} tasks={tasks} selectedRemoteTaskId={selectedRemoteTaskId} onRemoteTask={onRemoteTask} notify={notify} onFinished={onHandoffFinished} />}
        />
        {otherProjects.length > 0 && (
          <section className="workspace-other-projects">
            <header className="workspace-task-section-title">其他项目</header>
            {otherProjects.map((project) => (
              <OtherProject
                key={project.id}
                project={project}
                tasks={activeTasks.filter((task) => task.projectId === project.id)}
                allTasks={tasks}
                selectedTaskId={selectedTaskId}
                onTask={onTask}
                indicatorForTask={indicatorForTask}
              />
            ))}
          </section>
        )}
      </nav>
      <SpreadPeekLayer peek={peek} spread={spread} onHold={hold} onLeave={peekOut} onDismiss={hide} />
    </SpreadRowProvider>
    </TaskTreeActionsProvider>
  );
}

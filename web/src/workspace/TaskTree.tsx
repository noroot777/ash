import { useCallback, useMemo, useState } from "react";
import type { ProjectView, Task } from "@ash/shared";
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
import { inScope, type TaskScope } from "./taskScope.ts";
import { matchesSpreadFilter, SPREAD_FILTERS, type SidebarSpread, type SpreadFilter } from "./useSidebarSpread.ts";
import { buildTaskTree, orderedTopLevelTasks, previewTasksByAge } from "./taskTreeModel.ts";
import { HandoffMachines } from "./HandoffMachines.tsx";

type TaskTreeProps = {
  projects: ProjectView[];
  currentProjectId: string | null;
  scope: TaskScope;
  tasks: Task[];
  selectedTaskId: string | null;
  spread: SidebarSpread;
  onTask: (task: Task) => void;
  onTaskStarred: (taskId: string, starredAt: number | null) => void;
  onHandoffFinished: () => Promise<void> | void;
  notify: (message: string) => void;
};

// 主列表：作用域里的顶层任务，按 taskTreeModel 的第一原则（更新时间倒序，置顶除外）分节。
// 「当前项目」和「全部项目」共用它 —— 两态的区别只有喂进来的是哪一批任务，以及行首多不多
// 一枚项目徽标；另起一套「全局列表」组件只会让排序、年龄闸、筛选空态三处各活一份。
function ScopedTaskTree({
  tasks,
  allTasks,
  selectedTaskId,
  onTask,
  indicatorForTask,
  filter,
  onClearFilter,
  machineSection,
}: {
  tasks: Task[];
  allTasks: Task[];
  selectedTaskId: string | null;
  onTask: (task: Task) => void;
  indicatorForTask: IndicatorForTask;
  filter: SpreadFilter;
  onClearFilter: () => void;
  machineSection: React.ReactNode;
}) {
  const sections = useMemo(() => buildTaskTree(tasks, { unifiedPinned: true }), [tasks]);
  const { collapsed, toggle: toggleCollapsed } = useCollapsedSections();
  // 星标和「等你验收」的行永不因为旧被藏起来：一个是用户手动按的记号，一个是没盖的章，
  // 两者都属于「我要一直看得见」。判据跟行首那颗点同源，标出来的和留下来的必须是同一批。
  const keepVisible = useCallback(
    (task: Task) => task.starredAt != null || task.pinnedAt != null || indicatorForTask(task) === "unaccepted",
    [indicatorForTask],
  );
  const keptBySection = useMemo(
    () => sections.map((section) => ({
      section,
      kept: section.tasks.filter((task) => matchesSpreadFilter(task, filter)),
    })),
    [filter, sections],
  );
  const hiddenSelection = useMemo(() => {
    if (!selectedTaskId) return null;
    for (const { section, kept } of keptBySection) {
      if (previewTasksByAge(kept, Date.now(), keepVisible).hidden.some((task) => task.id === selectedTaskId)) {
        return { sectionKey: section.key, taskId: selectedTaskId };
      }
    }
    return null;
  }, [keepVisible, keptBySection, selectedTaskId]);
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
  // 一条不剩时必须自己说出来，还得给条退路：窄态那排点很小，不说清楚的话看着就是「任务全没了」。
  if (!keptBySection.some((entry) => entry.kept.length) && !machineSection) {
    const label = SPREAD_FILTERS.find((item) => item.key === filter)?.label ?? filter;
    return (
      <p className="workspace-task-empty">
        {filter === "all" ? "还没有任务" : `「${label}」下没有任务`}
        {filter !== "all" && (
          <button className="workspace-task-empty-action" type="button" onClick={onClearFilter}>显示全部</button>
        )}
      </p>
    );
  }
  const renderSection = (entry: (typeof keptBySection)[number] | undefined) => {
    if (!entry?.kept.length) return null;
    const { section, kept } = entry;
    const sectionCollapsed = collapsed.has(section.key);
    const preview = previewTasksByAge(kept, Date.now(), keepVisible);
    const previewExpanded = previewExpandedSections.has(section.key);
    const visibleTasks = previewExpanded ? kept : preview.visible;
    const hiddenCount = preview.hidden.length;
    return (
      <section className={`workspace-task-section${sectionCollapsed ? " is-collapsed" : ""}`} data-task-section={section.key} key={section.key}>
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
            {!sectionCollapsed && (
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
                    />
                  ) : (
                    <TaskRow key={task.id} task={task} allTasks={allTasks} selectedTaskId={selectedTaskId} onTask={onTask} indicatorForTask={indicatorForTask} />
                  ),
                )}
                {hiddenCount > 0 && (
                  <button className="workspace-task-more" type="button" onClick={() => togglePreview(section.key)}>
                    {previewExpanded ? "收起" : `显示另外 ${hiddenCount} 条`}
                  </button>
                )}
              </>
            )}
      </section>
    );
  };
  const pinned = keptBySection.find((entry) => entry.section.key === "pinned");
  const rest = keptBySection.find((entry) => entry.section.key === "rest");
  const noVisibleTasks = !keptBySection.some((entry) => entry.kept.length);
  return (
    <>
      {renderSection(pinned)}
      {machineSection}
      {renderSection(rest)}
      {noVisibleTasks && (
        <p className="workspace-task-empty">
          {filter === "all" ? "还没有任务" : `当前「${SPREAD_FILTERS.find((item) => item.key === filter)?.label ?? filter}」筛选下没有任务`}
          {filter !== "all" && <button className="workspace-task-empty-action" type="button" onClick={onClearFilter}>显示全部</button>}
        </p>
      )}
    </>
  );
}

// 单项目态下方那一叠折叠起来的别家项目。全部项目态不画它 —— 那时候所有项目的任务
// 已经混在上面同一份列表里了，再摆一遍等于同一条任务在侧栏出现两次。
function OtherProject({
  project,
  tasks,
  allTasks,
  selectedTaskId,
  onTask,
  indicatorForTask,
}: {
  project: ProjectView;
  tasks: Task[];
  allTasks: Task[];
  selectedTaskId: string | null;
  onTask: (task: Task) => void;
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

export function TaskTree({ projects, currentProjectId, scope, tasks, selectedTaskId, spread, onTask, onTaskStarred, onHandoffFinished, notify }: TaskTreeProps) {
  const { indicatorForTask } = useTaskReadState(tasks, selectedTaskId);
  const activeTasks = useMemo(() => tasks.filter((task) => !task.archived), [tasks]);
  // 主列表看哪些行只由作用域决定（inScope 是唯一判据，跟计数、筛选、J/K 遍历同源）。
  const scopedTasks = useMemo(
    () => activeTasks.filter((task) => inScope(task, scope)),
    [activeTasks, scope],
  );
  const allProjects = scope.kind === "all";
  const otherProjects = allProjects ? [] : projects.filter((project) => project.id !== currentProjectId);
  const currentProject = projects.find((project) => project.id === currentProjectId) ?? null;
  // 徽标表只在全部项目态给：单项目态下每行都是同一个项目，标了纯属占地方。
  const projectBadges = useMemo(
    () => allProjects ? new Map(projects.map((project) => [project.id, project])) : null,
    [allProjects, projects],
  );
  const { peek, peekAt, peekOut, hold, hide } = useSpreadPeek(spread.laidOut);
  const rowContext = useMemo(() => ({ spread, peekAt, peekOut }), [peekAt, peekOut, spread]);
  const treeActions = useMemo(
    () => ({ onStarred: onTaskStarred, notify, projectBadges }),
    [notify, onTaskStarred, projectBadges],
  );
  return (
    <TaskTreeActionsProvider value={treeActions}>
    <SpreadRowProvider value={rowContext}>
      <nav className="workspace-task-tree" aria-label={allProjects ? "全部项目任务" : "任务树"} onScroll={hide}>
        <ScopedTaskTree
          tasks={scopedTasks}
          allTasks={tasks}
          selectedTaskId={selectedTaskId}
          onTask={onTask}
          indicatorForTask={indicatorForTask}
          filter={spread.filter}
          onClearFilter={() => spread.setFilter("all")}
          machineSection={allProjects ? null : <HandoffMachines project={currentProject} tasks={tasks} notify={notify} onFinished={onHandoffFinished} />}
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

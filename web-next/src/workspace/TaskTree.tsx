import { useEffect, useMemo, useState } from "react";
import type { ProjectView, Task } from "@harness/shared";
import { statusCounts, workersOf } from "@harness/shared/team";
import { CaretRight, PushPin, Scales, UsersThree } from "@phosphor-icons/react";
import { OriginTaskChip, taskParentLink } from "../components/TaskOrigin.tsx";
import { TaskStatusDot } from "../components/TaskStatusDot.tsx";
import { useTaskReadState, type IndicatorForTask } from "../lib/useTaskReadState.ts";
import { ProjectAvatar } from "./ProjectAvatar.tsx";
import { buildTaskTree, orderedTopLevelTasks } from "./taskTreeModel.ts";

type TaskTreeProps = {
  projects: ProjectView[];
  currentProjectId: string | null;
  tasks: Task[];
  selectedTaskId: string | null;
  onTask: (task: Task) => void;
};

const TASK_PREVIEW_LIMIT = 12;

function StatusMarker({ indicator }: { indicator: ReturnType<IndicatorForTask> }) {
  return indicator
    ? <TaskStatusDot indicator={indicator} surface="workspace" />
    : <i className="workspace-status-dot workspace-status-dot--quiet" aria-hidden="true" />;
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

function TaskRow({
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
  const hasMeta = task.pinnedAt != null || task.mode === "debate" || trailing != null;
  return (
    <div className={`workspace-task-row-wrap ui-selectable${selected ? " is-selected" : ""}${wrapperClassName ? ` ${wrapperClassName}` : ""}`}>
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
        <span className="workspace-task-title">{task.title || "未命名任务"}</span>
        {hasMeta && (
          <span className="workspace-task-meta">
            {task.pinnedAt != null && <PushPin size={11} weight="fill" className="workspace-task-pin" aria-label="已置顶" />}
            {task.mode === "debate" && <Scales size={12} weight="bold" className="workspace-task-kind" aria-label="辩论" />}
            {trailing}
          </span>
        )}
      </button>
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

function TeamRow({
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
  const [expanded, setExpanded] = useState(selectedWorker);
  const [showAllWorkers, setShowAllWorkers] = useState(false);
  const indicator = indicatorForTask(task);
  const workersExpanded = showAllWorkers || selectedWorkerIndex >= TASK_PREVIEW_LIMIT;
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

function CurrentProjectTree({
  tasks,
  allTasks,
  selectedTaskId,
  onTask,
  indicatorForTask,
}: {
  tasks: Task[];
  allTasks: Task[];
  selectedTaskId: string | null;
  onTask: (task: Task) => void;
  indicatorForTask: IndicatorForTask;
}) {
  const sections = useMemo(() => buildTaskTree(tasks), [tasks]);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const toggleSection = (sectionKey: string) => setExpandedSections((current) => {
    const next = new Set(current);
    if (next.has(sectionKey)) next.delete(sectionKey);
    else next.add(sectionKey);
    return next;
  });
  if (!sections.length) return <p className="workspace-task-empty">还没有任务</p>;
  return (
    <>
      {sections.map((section) => {
        const selectedIndex = section.tasks.findIndex((task) => task.id === selectedTaskId);
        const expanded = expandedSections.has(section.key) || selectedIndex >= TASK_PREVIEW_LIMIT;
        const visibleTasks = expanded ? section.tasks : section.tasks.slice(0, TASK_PREVIEW_LIMIT);
        const hiddenCount = section.tasks.length - TASK_PREVIEW_LIMIT;
        return (
          <section className="workspace-task-section" key={section.key}>
            <header className="workspace-task-section-title">
              <span>{section.label}</span>
            </header>
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
            {section.tasks.length > TASK_PREVIEW_LIMIT && (
              <button className="workspace-task-more" type="button" onClick={() => toggleSection(section.key)}>
                {expanded ? "收起" : `显示另外 ${hiddenCount} 条`}
              </button>
            )}
          </section>
        );
      })}
    </>
  );
}

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

export function TaskTree({ projects, currentProjectId, tasks, selectedTaskId, onTask }: TaskTreeProps) {
  const { indicatorForTask } = useTaskReadState(tasks, selectedTaskId);
  const activeTasks = useMemo(() => tasks.filter((task) => !task.archived), [tasks]);
  const currentTasks = useMemo(
    () => activeTasks.filter((task) => task.projectId === currentProjectId),
    [activeTasks, currentProjectId],
  );
  const otherProjects = projects.filter((project) => project.id !== currentProjectId);
  return (
    <nav className="workspace-task-tree" aria-label="任务树">
      <CurrentProjectTree tasks={currentTasks} allTasks={tasks} selectedTaskId={selectedTaskId} onTask={onTask} indicatorForTask={indicatorForTask} />
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
  );
}

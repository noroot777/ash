import { useEffect, useMemo, useState } from "react";
import type { ProjectView, Task } from "@harness/shared";
import { taskDisplayStatus } from "@harness/shared";
import { statusCounts, workersOf } from "@harness/shared/team";
import { CaretRight, PushPin, Scales, UsersThree } from "@phosphor-icons/react";
import { useTaskReadState, type TaskStatusIndicator } from "../lib/useTaskReadState.ts";
import { ProjectAvatar } from "./ProjectAvatar.tsx";
import { buildTaskTree, orderedTopLevelTasks } from "./taskTreeModel.ts";

type TaskTreeProps = {
  projects: ProjectView[];
  currentProjectId: string | null;
  tasks: Task[];
  selectedTaskId: string | null;
  onTask: (task: Task) => void;
};

type IndicatorForTask = (task: Task) => TaskStatusIndicator | null;

function StatusDot({ task, indicator, small = false }: { task: Task; indicator: TaskStatusIndicator; small?: boolean }) {
  const display = taskDisplayStatus(task.status, task.stage, !!task.question);
  return (
    <i
      className={`workspace-status-dot workspace-status-dot--${indicator}${small ? " workspace-status-dot--small" : ""}`}
      title={display.label}
      aria-label={display.label}
    />
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
            ? <StatusDot key={bucket.label} task={sample} indicator={indicator} small />
            : null;
        })}
      </span>
    </span>
  );
}

function TaskRow({
  task,
  selectedTaskId,
  onTask,
  indicatorForTask,
  child = false,
  trailing,
}: {
  task: Task;
  selectedTaskId: string | null;
  onTask: (task: Task) => void;
  indicatorForTask: IndicatorForTask;
  child?: boolean;
  trailing?: React.ReactNode;
}) {
  const selected = selectedTaskId === task.id;
  const indicator = indicatorForTask(task);
  return (
    <button
      className={`workspace-task-row ui-selectable${child ? " workspace-task-row--child" : ""}${selected ? " is-selected" : ""}`}
      type="button"
      aria-selected={selected}
      data-task-id={task.id}
      onClick={() => onTask(task)}
      title={task.title}
    >
      {indicator && <StatusDot task={task} indicator={indicator} />}
      {task.pinnedAt != null && <PushPin size={11} weight="fill" className="workspace-task-pin" aria-label="已置顶" />}
      {task.mode === "debate" && <Scales size={12} weight="bold" className="workspace-task-kind" aria-label="辩论" />}
      <span className="workspace-task-title">{task.title || "未命名任务"}</span>
      {trailing}
    </button>
  );
}

function TeamRow({
  task,
  allTasks,
  selectedTaskId,
  onTask,
  indicatorForTask,
}: {
  task: Task;
  allTasks: Task[];
  selectedTaskId: string | null;
  onTask: (task: Task) => void;
  indicatorForTask: IndicatorForTask;
}) {
  const workers = workersOf(allTasks, task.id);
  const selectedWorker = workers.some((worker) => worker.id === selectedTaskId);
  const [expanded, setExpanded] = useState(selectedWorker);
  useEffect(() => {
    if (selectedWorker) setExpanded(true);
  }, [selectedWorker]);
  return (
    <>
      <div className="workspace-team-row">
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
        <TaskRow
          task={task}
          selectedTaskId={selectedTaskId}
          onTask={onTask}
          indicatorForTask={indicatorForTask}
          trailing={
            <>
              <WorkerSummary workers={workers} indicatorForTask={indicatorForTask} />
              <UsersThree size={13} weight="fill" className="workspace-task-kind" aria-label="团队任务" />
            </>
          }
        />
      </div>
      {expanded && workers.length > 0 && (
        <div className="workspace-worker-list">
          {workers.map((worker) => (
            <TaskRow
              key={worker.id}
              task={worker}
              child
              selectedTaskId={selectedTaskId}
              onTask={onTask}
              indicatorForTask={indicatorForTask}
              trailing={<span className="workspace-worker-executor">{worker.executorLabel || worker.agentType || "执行者"}</span>}
            />
          ))}
        </div>
      )}
    </>
  );
}

function CurrentProjectTree({
  tasks,
  selectedTaskId,
  onTask,
  indicatorForTask,
}: {
  tasks: Task[];
  selectedTaskId: string | null;
  onTask: (task: Task) => void;
  indicatorForTask: IndicatorForTask;
}) {
  const sections = useMemo(() => buildTaskTree(tasks), [tasks]);
  if (!sections.length) return <p className="workspace-task-empty">还没有任务</p>;
  return (
    <>
      {sections.map((section) => (
        <section className="workspace-task-section" key={section.key}>
          <header className="workspace-task-section-title">
            <span>{section.label}</span>
            <em>{section.count}</em>
          </header>
          {section.groups.map((group) => (
            <div className="workspace-task-group" key={group.key}>
              <div className="workspace-task-group-title">
                <span>{group.label}</span>
                <em>{group.tasks.length}</em>
              </div>
              {group.tasks.map((task) =>
                task.mode === "team" ? (
                  <TeamRow
                    key={task.id}
                    task={task}
                    allTasks={tasks}
                    selectedTaskId={selectedTaskId}
                    onTask={onTask}
                    indicatorForTask={indicatorForTask}
                  />
                ) : (
                  <TaskRow key={task.id} task={task} selectedTaskId={selectedTaskId} onTask={onTask} indicatorForTask={indicatorForTask} />
                ),
              )}
            </div>
          ))}
        </section>
      ))}
    </>
  );
}

function OtherProject({
  project,
  tasks,
  selectedTaskId,
  onTask,
  indicatorForTask,
}: {
  project: ProjectView;
  tasks: Task[];
  selectedTaskId: string | null;
  onTask: (task: Task) => void;
  indicatorForTask: IndicatorForTask;
}) {
  const [expanded, setExpanded] = useState(false);
  const ordered = useMemo(() => orderedTopLevelTasks(tasks), [tasks]);
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
        <em>{ordered.length}</em>
      </button>
      {expanded && (
        <div className="workspace-other-project-tasks">
          {ordered.map((task) => (
            <TaskRow key={task.id} task={task} selectedTaskId={selectedTaskId} onTask={onTask} indicatorForTask={indicatorForTask} />
          ))}
          {!ordered.length && <p>没有任务</p>}
        </div>
      )}
    </div>
  );
}

export function TaskTree({ projects, currentProjectId, tasks, selectedTaskId, onTask }: TaskTreeProps) {
  const indicatorForTask = useTaskReadState(tasks, selectedTaskId);
  const activeTasks = useMemo(() => tasks.filter((task) => !task.archived), [tasks]);
  const currentTasks = useMemo(
    () => activeTasks.filter((task) => task.projectId === currentProjectId),
    [activeTasks, currentProjectId],
  );
  const otherProjects = projects.filter((project) => project.id !== currentProjectId);
  return (
    <nav className="workspace-task-tree" aria-label="任务树">
      <CurrentProjectTree tasks={currentTasks} selectedTaskId={selectedTaskId} onTask={onTask} indicatorForTask={indicatorForTask} />
      {otherProjects.length > 0 && (
        <section className="workspace-other-projects">
          <header className="workspace-task-section-title">其他项目</header>
          {otherProjects.map((project) => (
            <OtherProject
              key={project.id}
              project={project}
              tasks={activeTasks.filter((task) => task.projectId === project.id)}
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

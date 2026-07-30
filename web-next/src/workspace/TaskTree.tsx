import { useEffect, useMemo, useState } from "react";
import type { ProjectView, Task, TaskStatus } from "@harness/shared";
import { taskDisplayStatus } from "@harness/shared";
import { statusCounts, workersOf } from "@harness/shared/team";
import { CaretRight, PushPin, Scales, UsersThree } from "@phosphor-icons/react";
import { ProjectAvatar } from "./ProjectAvatar.tsx";
import { buildTaskTree, orderedTopLevelTasks } from "./taskTreeModel.ts";

const COLLAPSED_GROUPS_STORAGE_KEY = "harness:taskList:collapsedStatuses";

type TaskTreeProps = {
  projects: ProjectView[];
  currentProjectId: string | null;
  tasks: Task[];
  selectedTaskId: string | null;
  onTask: (task: Task) => void;
};

function readCollapsedGroups(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState(readCollapsedGroups);
  const toggle = (key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        window.localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // localStorage can be unavailable; collapsing should still work for this session.
      }
      return next;
    });
  };
  return { collapsed, toggle };
}

function statusTone(task: Task): string {
  if (task.question) return "cyan";
  if (task.stage === "verify_failed" || task.status === "failed") return "red";
  if (task.stage === "verified" || task.stage === "awaiting_acceptance") return "green";
  if (task.stage === "accepted" || task.status === "done" || task.status === "canceled") return "gray";
  const tones: Record<TaskStatus, string> = {
    running: "green",
    idle: "gray",
    paused: "cyan",
    awaiting_review: "indigo",
    queued: "amber",
    backlog: "gray",
    done: "gray",
    failed: "red",
    canceled: "gray",
  };
  return tones[task.status];
}

function StatusDot({ task, small = false }: { task: Task; small?: boolean }) {
  const display = taskDisplayStatus(task.status, task.stage, !!task.question);
  return (
    <i
      className={`workspace-status-dot workspace-status-dot--${statusTone(task)}${small ? " workspace-status-dot--small" : ""}`}
      title={display.label}
      aria-label={display.label}
    />
  );
}

function WorkerSummary({ workers }: { workers: Task[] }) {
  if (!workers.length) return null;
  const buckets = statusCounts(workers);
  const summary = buckets.map((bucket) => `${bucket.n} ${bucket.label}`).join(" · ");
  return (
    <span className="workspace-worker-summary" title={`${workers.length} 个执行者 · ${summary}`}>
      <span>{workers.length}</span>
      <span className="workspace-worker-dots" aria-label={summary}>
        {buckets.map((bucket) => {
          const sample = workers.find((worker) =>
            bucket.awaitingAnswer
              ? !!worker.question
              : bucket.status === "queued"
                ? !worker.question && (worker.status === "queued" || worker.status === "backlog")
                : !worker.question && worker.status === bucket.status,
          );
          return sample ? <StatusDot key={bucket.label} task={sample} small /> : null;
        })}
      </span>
    </span>
  );
}

function TaskRow({
  task,
  selectedTaskId,
  onTask,
  child = false,
  trailing,
}: {
  task: Task;
  selectedTaskId: string | null;
  onTask: (task: Task) => void;
  child?: boolean;
  trailing?: React.ReactNode;
}) {
  const selected = selectedTaskId === task.id;
  return (
    <button
      className={`workspace-task-row ui-selectable${child ? " workspace-task-row--child" : ""}${selected ? " is-selected" : ""}`}
      type="button"
      aria-selected={selected}
      data-task-id={task.id}
      onClick={() => onTask(task)}
      title={task.title}
    >
      <StatusDot task={task} />
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
}: {
  task: Task;
  allTasks: Task[];
  selectedTaskId: string | null;
  onTask: (task: Task) => void;
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
          trailing={
            <>
              <WorkerSummary workers={workers} />
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
}: {
  tasks: Task[];
  selectedTaskId: string | null;
  onTask: (task: Task) => void;
}) {
  const sections = useMemo(() => buildTaskTree(tasks), [tasks]);
  const { collapsed, toggle } = useCollapsedGroups();
  if (!sections.length) return <p className="workspace-task-empty">还没有任务</p>;
  return (
    <>
      {sections.map((section) => (
        <section className="workspace-task-section" key={section.key}>
          <header className="workspace-task-section-title">
            <span>{section.label}</span>
            <em>{section.count}</em>
          </header>
          {section.groups.map((group) => {
            const isCollapsed = collapsed.has(group.collapseKey);
            return (
              <div className="workspace-task-group" key={group.key}>
                <button
                  className="workspace-task-group-title"
                  type="button"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggle(group.collapseKey)}
                  title={isCollapsed ? "展开这一组" : "折叠这一组"}
                >
                  <span>{group.label}</span>
                  <em>{group.tasks.length}</em>
                  <CaretRight size={9} weight="bold" className={isCollapsed ? "" : "is-open"} aria-hidden="true" />
                </button>
                {!isCollapsed && group.tasks.map((task) =>
                  task.mode === "team" ? (
                    <TeamRow
                      key={task.id}
                      task={task}
                      allTasks={tasks}
                      selectedTaskId={selectedTaskId}
                      onTask={onTask}
                    />
                  ) : (
                    <TaskRow key={task.id} task={task} selectedTaskId={selectedTaskId} onTask={onTask} />
                  ),
                )}
              </div>
            );
          })}
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
}: {
  project: ProjectView;
  tasks: Task[];
  selectedTaskId: string | null;
  onTask: (task: Task) => void;
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
            <TaskRow key={task.id} task={task} selectedTaskId={selectedTaskId} onTask={onTask} />
          ))}
          {!ordered.length && <p>没有任务</p>}
        </div>
      )}
    </div>
  );
}

export function TaskTree({ projects, currentProjectId, tasks, selectedTaskId, onTask }: TaskTreeProps) {
  const activeTasks = useMemo(() => tasks.filter((task) => !task.archived), [tasks]);
  const currentTasks = useMemo(
    () => activeTasks.filter((task) => task.projectId === currentProjectId),
    [activeTasks, currentProjectId],
  );
  const otherProjects = projects.filter((project) => project.id !== currentProjectId);
  return (
    <nav className="workspace-task-tree" aria-label="任务树">
      <CurrentProjectTree tasks={currentTasks} selectedTaskId={selectedTaskId} onTask={onTask} />
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
            />
          ))}
        </section>
      )}
    </nav>
  );
}

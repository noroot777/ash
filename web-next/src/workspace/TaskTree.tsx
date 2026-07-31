import { useEffect, useMemo, useState } from "react";
import type { Group, ProjectView, Task } from "@harness/shared";
import { canArchive } from "@harness/shared";
import { statusCounts, workersOf } from "@harness/shared/team";
import { ArrowBendDownRight, CaretRight, PushPin, Scales, UsersThree } from "@phosphor-icons/react";
import { OriginTaskChip, taskParentLink } from "../components/TaskOrigin.tsx";
import { TaskStatusDot } from "../components/TaskStatusDot.tsx";
import { useTaskReadState, type IndicatorForTask } from "../lib/useTaskReadState.ts";
import { ProjectAvatar } from "./ProjectAvatar.tsx";
import { buildTaskTree, orderedTopLevelTasks } from "./taskTreeModel.ts";

const COLLAPSED_GROUPS_STORAGE_KEY = "harness:taskList:collapsedStatuses";

type TaskTreeProps = {
  projects: ProjectView[];
  currentProjectId: string | null;
  groups: Group[];
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

const PRIORITY_LABELS: Record<Task["priority"], string> = {
  none: "",
  low: "低优先级",
  medium: "中优先级",
  high: "高优先级",
  urgent: "紧急",
};

function pauseBlockers(task: Task, allTasks: Task[]): Task[] {
  if (task.status !== "paused" || !task.queueId) return [];
  const queue = allTasks
    .filter((item) => item.queueId === task.queueId)
    .sort((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0));
  const index = queue.findIndex((item) => item.id === task.id);
  return (index < 0 ? [] : queue.slice(0, index)).filter(
    (item) => item.status !== "done" && item.status !== "canceled",
  );
}

function metadataFor(task: Task, groupName?: string): string[] {
  const metadata: string[] = [];
  if (task.priority !== "none") metadata.push(PRIORITY_LABELS[task.priority]);
  if (groupName) metadata.push(`分组 · ${groupName}`);
  if (task.labels.length) metadata.push(`标签 · ${task.labels.join("、")}`);
  if (task.useWorktree) metadata.push(`独立 worktree${task.worktreeBase ? ` · ${task.worktreeBase}` : ""}`);
  return metadata;
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

function PauseHint({ task, allTasks, onTask }: { task: Task; allTasks: Task[]; onTask: (task: Task) => void }) {
  if (task.status !== "paused") return null;
  const blockers = pauseBlockers(task, allTasks);
  const first = blockers[0];
  return (
    <div className="workspace-pause-hint">
      <ArrowBendDownRight size={10} aria-hidden="true" />
      {first ? (
        <>
          <span>等</span>
          <button type="button" onClick={() => onTask(first)}>「{first.title || "未命名任务"}」{first.status === "paused" ? "（也在等）" : ""}</button>
          {blockers.length > 1 && <em>+{blockers.length - 1}</em>}
        </>
      ) : <span>等待续跑</span>}
    </div>
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
  showPin = false,
  groupName,
  trailing,
}: {
  task: Task;
  allTasks: Task[];
  selectedTaskId: string | null;
  onTask: (task: Task) => void;
  indicatorForTask: IndicatorForTask;
  child?: boolean;
  showOrigin?: boolean;
  showPin?: boolean;
  groupName?: string;
  trailing?: React.ReactNode;
}) {
  const selected = selectedTaskId === task.id;
  const indicator = indicatorForTask(task);
  const hasOrigin = showOrigin && taskParentLink(task, allTasks) !== null;
  const metadata = metadataFor(task, groupName);
  return (
    <div className="workspace-task-row-wrap">
      <button
        className={`workspace-task-row ui-selectable${child ? " workspace-task-row--child" : ""}${hasOrigin ? " workspace-task-row--has-origin" : ""}${selected ? " is-selected" : ""}`}
        type="button"
        aria-selected={selected}
        data-task-id={task.id}
        onClick={() => onTask(task)}
        title={task.title}
      >
        {indicator && <TaskStatusDot indicator={indicator} surface="workspace" />}
        {showPin && task.pinnedAt != null && <PushPin size={11} weight="fill" className="workspace-task-pin" aria-label="已置顶" />}
        {task.mode === "debate" && <Scales size={12} weight="bold" className="workspace-task-kind" aria-label="辩论" />}
        <span className="workspace-task-title">{task.title || "未命名任务"}</span>
        {task.queueId != null && !canArchive(task.status) && (
          <span className="workspace-task-queue" aria-label={`队列第 ${(task.queuePosition ?? 0) + 1} 位`}>↳ #{(task.queuePosition ?? 0) + 1}</span>
        )}
        {trailing}
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
      {metadata.length > 0 && <div className="workspace-task-metadata" role="tooltip">{metadata.map((item) => <span key={item}>{item}</span>)}</div>}
      <PauseHint task={task} allTasks={allTasks} onTask={onTask} />
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
  groupNames,
}: {
  task: Task;
  tasks: Task[];
  allTasks: Task[];
  selectedTaskId: string | null;
  onTask: (task: Task) => void;
  indicatorForTask: IndicatorForTask;
  groupNames: ReadonlyMap<string, string>;
}) {
  const workers = workersOf(tasks, task.id);
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
          allTasks={allTasks}
          selectedTaskId={selectedTaskId}
          onTask={onTask}
          indicatorForTask={indicatorForTask}
          groupName={task.groupId ? groupNames.get(task.groupId) : undefined}
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
              allTasks={allTasks}
              child
              showOrigin={false}
              selectedTaskId={selectedTaskId}
              onTask={onTask}
              indicatorForTask={indicatorForTask}
              groupName={worker.groupId ? groupNames.get(worker.groupId) : undefined}
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
  allTasks,
  selectedTaskId,
  onTask,
  indicatorForTask,
  groupNames,
}: {
  tasks: Task[];
  allTasks: Task[];
  selectedTaskId: string | null;
  onTask: (task: Task) => void;
  indicatorForTask: IndicatorForTask;
  groupNames: ReadonlyMap<string, string>;
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
                      tasks={tasks}
                      allTasks={allTasks}
                      selectedTaskId={selectedTaskId}
                      onTask={onTask}
                      indicatorForTask={indicatorForTask}
                      groupNames={groupNames}
                    />
                  ) : (
                    <TaskRow key={task.id} task={task} allTasks={allTasks} selectedTaskId={selectedTaskId} onTask={onTask} indicatorForTask={indicatorForTask} groupName={task.groupId ? groupNames.get(task.groupId) : undefined} />
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
  allTasks,
  selectedTaskId,
  onTask,
  indicatorForTask,
  groupNames,
}: {
  project: ProjectView;
  tasks: Task[];
  allTasks: Task[];
  selectedTaskId: string | null;
  onTask: (task: Task) => void;
  indicatorForTask: IndicatorForTask;
  groupNames: ReadonlyMap<string, string>;
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
            <TaskRow key={task.id} task={task} allTasks={allTasks} showPin selectedTaskId={selectedTaskId} onTask={onTask} indicatorForTask={indicatorForTask} groupName={task.groupId ? groupNames.get(task.groupId) : undefined} />
          ))}
          {!ordered.length && <p>没有任务</p>}
        </div>
      )}
    </div>
  );
}

export function TaskTree({ projects, currentProjectId, groups, tasks, selectedTaskId, onTask }: TaskTreeProps) {
  const { indicatorForTask } = useTaskReadState(tasks, selectedTaskId);
  const groupNames = useMemo(() => new Map(groups.map((group) => [group.id, group.name])), [groups]);
  const activeTasks = useMemo(() => tasks.filter((task) => !task.archived), [tasks]);
  const currentTasks = useMemo(
    () => activeTasks.filter((task) => task.projectId === currentProjectId),
    [activeTasks, currentProjectId],
  );
  const otherProjects = projects.filter((project) => project.id !== currentProjectId);
  return (
    <nav className="workspace-task-tree" aria-label="任务树">
      <CurrentProjectTree tasks={currentTasks} allTasks={tasks} selectedTaskId={selectedTaskId} onTask={onTask} indicatorForTask={indicatorForTask} groupNames={groupNames} />
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
              groupNames={groupNames}
            />
          ))}
        </section>
      )}
    </nav>
  );
}

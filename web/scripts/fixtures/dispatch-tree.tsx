import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProjectView, Task } from "@ash/shared";
import { TaskTree } from "../../src/workspace/TaskTree.tsx";
import type { SidebarSpread, SpreadFilter } from "../../src/workspace/useSidebarSpread.ts";
import type { TaskScope } from "../../src/workspace/taskScope.ts";
import "../../src/styles/global.css";
import "../../src/styles/workspace.css";
import "../../src/styles/task-tree.css";

const now = Date.now();
const at = (minutes: number) => new Date(now - minutes * 60 * 1000).toISOString();

const project: ProjectView = {
  id: "p1", name: "ash", repoPath: "/tmp/ash", workflowId: null, useWorktreeDefault: false, createdAt: at(600),
  health: { exists: true, isRepo: true },
};

function task(id: string, title: string, minutes: number, extra: Partial<Task> = {}): Task {
  return {
    id, projectId: project.id, groupId: null, parentId: null, title, body: "", mode: "single",
    status: "done", stage: "accepted", labels: [], dependsOn: [], resumeDependsOn: [],
    createdAt: at(minutes), updatedAt: at(minutes), ...extra,
  };
}

const initial: Task[] = [
  task("lead", "拆活的分析任务", 50),
  task("kid-run", "派出去在跑的", 40, { dispatchedBy: "lead", status: "running", stage: null }),
  task("kid-ask", "派出去在等答复的", 30, { dispatchedBy: "lead", status: "paused", stage: null, question: "选哪种做法？" }),
  task("kid-mid", "派出去又派了活的", 20, { dispatchedBy: "lead" }),
  task("grand", "孙辈任务", 10, { dispatchedBy: "kid-mid" }),
  task("gone-lead", "已经归档的派活人", 70, { archived: true }),
  task("orphan", "派它的那条已归档", 60, { dispatchedBy: "gone-lead" }),
  // 一条两天前的派活任务：直接派出的那条已经归档，底下那条还失败着。
  task("old-lead", "两天前的派活任务", 48 * 60),
  task("old-mid", "两天前派出、已归档", 47 * 60, { dispatchedBy: "old-lead", archived: true }),
  task("old-grand", "归档那条底下失败的", 46 * 60, { dispatchedBy: "old-mid", status: "failed", stage: null }),
  task("team", "一个团队", 80, { mode: "team", status: "idle", stage: null }),
  task("worker", "团队的执行者", 75, { parentId: "team", status: "done", stage: null }),
];

const idleSpread: SidebarSpread = {
  open: false, laidOut: false, filter: "all", setFilter: () => {}, followUps: new Map(), loaded: new Set(),
  toggle: () => {}, close: () => {},
} as unknown as SidebarSpread;

declare global {
  interface Window {
    __select: (id: string | null) => void;
    __add: (task: Partial<Task> & { id: string; title: string }) => void;
    __patch: (id: string, patch: Partial<Task>) => void;
    __filter: (filter: SpreadFilter) => void;
    __scope: (kind: "project" | "tasks") => void;
  }
}

function Ash() {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [tasks, setTasks] = useState(initial);
  const [filter, setFilter] = useState<SpreadFilter>("all");
  const [scope, setScope] = useState<TaskScope>({ kind: "project", projectId: project.id });
  const spread = useMemo(() => ({ ...idleSpread, filter, setFilter }), [filter]);
  useEffect(() => {
    window.__filter = setFilter;
    window.__scope = (kind) => setScope(kind === "tasks" ? { kind } : { kind, projectId: project.id });
    window.__select = setSelectedTaskId;
    window.__add = (next) => setTasks((current) => [...current, task(next.id, next.title, 1, next)]);
    window.__patch = (id, patch) => setTasks((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }, []);
  return (
    <main style={{ width: 320, minHeight: 480, background: "var(--canvas, #f4f4f5)" }}>
      <output data-selected={selectedTaskId ?? ""} />
      <TaskTree
        projects={[project]}
        currentProjectId={project.id}
        scope={scope}
        tasks={tasks}
        selectedTaskId={selectedTaskId}
        selectedRemoteTaskId={null}
        spread={spread}
        onTask={(next) => setSelectedTaskId(next.id)}
        onRemoteTask={() => {}}
        onHandoffFinished={() => {}}
        onQueueChanged={() => {}}
        outbound={{ outboundCount: 0, offlinePeers: [], asked: true, refreshing: false, onRefresh: () => {} }}
        notify={() => {}}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Ash /></StrictMode>);

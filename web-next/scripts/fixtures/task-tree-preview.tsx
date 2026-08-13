import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProjectView, Task } from "@harness/shared";
import { TaskTree } from "../../src/workspace/TaskTree.tsx";
import type { SidebarSpread } from "../../src/workspace/useSidebarSpread.ts";
import "../../src/styles/global.css";
import "../../src/styles/workspace.css";
import "../../src/styles/task-tree.css";

const now = Date.now();
const recent = new Date(now - 60 * 60 * 1000).toISOString();
const old = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();

const project: ProjectView = {
  id: "p1",
  name: "harness",
  repoPath: "/tmp/harness",
  workflowId: null,
  createdAt: recent,
  health: { exists: true, isRepo: true },
};

function task(id: string, title: string, updatedAt: string): Task {
  return {
    id,
    projectId: project.id,
    groupId: null,
    parentId: null,
    title,
    body: "",
    mode: "single",
    status: "done",
    labels: [],
    dependsOn: [],
    resumeDependsOn: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

const tasks: Task[] = [
  task("recent", "今天刚改过", recent),
  task("old-1", "很久以前的任务甲", old),
  task("old-2", "很久以前的任务乙", old),
  task("old-3", "很久以前的任务丙", old),
];

const idleSpread: SidebarSpread = {
  open: false,
  laidOut: false,
  filter: "all",
  setFilter: () => {},
  followUps: new Map(),
  loaded: new Set(),
  toggle: () => {},
  close: () => {},
};

function Harness() {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const spread = useMemo(() => idleSpread, []);
  return (
    <main style={{ width: 320, minHeight: 480, background: "var(--canvas, #f4f4f5)" }}>
      <TaskTree
        projects={[project]}
        currentProjectId={project.id}
        tasks={tasks}
        selectedTaskId={selectedTaskId}
        spread={spread}
        onTask={(next) => setSelectedTaskId(next.id)}
        onTaskStarred={() => {}}
        notify={() => {}}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);

import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProjectView, Task } from "@ash/shared";
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
  name: "ash",
  repoPath: "/tmp/ash",
  workflowId: null,
  createdAt: recent,
  health: { exists: true, isRepo: true },
};

function task(id: string, title: string, updatedAt: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    projectId: project.id,
    groupId: null,
    parentId: null,
    title,
    body: "",
    mode: "single",
    status: "done",
    // 默认盖过章：不然「干完了没验收」会豁免年龄折叠，这个 fixture 就没有可折叠的行了。
    stage: "accepted",
    labels: [],
    dependsOn: [],
    resumeDependsOn: [],
    createdAt: updatedAt,
    updatedAt,
    ...extra,
  };
}

const tasks: Task[] = [
  task("recent", "今天刚改过", recent),
  task("old-1", "很久以前的任务甲", old),
  task("old-2", "很久以前的任务乙", old),
  task("old-3", "很久以前的任务丙", old),
  // 这两条是「永不折叠」的两种理由：用户加的星标，和还没盖的章。
  task("old-starred", "很久以前但加了星", old, { starredAt: now - 5 * 60 * 1000 }),
  task("old-unaccepted", "很久以前但没验收", old, { stage: null }),
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

function Ash() {
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
    <Ash />
  </StrictMode>,
);

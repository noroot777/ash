import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProjectView, Task } from "@ash/shared";
import { TaskTree } from "../../src/workspace/TaskTree.tsx";
import type { SidebarSpread } from "../../src/workspace/useSidebarSpread.ts";
import "../../src/styles/global.css";
import "../../src/styles/workspace.css";
import "../../src/styles/task-tree.css";

// 攒了一大堆旧任务的侧栏：45 条落在 24 小时年龄闸外面，用来钉住「一次展开一页」。
// 另外两处也一起摆上：团队行底下 30 个执行者、隔壁项目 40 条任务 —— 侧栏的三处
// 「显示另外 N 条」共用同一套分页，测试也就一次把三处都过一遍。
const now = Date.now();
const recent = new Date(now - 60 * 60 * 1000).toISOString();

const project: ProjectView = {
  id: "p1",
  name: "ash",
  repoPath: "/tmp/ash",
  workflowId: null,
  createdAt: recent,
  health: { exists: true, isRepo: true },
};

const other: ProjectView = {
  id: "p2",
  name: "隔壁项目",
  repoPath: "/tmp/other",
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
    // 盖过章，否则「干完没验收」会豁免年龄折叠，就没有可分页的隐藏区了。
    stage: "accepted",
    labels: [],
    dependsOn: [],
    resumeDependsOn: [],
    createdAt: updatedAt,
    updatedAt,
    ...extra,
  };
}

const OLD_COUNT = 45;
const WORKER_COUNT = 30;
const OTHER_COUNT = 40;
const tasks: Task[] = [
  task("recent", "今天刚改过", recent),
  ...Array.from({ length: OLD_COUNT }, (_, index) =>
    // 每条差一小时，顺序稳定：旧任务 1 最新，旧任务 45 最老。
    task(`old-${index + 1}`, `旧任务 ${index + 1}`, new Date(now - (48 + index) * 60 * 60 * 1000).toISOString()),
  ),
  task("team", "人多的团队", recent, { mode: "team" }),
  ...Array.from({ length: WORKER_COUNT }, (_, index) =>
    task(`worker-${index + 1}`, `执行者 ${index + 1}`, recent, {
      parentId: "team",
      // 执行者按 createdAt 排（见 shared 的 workersOf），编号要跟着顺序走。
      createdAt: new Date(now - (WORKER_COUNT - index) * 60 * 1000).toISOString(),
    }),
  ),
  ...Array.from({ length: OTHER_COUNT }, (_, index) =>
    task(`other-${index + 1}`, `隔壁任务 ${index + 1}`, new Date(now - index * 60 * 1000).toISOString(), {
      projectId: other.id,
    }),
  ),
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
        projects={[project, other]}
        currentProjectId={project.id}
        scope={{ kind: "project", projectId: project.id }}
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

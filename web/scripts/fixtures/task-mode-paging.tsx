import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProjectView, Task, TaskListItem } from "@ash/shared";
import { TaskTree } from "../../src/workspace/TaskTree.tsx";
import { useSidebarTaskNavigation } from "../../src/workspace/sidebarNavigation.ts";
import { spreadVisibleTasks, type SidebarSpread } from "../../src/workspace/useSidebarSpread.ts";
import { useWorkspaceShortcuts } from "../../src/workspace/useWorkspaceShortcuts.ts";
import "../../src/styles/global.css";
import "../../src/styles/workspace.css";
import "../../src/styles/task-tree.css";

const now = Date.now();
const params = new URLSearchParams(window.location.search);
const regressions = params.has("regressions");
const historyCount = regressions ? 420 : 45;
const recent = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const projects: ProjectView[] = ["甲项目", "乙项目", "仅置顶项目", "空闲项目"].map((name, index) => ({
  id: `p${index + 1}`,
  name,
  repoPath: `/tmp/task-mode-${index}`,
  workflowId: null,
  useWorktreeDefault: false,
  createdAt: recent(600),
  health: { exists: true, isRepo: true },
}));

function task(id: string, projectId: string, minutes: number, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    projectId,
    groupId: null,
    parentId: null,
    body: "",
    mode: "single",
    status: "done",
    stage: "accepted",
    labels: [],
    dependsOn: [],
    resumeDependsOn: [],
    createdAt: recent(minutes),
    updatedAt: recent(minutes),
    ...extra,
  };
}

const tasks = [
  task("a-live", "p1", 10, { status: "running", stage: null }),
  task("a-question", "p1", 3_000, { status: "paused", stage: null, question: "需要答复" }),
  task("b-live", "p2", 20, { status: "running", stage: null }),
  task("c-pin", "p3", 30, { status: "running", stage: null, pinnedAt: now }),
  ...Array.from({ length: regressions ? 4 : 0 }, (_, index) => task(`a-aged-${index + 1}`, "p1", 3_000 + index, { status: "running" })),
  ...Array.from({ length: historyCount }, (_, index) => task(`a-extra-${index + 1}`, "p1", index + 1, {
    ...(index === 0 ? { mode: "team", pinnedAt: now - 1 } : {}),
    ...(index === 1 ? { handoff: { direction: "out", pending: false, peer: "test", at: recent(1), git: "bundle" } } : {}),
  })),
  task("a-worker-1", "p1", 60, { parentId: "a-extra-1" }),
  task("a-worker-2", "p1", 50, { parentId: "a-extra-1" }),
  ...Array.from({ length: 22 }, (_, index) => task(`b-extra-${index + 1}`, "p2", index + 1)),
  task("c-extra-1", "p3", 1),
  task("c-extra-2", "p3", 2),
  task("archived", "p1", 1, { archived: true }),
  task("idle-only", "p4", 1),
];
const spread: SidebarSpread = {
  open: false,
  laidOut: false,
  filter: "all",
  setFilter: () => {},
  followUps: new Map(),
  bodies: new Map(),
  loaded: new Set(),
  toggle: () => {},
  close: () => {},
};

function TaskModePaging() {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(params.get("task"));
  const [taskMode, setTaskMode] = useState(params.get("scope") !== "project");
  const [paletteCount, setPaletteCount] = useState(0);
  const [onlyPinnedProject, setOnlyPinnedProject] = useState(false);
  const rows = onlyPinnedProject ? tasks.filter((item) => item.projectId === "p3") : tasks;
  const scope = taskMode ? { kind: "tasks" } as const : { kind: "project", projectId: "p1" } as const;
  const fallbackOrder = spreadVisibleTasks(rows, scope, "all");
  const onTask = (next: TaskListItem) => setSelectedTaskId(next.id);
  const navigate = useSidebarTaskNavigation({ tasks, fallbackOrder, selectedTaskId, selectedRemoteTaskId: null, onTask });
  useWorkspaceShortcuts({
    enabled: true,
    paletteOpen: false,
    composerOpen: false,
    spreadOpen: false,
    onNavigate: navigate,
    onTogglePalette: () => setPaletteCount((value) => value + 1),
    onCreate: () => {},
    onToggleSpread: () => {},
    onCloseSpread: () => {},
    onToggleTaskMode: () => {},
    onOpenSettings: () => {},
    onToggleCommands: () => {},
    onToggleTerminal: () => {},
  });
  return (
    <main style={{ padding: 24 }}>
      <p data-testid="selected">{selectedTaskId ?? ""}</p>
      <p data-testid="palette-count">{paletteCount}</p>
      <button type="button" data-testid="clear-selection" onClick={() => setSelectedTaskId(null)}>清空选中</button>
      <button type="button" data-testid="select-hidden" onClick={() => setSelectedTaskId(`a-extra-${historyCount}`)}>选中隐藏任务</button>
      <button type="button" data-testid="select-worker" onClick={() => setSelectedTaskId("a-worker-2")}>选中隐藏执行者</button>
      <button type="button" data-testid="select-aged" onClick={() => setSelectedTaskId("a-aged-4")}>选中年龄闸任务</button>
      <button type="button" data-testid="toggle-mode" onClick={() => setTaskMode((value) => !value)}>切换任务模式</button>
      <button type="button" data-testid="only-pinned-project" onClick={() => setOnlyPinnedProject(true)}>只看置顶项目</button>
      <aside className="workspace-sidebar" style={{ width: 320, height: 680, marginTop: 16 }}>
        <TaskTree
          projects={projects}
          currentProjectId="p1"
          scope={scope}
          tasks={rows}
          selectedTaskId={selectedTaskId}
          selectedRemoteTaskId={null}
          spread={spread}
          onTask={onTask}
          onRemoteTask={onTask}
          onTaskStarred={() => {}}
          onHandoffFinished={() => {}}
          onQueueChanged={() => {}}
          outbound={{ outboundCount: 0, offlinePeers: [], asked: false, refreshing: false, onRefresh: () => {} }}
          notify={() => {}}
        />
      </aside>
    </main>
  );
}

window.localStorage.clear();
createRoot(document.getElementById("root")!).render(<StrictMode><TaskModePaging /></StrictMode>);

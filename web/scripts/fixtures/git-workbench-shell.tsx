import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_APP_SETTINGS, type ProjectView } from "@ash/shared";
import "@fontsource-variable/inter";
import "../../src/styles/global.css";
import { api } from "../../src/lib/api.ts";
import { DraftProvider } from "../../src/lib/DraftStore.tsx";
import { ExecutorGateProvider } from "../../src/task-detail/ExecutorGate.tsx";
import { WorkspaceShell } from "../../src/workspace/WorkspaceShell.tsx";
import { workbenchApi } from "../../src/git-workbench/api.ts";

const projectId = new URLSearchParams(location.search).get("project") || "workbench-browser";
const data = await workbenchApi.state(projectId);
const project: ProjectView = {
  id: projectId,
  name: "Git 工作台验证",
  repoPath: data.repo,
  workflowId: null,
  useWorktreeDefault: true,
  previewCommand: null,
  acceptCommit: true,
  createdAt: "2026-09-15T00:00:00.000Z",
  health: { exists: true, isRepo: true, branch: data.status.branch.head, dirty: true },
  myRole: "admin",
};

// 工作区启动数据隔离在 fixture 内；Git 读取与写入继续访问临时仓库的真实后端。
api.projects = async () => [project];
api.tasks = async () => [];
api.groups = async () => [];
api.projectHealth = async () => project.health;
api.handoffTargets = async () => [];
api.handoffPeers = async () => [];
api.settings = async () => ({ ...DEFAULT_APP_SETTINGS });
api.agents = async () => [];
api.workflows = async () => [];
api.teamPresets = async () => [];
api.projectBranches = async () => ({
  branches: data.refs.filter(ref => ref.kind === "branch").map(ref => ref.name),
  current: data.status.branch.head,
});

class FixtureEvents extends EventTarget {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readyState = 1;
  constructor() {
    super();
    queueMicrotask(() => this.onopen?.());
  }
  close() { this.readyState = 2; }
}
window.EventSource = FixtureEvents as unknown as typeof EventSource;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DraftProvider>
      <ExecutorGateProvider>
        <WorkspaceShell />
      </ExecutorGateProvider>
    </DraftProvider>
  </StrictMode>,
);

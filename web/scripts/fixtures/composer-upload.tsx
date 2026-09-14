import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Group, GroupMode, ProjectView, Task, TaskMode } from "@ash/shared";
import { TaskComposerPanel } from "../../src/composer/TaskComposerPanel.tsx";
import { DraftProvider } from "../../src/lib/DraftStore.tsx";
import "../../src/styles/global.css";

const initialProject: ProjectView = {
  id: "p1",
  name: "ash",
  repoPath: "/tmp/ash",
  workflowId: null,
  useWorktreeDefault: false,
  createdAt: "2026-08-28T00:00:00.000Z",
  health: { exists: true, isRepo: new URLSearchParams(location.search).has("repo") },
};

function Ash() {
  const [mode, setMode] = useState<TaskMode>("single");
  const [created, setCreated] = useState<string[]>([]);
  const [notices, setNotices] = useState<string[]>([]);
  const notify = useCallback((message: string) => setNotices((current) => [...current, message]), []);
  // 真实工作区里创建完这块面板就收起来了，再开是新的一份。这里用 key 复现那一下，
  // 否则提交后 busy 一直挂着，测不了「同一次会话里接着建第二条」。
  const [round, setRound] = useState(0);
  // 项目行按 WorkspaceShell 的接法放在**面板外面**：面板里「设为本项目默认」写回之后
  // 必须换掉这一份，否则重开面板又按旧默认预填（第 1 轮审查 P1）。
  const [project, setProject] = useState(initialProject);
  return (
    <div style={{ display: "flex", height: "100vh", flexDirection: "column" }}>
      <TaskComposerPanel
        key={round}
        project={project}
        groups={[] as Group[]}
        mode={mode}
        onModeChange={setMode}
        onCancel={() => {}}
        onCreated={(task: Task) => {
          setCreated((current) => [...current, task.title]);
          setRound((current) => current + 1);
        }}
        onCreateGroup={async (name: string, groupMode: GroupMode) => ({
          id: "g1",
          projectId: project.id,
          name,
          mode: groupMode,
          createdAt: "2026-08-28T00:00:00.000Z",
        })}
        onProjectUpdated={setProject}
        notify={notify}
      />
      <button type="button" data-testid="reopen" onClick={() => setRound((current) => current + 1)}>重开面板</button>
      <span data-testid="project-worktree-default">{project.useWorktreeDefault ? "开" : "关"}</span>
      <ul data-testid="created">{created.map((title, index) => <li key={index}>{`已创建：${title}`}</li>)}</ul>
      <ul data-testid="notices">{notices.map((item, index) => <li key={index}>{`提示：${item}`}</li>)}</ul>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DraftProvider>
      <Ash />
    </DraftProvider>
  </StrictMode>,
);

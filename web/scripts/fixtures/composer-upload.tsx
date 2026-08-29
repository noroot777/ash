import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Group, GroupMode, ProjectView, Task, TaskMode } from "@ash/shared";
import { TaskComposerPanel } from "../../src/composer/TaskComposerPanel.tsx";
import "../../src/styles/global.css";

const project: ProjectView = {
  id: "p1",
  name: "ash",
  repoPath: "/tmp/ash",
  workflowId: null,
  createdAt: "2026-08-28T00:00:00.000Z",
  health: { exists: true, isRepo: false },
};

function Ash() {
  const [mode, setMode] = useState<TaskMode>("single");
  const [created, setCreated] = useState<string[]>([]);
  const [notices, setNotices] = useState<string[]>([]);
  return (
    <div style={{ display: "flex", height: "100vh", flexDirection: "column" }}>
      <TaskComposerPanel
        project={project}
        groups={[] as Group[]}
        mode={mode}
        onModeChange={setMode}
        onCancel={() => {}}
        onCreated={(task: Task) => setCreated((current) => [...current, task.title])}
        onCreateGroup={async (name: string, groupMode: GroupMode) => ({
          id: "g1",
          projectId: project.id,
          name,
          mode: groupMode,
          createdAt: "2026-08-28T00:00:00.000Z",
        })}
        notify={(message: string) => setNotices((current) => [...current, message])}
      />
      <ul data-testid="created">{created.map((title, index) => <li key={index}>{`已创建：${title}`}</li>)}</ul>
      <ul data-testid="notices">{notices.map((item, index) => <li key={index}>{`提示：${item}`}</li>)}</ul>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Ash />
  </StrictMode>,
);

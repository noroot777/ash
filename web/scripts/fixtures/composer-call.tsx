// 新建框里 `@` 一个人（test-composer-call-dom.mjs）：真的 TaskComposerPanel，接口由测试那边拦。
import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Group, GroupMode, ProjectView, Task } from "@ash/shared";
import { TaskComposerPanel } from "../../src/composer/TaskComposerPanel.tsx";
import { DraftProvider } from "../../src/lib/DraftStore.tsx";
import "../../src/styles/global.css";

const project: ProjectView = {
  id: "p1",
  name: "ash",
  repoPath: "/tmp/ash",
  workflowId: null,
  useWorktreeDefault: false,
  createdAt: "2026-11-15T00:00:00.000Z",
  health: { exists: true, isRepo: true },
};

function Fixture() {
  const [created, setCreated] = useState<string[]>([]);
  const [notices, setNotices] = useState<string[]>([]);
  const notify = useCallback((message: string) => setNotices((current) => [...current, message]), []);
  // 真实工作区里建完这块面板就收起来了，再开是新的一份：用 key 复现那一下。
  const [round, setRound] = useState(0);
  return (
    <div style={{ display: "flex", height: "100vh", flexDirection: "column" }}>
      <TaskComposerPanel
        key={round}
        project={project}
        groups={[] as Group[]}
        tasks={[]}
        onCancel={() => {}}
        onCreated={(task: Task) => {
          setCreated((current) => [...current, task.title]);
          setRound((current) => current + 1);
        }}
        onCreateGroup={async (name: string, mode: GroupMode) => ({ id: "g1", projectId: project.id, name, mode, createdAt: project.createdAt })}
        onProjectUpdated={() => {}}
        notify={notify}
      />
      <button type="button" data-testid="reopen" onClick={() => setRound((current) => current + 1)}>重开面板</button>
      <ul data-testid="created">{created.map((title, index) => <li key={index}>{`已创建：${title}`}</li>)}</ul>
      <ul data-testid="notices">{notices.map((item, index) => <li key={index}>{`提示：${item}`}</li>)}</ul>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DraftProvider>
      <Fixture />
    </DraftProvider>
  </StrictMode>,
);

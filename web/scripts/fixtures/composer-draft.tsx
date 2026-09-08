import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Group, GroupMode, ProjectView, Task, TaskMode } from "@ash/shared";
import { TaskComposerPanel } from "../../src/composer/TaskComposerPanel.tsx";
import type { ComposerDraft } from "../../src/composer/composerDraft.ts";
import { DraftProvider } from "../../src/lib/DraftStore.tsx";
import "../../src/styles/global.css";

// 真实工作区里「去别的页面」就是把这块面板整个卸载（点侧栏任务、开聊天、进设置都一样）。
// 这里用一个开关复现那一下 —— 草稿必须活在面板外面，回来时原样还在。
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
  const [open, setOpen] = useState(true);
  const [seed, setSeed] = useState<ComposerDraft | null>(null);
  const [created, setCreated] = useState<string[]>([]);
  const notify = useCallback(() => {}, []);
  return (
    <div style={{ display: "flex", height: "100vh", flexDirection: "column" }}>
      <button type="button" onClick={() => setOpen((current) => !current)}>
        {open ? "去别的页面" : "回到新建任务"}
      </button>
      {/* 随手记转任务：带一份内容进来。它只该并进草稿一次，面板重挂不能再拼一遍。 */}
      <button
        type="button"
        onClick={() => {
          setSeed({ body: "随手记带进来的内容", attachments: ["/tmp/uploads/note.png"], noteIds: ["note-1"] });
          setOpen(true);
        }}
      >
        随手记转任务
      </button>
      {open && (
        <TaskComposerPanel
          project={project}
          groups={[] as Group[]}
          initialDraft={seed}
          onDraftSeeded={() => setSeed(null)}
          mode={mode}
          onModeChange={setMode}
          onCancel={() => setOpen(false)}
          onCreated={(task: Task) => {
            setCreated((current) => [...current, task.title]);
            setSeed(null);
            setOpen(false);
          }}
          onCreateGroup={async (name: string, groupMode: GroupMode) => ({
            id: "g1",
            projectId: project.id,
            name,
            mode: groupMode,
            createdAt: "2026-08-28T00:00:00.000Z",
          })}
          notify={notify}
        />
      )}
      <ul data-testid="created">{created.map((title, index) => <li key={index}>{`已创建：${title}`}</li>)}</ul>
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

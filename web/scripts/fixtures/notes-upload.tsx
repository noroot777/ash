import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProjectView } from "@ash/shared";
import { NotesPanel, type NoteTaskDraft } from "../../src/overlays/NotesPanel.tsx";
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
  const [open, setOpen] = useState(true);
  const [log, setLog] = useState<string[]>([]);
  const add = (line: string) => setLog((current) => [...current, line]);
  return (
    <div>
      {open && (
        <NotesPanel
          project={project}
          initialNoteId={null}
          onClose={() => { setOpen(false); add("面板已关闭"); }}
          onTask={(taskId: string) => add(`打开任务 ${taskId}`)}
          onConvert={(draft: NoteTaskDraft) => add(`转任务：${draft.attachments.join(",")}`)}
          notify={(message: string) => add(`提示：${message}`)}
        />
      )}
      <ul data-testid="log">{log.map((line, index) => <li key={index}>{line}</li>)}</ul>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Ash />
  </StrictMode>,
);

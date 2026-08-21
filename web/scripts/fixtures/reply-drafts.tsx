import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import { ReplyBox } from "../../src/task-detail/ReplyBox.tsx";
import { TaskReplyDraftProvider } from "../../src/task-detail/TaskReplyDrafts.tsx";
import "../../src/styles/global.css";

const task = (id: string, title: string): Task => ({
  id,
  projectId: "project-1",
  groupId: null,
  parentId: null,
  title,
  body: title,
  mode: "single",
  status: "idle",
  labels: [],
  dependsOn: [],
  resumeDependsOn: [],
  agentType: "codex",
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
});

const TASKS = [task("task-a", "任务 A"), task("task-b", "任务 B")];

function Ash() {
  const [active, setActive] = useState(0);
  return (
    <main style={{ width: 720, margin: "40px auto" }}>
      <nav>
        {TASKS.map((item, index) => (
          <button type="button" key={item.id} onClick={() => setActive(index)}>{item.title}</button>
        ))}
      </nav>
      <ReplyBox
        task={TASKS[active]!}
        hasConversation
        onSend={async () => ({ started: true })}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <TaskReplyDraftProvider>
    <Ash />
  </TaskReplyDraftProvider>,
);

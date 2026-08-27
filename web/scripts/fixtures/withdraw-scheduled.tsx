import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import { ReplyBox } from "../../src/task-detail/ReplyBox.tsx";
import { TaskReplyDraftProvider } from "../../src/task-detail/TaskReplyDrafts.tsx";
import "../../src/styles/global.css";

// 撤回一条排队消息的现场：任务在跑（所以有托盘），托盘里那条消息带正文和两个附件。
const task: Task = {
  id: "task-a",
  projectId: "project-1",
  groupId: null,
  parentId: null,
  title: "撤回回归",
  body: "撤回回归",
  mode: "single",
  status: "running",
  labels: [],
  dependsOn: [],
  resumeDependsOn: [],
  agentType: "codex",
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
};

createRoot(document.getElementById("root")!).render(
  <TaskReplyDraftProvider>
    <main style={{ width: 720, margin: "40px auto" }}>
      <ReplyBox task={task} hasConversation onSend={async () => ({ started: true })} />
    </main>
  </TaskReplyDraftProvider>,
);

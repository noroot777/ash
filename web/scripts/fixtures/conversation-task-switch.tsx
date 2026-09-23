import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { TaskListItem } from "@ash/shared";
import type { QuestionRecord } from "@ash/shared/questions";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import { useConversation } from "../../src/lib/useConversation.ts";
import "../../src/styles/global.css";

const recordOf = (id: string): QuestionRecord => ({
  id,
  question: `${id}的问题`,
  answer: `${id}的答案`,
  reply: `【答复】\n${id}的答案`,
  answeredAt: "2026-09-10T02:00:00Z",
});

const taskOf = (id: string, history: QuestionRecord[]) => ({
  id, mode: "single", title: `${id} 的任务`, status: "done",
  createdAt: "2026-09-10T01:00:00Z", updatedAt: "2026-09-10T02:00:00Z",
  questionHistory: history,
} as unknown as TaskListItem);

const tasks: Record<string, TaskListItem> = {
  "task-a": taskOf("task-a", [recordOf("a1")]),
  "task-b": taskOf("task-b", [recordOf("b1"), recordOf("b2")]),
};

function Fixture() {
  const [taskId, setTaskId] = useState("task-a");
  const conversation = useConversation(taskId);
  const task = tasks[taskId]!;
  return <main style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
    <nav>
      <button onClick={() => setTaskId(taskId === "task-a" ? "task-b" : "task-a")}>切换任务</button>
      <button onClick={() => void conversation.refetch()}>重读会话</button>
      <output>{taskId}</output>
      <output data-testid="sessions">{conversation.sessions.map((session) => session.id).join(",")}</output>
      <output data-testid="ready">{`${conversation.ready}/${conversation.transcriptReady}`}</output>
    </nav>
    <ConversationFeed
      task={task}
      items={conversation.items}
      sessions={conversation.sessions}
      loading={conversation.refreshing}
      error={conversation.error}
      forkBlockedReason={conversation.forkBlockedReason}
      questionHistory={task.questionHistory}
      liveQuestionHistory={false}
      historyReady={conversation.transcriptReady}
    />
  </main>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);

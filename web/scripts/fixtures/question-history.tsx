import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import type { QuestionRecord } from "@ash/shared/questions";
import { useServerEvents } from "../../src/lib/events.ts";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import { QuestionHistoryProvider, QuestionHistoryRemainder } from "../../src/task-detail/QuestionHistory.tsx";
import { TeamFeed } from "../../src/team/TeamFeed.tsx";
import "../../src/styles/global.css";

const query = new URLSearchParams(location.search);
const record: QuestionRecord = { id: "seed", question: "原始问题", answer: "已有答案", reply: "【答复】\n已有答案", answeredAt: "2026-09-10T01:00:00Z" };
function ConnectionKeeper() { useServerEvents(() => undefined); return null; }
function Fixture() {
  const [taskId, setTaskId] = useState("history-a");
  const [mounted, setMounted] = useState(!query.has("warm"));
  const [history, setHistory] = useState<QuestionRecord[] | undefined>(() => query.get("history") === "seed" ? [record] : query.get("history") === "empty" ? [] : undefined);
  const task = { id: taskId, mode: "single", title: "历史回归", body: "", status: "done", labels: [], dependsOn: [], resumeDependsOn: [],
    createdAt: record.answeredAt, updatedAt: record.answeredAt, questionHistory: history } as Task;
  const mode = query.get("mode");
  return <main style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
    {query.has("warm") && <ConnectionKeeper />}
    <nav>
      <button onClick={() => setMounted((value) => !value)}>挂载切换</button>
      <button onClick={() => { setTaskId("history-b"); setHistory(undefined); }}>切换任务</button>
      <button onClick={() => setHistory([record])}>提供快照</button>
      <output>{taskId}</output>
    </nav>
    {mounted && (mode === "snapshot"
      ? <QuestionHistoryProvider taskId={taskId} history={history} live={false} messages={[]}><QuestionHistoryRemainder messages={[]} /></QuestionHistoryProvider>
      : mode === "team"
        ? <TeamFeed task={task} rows={[]} workers={[]} onOpenWorker={() => undefined} onAskLead={() => undefined} delegatingIds={new Set()} indicatorForTask={() => null} />
        : <ConversationFeed task={task} questionHistory={history} liveQuestionHistory items={[]} sessions={[]} loading={false} error={null} />)}
  </main>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);

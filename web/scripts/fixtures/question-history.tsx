import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import type { QuestionRecord } from "@ash/shared/questions";
import type { ConversationItem } from "../../src/task-detail/conversationModel.ts";
import { useServerEvents } from "../../src/lib/events.ts";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import { QuestionHistoryProvider, QuestionHistoryRemainder } from "../../src/task-detail/QuestionHistory.tsx";
import { useQuestionHistory } from "../../src/task-detail/useQuestionHistory.ts";
import { TeamFeed } from "../../src/team/TeamFeed.tsx";
import "../../src/styles/global.css";

const query = new URLSearchParams(location.search);
const record: QuestionRecord = { id: "seed", question: "原始问题", answer: "已有答案", reply: "【答复】\n已有答案", answeredAt: "2026-09-10T01:00:00Z" };
// `settle=<任务 id>`：会话里带着那个任务提问那一轮的结算说明（题目全文在里面）。答过的气泡出现以后它不再画——
// 不管那条记录是快照里带来的、补读读到的还是推来的；记录被删了它又照画。
const settled = query.get("settle");
const settleItems: ConversationItem[] = settled ? [{
  kind: "event", id: "settle-note", text: `本回合以提问暂停,等待答复:「${settled}的问题」`, tone: "notice", variant: "note", at: record.answeredAt,
}] : [];
function Snapshot({ taskId, history }: { taskId: string; history?: QuestionRecord[] }) {
  return <QuestionHistoryProvider history={useQuestionHistory(taskId, history, false)} messages={[]}><QuestionHistoryRemainder /></QuestionHistoryProvider>;
}
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
      {/* 删除经快照到达（删除结果的完整任务），随后列表刷新换成不带问答历史的投影。 */}
      <button onClick={() => setHistory([{ ...record, answer: "", reply: "", deleted: true }])}>快照里删掉</button>
      <button onClick={() => setHistory(undefined)}>去掉快照</button>
      <button onClick={() => { setTaskId("history-a"); setHistory(undefined); }}>切回任务</button>
      <output>{taskId}</output>
    </nav>
    {mounted && (mode === "snapshot"
      ? <Snapshot taskId={taskId} history={history} />
      : mode === "team"
        ? <TeamFeed task={task} rows={settleItems.map((item) => ({ kind: "conv", key: item.id, item }))} workers={[]} onOpenWorker={() => undefined} onAskLead={() => undefined} delegatingIds={new Set()} indicatorForTask={() => null} />
        : <ConversationFeed task={task} questionHistory={history} liveQuestionHistory items={settleItems} sessions={[]} loading={false} error={null} />)}
  </main>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);

import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import type { QuestionRecord } from "@ash/shared/questions";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import { QuestionCard } from "../../src/task-detail/QuestionCard.tsx";
import type { ConversationItem } from "../../src/task-detail/conversationModel.ts";
import "../../src/styles/global.css";

const storageKey = "ash-question-card-fixture";
const initial = {
  id: "question-fixture", projectId: "fixture", title: "确认问答卡交互", body: "", mode: "single", status: "paused",
  question: "开始前，确认两个细节。", questionOptions: null,
  questionItems: [
    { question: "回答过的卡片放在哪里？", options: ["留在会话里，点击展开", "同时提供历史入口"] },
    { question: "发给智能体的回复保留哪些内容？", options: ["只发答案和必要编号", "加一句简短说明"] },
  ],
  createdAt: "2026-09-10T01:00:00.000Z", updatedAt: "2026-09-10T01:00:00.000Z",
  labels: [], dependsOn: [], resumeDependsOn: [], agentType: "codex", archived: false,
} as Task;
const legacy = "【答复】你之前的提问:「是否保留原有配色？」\n\n保留配色，提高可读性。\n\n请据此继续完成任务。";
const oldItems: ConversationItem[] = [{ kind: "user", id: "legacy", text: legacy, isAnswer: true, bySystem: true, attachments: [], at: "2026-09-10T01:01:00.000Z" }];
function load(): { task: Task; records: QuestionRecord[]; items: ConversationItem[] } {
  try { const stored = localStorage.getItem(storageKey); if (stored) return JSON.parse(stored); } catch { /* empty fixture */ }
  return { task: initial, records: [], items: oldItems };
}
function Fixture() {
  const [state, setState] = useState(load);
  const [fail, setFail] = useState(false);
  const [calls, setCalls] = useState(0);
  const [payload, setPayload] = useState("");
  const update = (next: ReturnType<typeof load>) => { setState(next); localStorage.setItem(storageKey, JSON.stringify(next)); };
  return <main style={{ height: "100dvh", maxWidth: 960, margin: "0 auto", display: "flex", flexDirection: "column", background: "var(--canvas)" }}>
    <header style={{ padding: 12, display: "flex", flexWrap: "wrap", gap: 12, borderBottom: "1px solid var(--line)", fontSize: 12 }}>
      <b>问答卡交互验证</b>
      <button onClick={() => { update({ task: initial, records: [], items: oldItems }); setPayload(""); setCalls(0); setFail(false); }}>重置</button>
      <button onClick={() => update({ ...state, task: { ...initial, question: "选择界面优化方向", questionItems: null, questionOptions: ["清楚展示问题", "优化阅读层级\n减少重复文案"] } })}>单题</button>
      <button onClick={() => update({ ...state, task: { ...initial, id: `${state.task.id}-next` } })}>切换任务</button>
      <button onClick={() => update({ ...state, task: { ...state.task, status: state.task.status === "running" ? "paused" : "running" } })}>切换提问状态</button>
      <label><input type="checkbox" checked={fail} onChange={(event) => setFail(event.target.checked)} />模拟发送失败</label>
      <output aria-label="提交次数">提交 {calls} 次</output>
    </header>
    <div style={{ flex: 1, minHeight: 0 }}>
      <ConversationFeed task={state.task} items={state.items} sessions={[]} loading={false} error={null} questionHistory={state.records}
        footer={state.task.question ? <QuestionCard task={state.task} onAnswer={async (answer, input) => {
          setCalls((n) => n + 1);
          await new Promise((resolve) => setTimeout(resolve, 400));
          if (fail) throw new Error("发送失败，请重试。你的答案已保留。");
          const record: QuestionRecord = { id: crypto.randomUUID(), question: state.task.question, questionOptions: state.task.questionOptions,
            questionItems: state.task.questionItems, answer, answers: input.answers, answeredAt: new Date().toISOString(), reply: `【答复】\n${answer}` };
          setPayload(record.reply);
          update({ task: { ...state.task, question: null, questionOptions: null, questionItems: null }, records: [...state.records, record],
            items: [...state.items, { kind: "user", id: record.id, text: record.reply, isAnswer: true, bySystem: true, attachments: [], at: record.answeredAt }] });
        }} /> : undefined} />
    </div>
    {payload && <pre aria-label="发给智能体的回复" style={{ padding: 12, margin: 0, borderTop: "1px solid var(--line)", fontSize: 11, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{payload}</pre>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);

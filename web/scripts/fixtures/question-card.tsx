import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import type { QuestionRecord } from "@ash/shared/questions";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import { QuestionSlot } from "../../src/task-detail/QuestionSlot.tsx";
import type { ConversationItem } from "../../src/task-detail/conversationModel.ts";
import "../../src/styles/global.css";
import { longLegacyReply } from "./question-card-long-answer.ts";

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
// 超过答题卡的折叠阈值：背景先只露两行，点它看全。
const longContext = "我已把 probe 里 6 个相关任务中你的全部发言翻完，易用性要求已整理成清单（见本轮回复），"
  + "术语也落成了 ascut/CONTEXT.md 初版。现在按 grill 流程分轮拍板，这是第 1 轮——4 个根决策，"
  + "每个我都给了推荐答案，后续轮次会顺着答案往下追问。前三个决策彼此独立，最后一个依赖前两个的结论，"
  + "所以如果你对前两个还没想好，可以先跳过它，等回过头再补。";
// 服务端在提问那一轮结算时落的那句说明（带着问题全文）：界面认出它就不画，问题只在答题卡上出现一次。
const settleNote = (question: string): ConversationItem => ({
  kind: "event", id: "settle-note", text: `本回合以提问暂停,等待答复:「${question}」`, tone: "notice", variant: "note", at: "2026-09-10T01:02:00.000Z",
});
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
      <button onClick={() => update({ task: { ...initial, question: null, questionItems: null }, records: [], items: [
        { kind: "user", id: "long-answer", text: longLegacyReply, attachments: [], at: "2026-09-10T05:58:00.000Z" },
      ] })}>截图中的长问答</button>
      <button onClick={() => update({ ...state, task: { ...initial, question: "选择界面优化方向", questionItems: null, questionOptions: ["清楚展示问题", "优化阅读层级\n减少重复文案"] } })}>单题</button>
      <button onClick={() => update({ ...state, task: { ...initial, question: "这次改动叫什么名字？", questionItems: null, questionOptions: null } })}>没有选项</button>
      <button onClick={() => update({ ...state, task: { ...initial, question: longContext } })}>长背景</button>
      <button onClick={() => update({ ...state, task: { ...initial, id: `${state.task.id}-next` } })}>切换任务</button>
      <button onClick={() => update({ ...state, task: { ...state.task, status: state.task.status === "running" ? "paused" : "running" } })}>切换提问状态</button>
      <label><input type="checkbox" checked={fail} onChange={(event) => setFail(event.target.checked)} />模拟发送失败</label>
      <output aria-label="提交次数">提交 {calls} 次</output>
    </header>
    {/* 与 TaskDetail 的 `.task-detail-main` 一致：会话区是 flex 列，会话在上面滚，回复框那一格在下面——
        答题卡就停在那一格（QuestionSlot），平常那个框是一个替身（真回复框要连服务端）。 */}
    <div className="task-detail-main" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <ConversationFeed task={state.task} items={state.task.question ? [...state.items, settleNote(state.task.question)] : state.items}
        sessions={[]} loading={false} error={null} questionHistory={state.records} />
      <div className="task-reply-shell">
        <QuestionSlot task={state.task} box={<div className="task-reply-box"><textarea aria-label="回复任务" placeholder="回复…" /></div>}
          onAnswer={async (answer, input) => {
          setCalls((n) => n + 1);
          // 模拟一次网络往返，让「发送中」那一段在人工点检时看得见；自动化回归等的是结果，不依赖这段时长。
          await new Promise((resolve) => setTimeout(resolve, 400));
          if (fail) throw new Error("发送失败，请重试。你的答案已保留。");
          const record: QuestionRecord = { id: crypto.randomUUID(), question: state.task.question, questionOptions: state.task.questionOptions,
            questionItems: state.task.questionItems, answer, answers: input.answers, answeredAt: new Date().toISOString(), reply: `【答复】\n${answer}` };
          setPayload(record.reply);
          update({ task: { ...state.task, question: null, questionOptions: null, questionItems: null }, records: [...state.records, record],
            items: [...state.items, { kind: "user", id: record.id, text: record.reply, isAnswer: true, bySystem: true, attachments: [], at: record.answeredAt }] });
        }} />
      </div>
    </div>
    {payload && <pre aria-label="发给智能体的回复" style={{ padding: 12, margin: 0, borderTop: "1px solid var(--line)", fontSize: 11, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{payload}</pre>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);

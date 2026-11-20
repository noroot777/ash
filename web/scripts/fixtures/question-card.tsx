import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@navi/shared";
import type { QuestionAnswerInput, QuestionRecord } from "@navi/shared/questions";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import { ReplyBox } from "../../src/task-detail/ReplyBox.tsx";
import { TeamReplyBox } from "../../src/team/TeamReplyBox.tsx";
import { DraftProvider } from "../../src/lib/DraftStore.tsx";
import type { ConversationItem } from "../../src/task-detail/conversationModel.ts";
import "../../src/styles/global.css";
import { longLegacyReply } from "./question-card-long-answer.ts";

const storageKey = "navi-question-card-fixture-v2";
// `?host=team`：回复框那一格换成团队页的 TeamReplyBox（调度台是常驻会话，没有「那一轮还没结束」）。
const teamHost = new URLSearchParams(location.search).get("host") === "team";
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
// 服务端在提问那一轮结算时落的那句说明（带着问题全文）。题目在答题卡上、或答完跟着气泡留着时不画；
// 改发别的话把题撤下以后，它是这道题唯一留下的地方，照画（在「N 条记录」里）。
const settleNote = (question: string): ConversationItem => ({
  kind: "event", id: `settle-note:${question}`, text: `本回合以提问暂停,等待答复:「${question}」`, tone: "notice", variant: "note", at: "2026-09-10T01:02:00.000Z",
});
const oldItems: ConversationItem[] = [
  { kind: "user", id: "legacy", text: legacy, isAnswer: true, bySystem: true, attachments: [], at: "2026-09-10T01:01:00.000Z" },
  settleNote(initial.question!),
];
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
  // 换一道题来问：会话里跟着落那一道的结算说明。
  const ask = (task: Task) => update({ ...state, task, items: [...state.items, settleNote(task.question!)] });
  const single = { ...initial, question: "选择界面优化方向", questionItems: null, questionOptions: ["清楚展示问题", "优化阅读层级\n减少重复文案"] };
  // 题是服务端推来的，不是点出来的：回归要在浮层开着的时候让题到，点页面上任何一颗键都会先把浮层点关。
  (window as { fixtureAsk?: () => void }).fixtureAsk = () => ask(single);
  const submitAnswer = async (answer: string, input: QuestionAnswerInput, attachments?: string[]) => {
    setCalls((n) => n + 1);
    // 模拟一次网络往返，让「发送中」那一段在人工点检时看得见；自动化回归等的是结果，不依赖这段时长。
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (fail) throw new Error("发送失败，请重试。你的答案已保留。");
    const record: QuestionRecord = { id: crypto.randomUUID(), question: state.task.question, questionOptions: state.task.questionOptions,
      questionItems: state.task.questionItems, answer, answers: input.answers, answeredAt: new Date().toISOString(), reply: `【答复】\n${answer}` };
    // 带了附件时，落进会话的那条答复尾部是附件块（同 server/src/util.ts 的 attachmentsPrompt）。
    const text = record.reply + (attachments?.length
      ? `\n\n[用户附带的文件，请用 Read 工具查看以下本地文件]\n${attachments.map((path) => `- ${path}`).join("\n")}` : "");
    setPayload(text);
    update({ task: { ...state.task, question: null, questionOptions: null, questionItems: null }, records: [...state.records, record],
      items: [...state.items, { kind: "user", id: record.id, text, isAnswer: true, bySystem: true, attachments: [], answerIds: [record.id], at: record.answeredAt }] });
  };
  return <main style={{ height: "100dvh", maxWidth: 960, margin: "0 auto", display: "flex", flexDirection: "column", background: "var(--canvas)" }}>
    <header style={{ padding: 12, display: "flex", flexWrap: "wrap", gap: 12, borderBottom: "1px solid var(--line)", fontSize: 12 }}>
      <b>问答卡交互验证</b>
      <button onClick={() => { update({ task: initial, records: [], items: oldItems }); setPayload(""); setCalls(0); setFail(false); }}>重置</button>
      <button onClick={() => update({ task: { ...initial, question: null, questionItems: null }, records: [], items: [
        { kind: "user", id: "long-answer", text: longLegacyReply, attachments: [], at: "2026-09-10T05:58:00.000Z" },
      ] })}>截图中的长问答</button>
      <button onClick={() => ask(single)}>单题</button>
      <button onClick={() => ask({ ...initial, question: "这次改动叫什么名字？", questionItems: null, questionOptions: null })}>没有选项</button>
      <button onClick={() => ask({ ...initial, question: longContext })}>长背景</button>
      {/* 收起答题卡改发了一句别的：服务端撤下旧题（task-question-supersede.ts），不留问答记录。 */}
      <button onClick={() => update({ ...state, task: { ...state.task, question: null, questionOptions: null, questionItems: null } })}>撤下提问</button>
      <button onClick={() => update({ ...state, task: { ...initial, id: `${state.task.id}-next` } })}>切换任务</button>
      <button onClick={() => update({ ...state, task: { ...state.task, status: state.task.status === "running" ? "paused" : "running" } })}>切换提问状态</button>
      <button onClick={() => update({ ...state, task: { ...state.task, archived: !state.task.archived } })}>切换归档</button>
      <label><input type="checkbox" checked={fail} onChange={(event) => setFail(event.target.checked)} />模拟发送失败</label>
      <output aria-label="提交次数">提交 {calls} 次</output>
    </header>
    {/* 与 TaskDetail 的 `.task-detail-main` 一致：会话区是 flex 列，会话在上面滚，回复框那一格在下面——
        答题卡就停在那一格，接管的是真的 ReplyBox（框和框外的浮层）。 */}
    <div className="task-detail-main" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <ConversationFeed task={state.task} items={state.items} sessions={[]} loading={false} error={null} questionHistory={state.records} />
      {teamHost
        ? <TeamReplyBox task={{ ...state.task, mode: "team" }} tasks={[]} onSend={async () => ({ started: true })} onAnswer={submitAnswer} />
        : <ReplyBox task={state.task} hasConversation onSend={async () => ({ started: true })} onStandingExecutorChange={async () => undefined}
          onDiscuss={async () => undefined}
          onAnswer={submitAnswer} />}
    </div>
    {payload && <pre aria-label="发给智能体的回复" style={{ padding: 12, margin: 0, borderTop: "1px solid var(--line)", fontSize: 11, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{payload}</pre>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<DraftProvider><Fixture /></DraftProvider>);

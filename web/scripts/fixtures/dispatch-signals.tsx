// 派出的任务来问 / 失败，在派它的那条任务里（test-dispatch-signals-dom.mjs）。
//
// 挂的是 TaskDetail 自己用的那几样：useDispatchSignals（会话里那几颗气泡、回复框那一格轮到谁）、
// answerFromHost（答复送到哪）、真的 ConversationFeed 与 ReplyBox。服务端那一半是这里的一份「库」
// （存在 localStorage 里，刷新后还在），接口走真实的 api.ts → fetch，夹具在 fetch 这一层接住：
//   · GET  /tasks/lead/dispatch-signals —— 读这一份记录；
//   · POST /tasks/:id/answer            —— 记下请求，按服务端的做法撤下那一问、记下「你」那条答复。
// window.__server 让回归像服务端那样改「库」：别处答了、又来问、失败了、自己也来问。
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DispatchSignal, Task, TaskListItem } from "@ash/shared";
import type { QuestionRecord } from "@ash/shared/questions";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import { ReplyBox } from "../../src/task-detail/ReplyBox.tsx";
import { DraftProvider } from "../../src/lib/DraftStore.tsx";
import { dispatchedOf } from "../../src/lib/dispatchTree.ts";
import { answerFromHost, useDispatchSignals } from "../../src/task-detail/dispatched/useDispatchSignals.tsx";
import type { ConversationItem } from "../../src/task-detail/conversationModel.ts";
import "../../src/styles/global.css";

const KEY = "ash-dispatch-signals-fixture";
const at = (minutes: number) => new Date(Date.parse("2026-11-15T10:00:00.000Z") + minutes * 60_000).toISOString();
function task(id: string, title: string, extra: Partial<Task> = {}): Task {
  return {
    id, projectId: "p1", groupId: null, parentId: null, title, body: "", mode: "single", status: "done", stage: null,
    labels: [], dependsOn: [], resumeDependsOn: [], workflowMode: "free", agentType: "claude", archived: false,
    createdAt: at(0), updatedAt: at(0), ...extra,
  } as Task;
}

type Db = { tasks: Task[]; signals: DispatchSignal[]; requests: { url: string; body: unknown }[]; seq: number };
const initial = (): Db => ({
  tasks: [
    task("lead", "拆活的分析任务"),
    // 先建的那条后问：答题卡按提问先后，不按派出的先后。
    task("kid-a", "第一条派出去的", { dispatchedBy: "lead", status: "paused", executorLabel: "codex@cpa", createdAt: at(1),
      question: "第一条的问题：先迁数据还是先改接口？", questionOptions: ["先迁数据", "先改接口"], updatedAt: at(12) }),
    task("kid-b", "第二条派出去的", { dispatchedBy: "lead", status: "paused", executorLabel: "claude@nodemach", createdAt: at(2),
      question: "第二条的问题：要不要顺手改文档？后面这句不进气泡。", questionOptions: ["要", "不要"], updatedAt: at(6) }),
    task("kid-c", "第三条派出去的", { dispatchedBy: "lead", status: "running", executorLabel: "claude@nodemach", createdAt: at(3) }),
    // 孙一层在问：只冒到它的上一层（kid-c），不到这里。
    task("grand", "孙一层", { dispatchedBy: "kid-c", status: "paused", createdAt: at(4), question: "孙一层的问题", updatedAt: at(5) }),
  ],
  signals: [
    { seq: 1, taskId: "kid-b", kind: "question", at: at(6), question: "第二条的问题：要不要顺手改文档？后面这句不进气泡。", questionOptions: ["要", "不要"], answered: false },
    { seq: 2, taskId: "kid-a", kind: "question", at: at(12), question: "第一条的问题：先迁数据还是先改接口？", questionOptions: ["先迁数据", "先改接口"], answered: false },
  ],
  requests: [],
  seq: 2,
});
const load = (): Db => {
  try { const stored = localStorage.getItem(KEY); if (stored) return JSON.parse(stored) as Db; } catch { /* 空库 */ }
  return initial();
};
let db = load();
const listeners = new Set<() => void>();
const commit = (next: Db) => {
  db = next;
  localStorage.setItem(KEY, JSON.stringify(db));
  for (const listener of listeners) listener();
};
const unask = (id: string) => db.tasks.map((row) => row.id === id ? { ...row, question: null, questionOptions: null, questionItems: null, status: "running" as const } : row);

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes("/api/")) return realFetch(input, init);
  if (url.endsWith("/tasks/lead/dispatch-signals")) return Response.json(db.signals);
  const answered = url.match(/\/api\/tasks\/([^/]+)\/answer$/);
  if (answered && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as { answer: string; answers?: string[]; via?: string };
    const id = answered[1]!;
    const asking = db.tasks.find((row) => row.id === id)!;
    const record: QuestionRecord = { id: `answer-${id}`, question: asking.question, questionOptions: asking.questionOptions,
      answer: body.answer, answers: body.answers, reply: `【答复】\n${body.answer}`, answeredAt: at(20) };
    const latest = db.signals.findLast((signal) => signal.taskId === id && signal.kind === "question");
    commit({
      ...db,
      requests: [...db.requests, { url: `/tasks/${id}/answer`, body }],
      tasks: unask(id),
      signals: db.signals.map((signal) => signal === latest
        ? { ...signal, answered: true, ...(body.via === asking.dispatchedBy ? { answer: record } : {}) } : signal),
    });
    return Response.json({ answered: true, resumed: true, record });
  }
  // 别的写操作记下来（回归要证明这条任务自己一发都没收到）；读取照常给空。
  if (init?.method && init.method !== "GET") db = { ...db, requests: [...db.requests, { url: url.replace(/^.*\/api/, ""), body: init.body ?? null }] };
  return Response.json([]);
};

declare global {
  interface Window {
    __server: {
      answerElsewhere: (id: string) => void;
      ask: (id: string, question: string, minute: number) => void;
      fail: (id: string, reason: string, minute: number) => void;
      requests: () => Db["requests"];
      reset: () => void;
    };
  }
}
window.__server = {
  answerElsewhere: (id) => {
    const latest = db.signals.findLast((signal) => signal.taskId === id && signal.kind === "question");
    commit({ ...db, tasks: unask(id), signals: db.signals.map((signal) => signal === latest ? { ...signal, answered: true } : signal) });
  },
  ask: (id, question, minute) => {
    const seq = db.seq + 1;
    commit({
      ...db, seq,
      tasks: db.tasks.map((row) => row.id === id ? { ...row, question, questionOptions: null, status: "paused", updatedAt: at(minute) } : row),
      // 只有派出去的任务来问才在 lead 名下记一行（自己来问的不记）。
      signals: id === "lead" ? db.signals : [...db.signals, { seq, taskId: id, kind: "question", at: at(minute), question, answered: false }],
    });
  },
  fail: (id, reason, minute) => {
    const seq = db.seq + 1;
    commit({ ...db, seq, tasks: db.tasks.map((row) => row.id === id ? { ...row, status: "failed" } : row),
      signals: [...db.signals, { seq, taskId: id, kind: "failed", at: at(minute), reason }] });
  },
  requests: () => db.requests,
  reset: () => { localStorage.removeItem(KEY); db = initial(); },
};

// 会话正文：两句，派出的任务来问的那几刻插在它们之间、之后。
const items: ConversationItem[] = [
  { kind: "user", id: "u1", text: "按刚才的拆法派出去吧。", attachments: [], at: at(0) },
  { kind: "user", id: "u2", text: "第二条先别动数据库。", attachments: [], at: at(10) },
];

function Fixture() {
  const [, setVersion] = useState(0);
  const [opened, setOpened] = useState("");
  useEffect(() => {
    const listener = () => setVersion((n) => n + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  const tasks: TaskListItem[] = db.tasks;
  const lead = db.tasks.find((row) => row.id === "lead")!;
  const signals = useDispatchSignals({ task: lead, allTasks: tasks, dispatched: dispatchedOf(tasks, "lead"), onOpen: setOpened });
  return (
    <main style={{ height: "100dvh", maxWidth: 960, margin: "0 auto", display: "flex", flexDirection: "column", background: "var(--canvas)" }}>
      <output aria-label="左边抽屉里开着的">{opened}</output>
      <div className="task-detail-main" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <ConversationFeed task={lead} items={items} sessions={[]} loading={false} error={null} questionHistory={[]} asides={signals.asides} />
        <ReplyBox task={lead} hasConversation onSend={async () => ({ started: true })} onStandingExecutorChange={async () => undefined}
          asking={signals.asking} onAnswer={answerFromHost(lead.id, () => undefined)} />
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<DraftProvider><Fixture /></DraftProvider>);

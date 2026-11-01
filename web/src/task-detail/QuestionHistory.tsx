import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { CaretDown, CheckCircle } from "@phosphor-icons/react";
import { formatQuestionAnswers, legacyQuestionRecord, questionItems, questionOptionSelected, type QuestionRecord } from "@ash/shared/questions";
import { api } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";
import { catchUpAbortKind } from "../lib/catchUp.ts";
import { useCatchUp, useCatchUpLink } from "../lib/useCatchUp.ts";
import { CopyButton } from "../components/CopyButton.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { formatInstant } from "./utils.ts";

type QuestionMessage = { id: string; text: string };
const HistoryContext = createContext<{ records: QuestionRecord[]; messages: QuestionMessage[]; error?: string; retry?: () => void }>({ records: [], messages: [] });

function mergeRecords(left: QuestionRecord[], right: QuestionRecord[]): QuestionRecord[] {
  return [...new Map([...left, ...right].map((record) => [record.id, record])).values()]
    .sort((a, b) => a.answeredAt.localeCompare(b.answeredAt));
}

export function QuestionHistoryProvider({ taskId, history, live = history === undefined, messages, children }: {
  taskId: string;
  history?: QuestionRecord[];
  live?: boolean;
  messages: QuestionMessage[];
  children: ReactNode;
}) {
  if (!live) return <HistoryContext value={{ records: history ?? [], messages }}>{children}</HistoryContext>;
  return <LocalQuestionHistory key={taskId} taskId={taskId} history={history} messages={messages}>{children}</LocalQuestionHistory>;
}

function LocalQuestionHistory({ taskId, history, messages, children }: {
  taskId: string; history?: QuestionRecord[]; messages: QuestionMessage[]; children: ReactNode;
}) {
  const [state, setState] = useState<{ taskId: string; records: QuestionRecord[]; error?: string }>({ taskId, records: history ?? [] });
  // 连上过没有。连上过之后就不再走那条「没连上时延迟兜底读一次」的路 —— 断线期间读也读
  // 不到,而追平那一层会自己重试到读到。
  const connectedOnce = useRef(false);
  useEffect(() => {
    if (history !== undefined) setState((current) => ({ taskId, records: mergeRecords(current.records, history) }));
  }, [taskId, history]);
  // 读取、重试、代次都交给追平层(lib/catchUp.ts):这个组件原先自己写了一套 generation +
  // connectedOnce + setTimeout,而读失败不重试、断线也不作废在途那一发(第 5 轮审查 N1 点到
  // 的五处写法之一)。`taskId` 作身份:它一变就是新一代次。
  const catchUp = useCatchUp((signal) => api.taskQuestionHistory(taskId, signal).then(
    (records) => {
      setState((current) => ({ taskId, records: mergeRecords(current.taskId === taskId ? current.records : [], records) }));
      return true;
    },
    (error) => {
      // **主动取消不是读取失败**(本轮审查 N1)。断线作废这一代次、以及有人点「重试」把在途
      // 那一发接替掉(`runNow`),都会 abort 这一发 —— 它的 rejection 一路冒上来被写成「加载
      // 失败」,而那一刻压根没有任何读取失败,得等下一发成功才消掉。追平层的其它四个消费者
      // (useTasks / useTaskMonitors / useRejectionNotices / useAcceptGate)都接了这一道,
      // 问答历史漏接了同一个协议。
      //
      // 换代次的那一种一个字都不说:新代次会自己追平。等到点的那一种照实说 —— 它的 reason
      // 本身就是人话,而且追平层还会接着重试。
      if (catchUpAbortKind(signal, error) === "stale") return false;
      // 如实显示「这一份没读到」,同时让追平层接着重试 —— 两件事不冲突(上一版只做了前者)。
      setState((current) => ({ taskId, records: current.taskId === taskId ? current.records : [], error: String(error?.message ?? error) }));
      return false;
    },
  ), taskId);
  // 交给「重试」按钮的是抢占式那一个:人点了就该立刻去读,不排在一发背景读取后面。
  const reload = catchUp.runNow;
  const connected = useServerEvents((event) => {
    const records = event.type === "task.question" && event.taskId === taskId && event.answeredQuestion
      ? [event.answeredQuestion]
      : event.type === "task.updated" && event.task.id === taskId ? event.task.questionHistory : undefined;
    if (records) setState((current) => ({ taskId, records: mergeRecords(current.taskId === taskId ? current.records : [], records) }));
  });
  // 连上就对账、断线就作废(统一接线,见 lib/useCatchUp.ts)。
  useCatchUpLink(catchUp, connected);
  useEffect(() => {
    if (connected) {
      connectedOnce.current = true;
      return;
    }
    if (connectedOnce.current) return;
    // 调用方快照可能早于最近一次答复;事件流还没连上时用一次轻量读取补齐。
    const timer = setTimeout(() => { void catchUp.run(); }, 1000);
    return () => clearTimeout(timer);
  }, [catchUp, connected]);
  const local = state.taskId === taskId ? state : { records: [], error: undefined };
  return <HistoryContext value={{ records: local.records, messages, error: local.error, retry: reload }}>{children}</HistoryContext>;
}

export function AnsweredQuestionCard({ record }: { record: QuestionRecord }) {
  const items = questionItems(record);
  const answers = record.answers ?? (items.length === 1 ? [record.answer] : undefined);
  const partial = answers?.some((answer) => !answer.trim());
  const answerText = answers ? formatQuestionAnswers(answers) : record.answer;
  return (
    <details className="task-question-record">
      <summary>
        <CheckCircle className="task-question-record-icon" size={18} weight="duotone" aria-hidden="true" />
        <span className="task-question-record-summary">
          <span><b>你的答复</b>{partial && <small>已部分答复</small>}{record.answeredAt && <time>{formatInstant(record.answeredAt)}</time>}</span>
          {/* 折起来时这一行就是整张卡的全部可见内容，不能跟着外面那层 `<summary>` 一起被
              当成界面装置剔掉（见 side-chat/selectionContent.ts）。 */}
          <span className="task-question-record-preview" data-selection-content="">{answerText}</span>
        </span>
        <span className="task-question-record-action">查看问答</span>
        <CaretDown className="task-question-record-caret" size={14} aria-hidden="true" />
      </summary>
      <div className="task-question-record-body">
        {record.questionItems?.length && record.question ? <div className="task-question-context"><MarkdownBody text={record.question} /></div> : null}
        {items.map((item, index) => (
          <section key={index}>
            <div className="task-question-title">
              {items.length > 1 && <span>{index + 1}</span>}
              <MarkdownBody text={item.question} />
            </div>
            {!!item.options?.length && <ul className="task-question-record-options" aria-label="当时的选项">
              {item.options.map((option, i) => <li key={i} className={questionOptionSelected(answers?.[index] ?? "", option) ? "is-selected" : undefined}>{option}</li>)}
            </ul>}
            {answers && <div className={`task-question-record-answer${answers[index]?.trim() ? "" : " is-empty"}`}>
              <b>你的答案</b><p>{answers[index]?.trim() || "未答复"}</p>
            </div>}
          </section>
        ))}
        {!answers && <div className="task-question-record-answer"><b>你的答案</b><p>{record.answer}</p></div>}
        <footer><CopyButton value={answerText} label="复制答案" ariaLabel="复制答案" icon /><span>已发送的答复</span></footer>
      </div>
    </details>
  );
}

export function AnsweredQuestionMessage({ text, id, at }: { text: string; id: string; at?: string }) {
  const { records, messages } = useContext(HistoryContext);
  const matches = records.filter((record) => record.reply === text);
  const occurrence = messages.filter((message) => message.text === text).findIndex((message) => message.id === id);
  const record = matches[Math.max(0, occurrence)]
    ?? legacyQuestionRecord(text, id, at)
    ?? { id, question: "你的答复", answer: text.trimStart().replace(/^【答复】\s*/, ""), reply: text, answeredAt: at ?? "" };
  return <AnsweredQuestionCard record={record} />;
}

export function QuestionHistoryRemainder({ messages }: { messages: readonly string[] }) {
  const { records, error, retry } = useContext(HistoryContext);
  const remaining = [...messages];
  const unshown = records.filter((record) => {
    const index = remaining.indexOf(record.reply);
    if (index < 0) return true;
    remaining.splice(index, 1);
    return false;
  });
  return <>
    {unshown.map((record) => <AnsweredQuestionCard key={record.id} record={record} />)}
    {error && <p className="task-question-history-error" role="status">问答记录加载失败 <button type="button" onClick={retry}>重试</button></p>}
  </>;
}

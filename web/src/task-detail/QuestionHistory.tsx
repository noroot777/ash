import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { CaretDown, CheckCircle } from "@phosphor-icons/react";
import { formatQuestionAnswers, legacyQuestionRecord, questionItems, questionOptionSelected, type QuestionRecord } from "@ash/shared/questions";
import { api } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";
import { CopyButton } from "../components/CopyButton.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { formatInstant } from "./utils.ts";

type QuestionMessage = { id: string; text: string };
const HistoryContext = createContext<{ records: QuestionRecord[]; messages: QuestionMessage[]; error?: string; retry?: () => void }>({ records: [], messages: [] });

function mergeRecords(left: QuestionRecord[], right: QuestionRecord[]): QuestionRecord[] {
  return [...new Map([...left, ...right].map((record) => [record.id, record])).values()]
    .sort((a, b) => a.answeredAt.localeCompare(b.answeredAt));
}

export function QuestionHistoryProvider({ taskId, history, messages, children }: {
  taskId: string;
  history?: QuestionRecord[];
  messages: QuestionMessage[];
  children: ReactNode;
}) {
  if (history !== undefined) return <HistoryContext value={{ records: history, messages }}>{children}</HistoryContext>;
  return <LocalQuestionHistory key={taskId} taskId={taskId} messages={messages}>{children}</LocalQuestionHistory>;
}

function LocalQuestionHistory({ taskId, messages, children }: { taskId: string; messages: QuestionMessage[]; children: ReactNode }) {
  const [state, setState] = useState<{ taskId: string; records: QuestionRecord[]; error?: string }>({ taskId, records: [] });
  const generation = useRef(0);
  const reload = useCallback(() => {
    const token = ++generation.current;
    void api.task(taskId).then((task) => {
      if (token !== generation.current) return;
      setState((current) => ({ taskId, records: mergeRecords(current.taskId === taskId ? current.records : [], task.questionHistory ?? []) }));
    }).catch((error) => {
      if (token !== generation.current) return;
      setState((current) => ({ taskId, records: current.taskId === taskId ? current.records : [], error: String(error.message ?? error) }));
    });
  }, [taskId]);
  useEffect(() => {
    reload();
    return () => { generation.current += 1; };
  }, [reload]);
  const connected = useServerEvents((event) => {
    const records = event.type === "task.question" && event.taskId === taskId && event.answeredQuestion
      ? [event.answeredQuestion]
      : event.type === "task.updated" && event.task.id === taskId ? event.task.questionHistory : undefined;
    if (records) setState((current) => ({ taskId, records: mergeRecords(current.taskId === taskId ? current.records : [], records) }));
  });
  useEffect(() => { if (connected) reload(); }, [connected, reload]);
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
          <span className="task-question-record-preview">{answerText}</span>
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

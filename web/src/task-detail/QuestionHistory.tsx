import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  formatQuestionAnswers, legacyQuestionRecord, pairAnswerMessages, questionItems, questionOptionSelected, type QuestionRecord,
} from "@ash/shared/questions";
import { api } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";
import { catchUpAbortKind } from "../lib/catchUp.ts";
import { useCatchUp, useCatchUpLink } from "../lib/useCatchUp.ts";
import { CopyButton } from "../components/CopyButton.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import type { ConversationSource } from "./conversationModel.ts";
import { DeleteMessageButton, type DeletableItem } from "./MessageDelete.tsx";
import { formatInstant } from "./utils.ts";

/** 会话里的一句真人输入（气泡）。答复卡按 `answerIds` / 出处认它对的是哪条问答记录。 */
type QuestionMessage = { id: string; text: string; answerIds?: readonly string[]; sources?: ConversationSource[] };
type Pairing = ReturnType<typeof pairAnswerMessages>;
const HistoryContext = createContext<{ pairing: Pairing; error?: string; retry?: () => void }>({
  pairing: { paired: new Map(), unpaired: [] },
});

/**
 * 按 id 合并几份问答历史（props 快照、整份读取、事件推送，先后不定）。删除是单向的：哪一份
 * 里它是墓碑就留墓碑 —— 删除之前发出、删除之后才到的那份旧读取不能把删掉的答复复活。记录
 * 答复之后除了被删不会再变，所以别的字段不存在「旧的盖新的」。
 */
function mergeRecords(left: QuestionRecord[], right: QuestionRecord[]): QuestionRecord[] {
  const merged = new Map<string, QuestionRecord>();
  for (const record of [...left, ...right]) {
    const known = merged.get(record.id);
    merged.set(record.id, known?.deleted && !record.deleted ? known : record);
  }
  return [...merged.values()].sort((a, b) => a.answeredAt.localeCompare(b.answeredAt));
}

const segmentOf = (sources: readonly ConversationSource[] | undefined) => {
  const source = sources?.find((candidate) => "index" in candidate);
  return source && "index" in source ? { sessionId: source.sessionId, index: source.index } : undefined;
};

/** 答复 ↔ 记录的配对，判据与服务端删除同一份（shared/questions.ts `pairAnswerMessages`）。 */
function PairedHistory({ records, messages, error, retry, children }: {
  records: QuestionRecord[]; messages: QuestionMessage[]; error?: string; retry?: () => void; children: ReactNode;
}) {
  const pairing = useMemo(() => pairAnswerMessages(records, messages.map((message) => ({
    key: message.id, text: message.text, answerIds: message.answerIds, source: segmentOf(message.sources),
  }))), [records, messages]);
  return <HistoryContext value={{ pairing, error, retry }}>{children}</HistoryContext>;
}

export function QuestionHistoryProvider({ taskId, history, live = history === undefined, messages, children }: {
  taskId: string;
  history?: QuestionRecord[];
  live?: boolean;
  messages: QuestionMessage[];
  children: ReactNode;
}) {
  if (!live) return <PairedHistory records={history ?? []} messages={messages}>{children}</PairedHistory>;
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
  return <PairedHistory records={local.records} messages={messages} error={local.error} retry={reload}>{children}</PairedHistory>;
}

/** 引文里只放一行纯文字：多余的空白收掉，长了交给样式去截。 */
const plain = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * 一题的引文：问题引在答案上面，淡一档、左边一道竖线。它是一颗键——引文截成两行，点开是
 * 完整的问题和当时给的选项（选中的那几个标出来）；平时不摊开。
 */
function QuestionQuote({ question, options, answer, number }: {
  question: string;
  options?: readonly string[];
  answer?: string;
  number?: number;
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  if (!question.trim() && !options?.length) return null;
  return <>
    <button
      type="button"
      className="task-question-quote"
      aria-expanded={open}
      aria-controls={detailId}
      aria-label={`${number ? `第 ${number} 题：` : "答的是："}${plain(question)}，${open ? "收起" : "看完整的问题和当时的选项"}`}
      onClick={() => setOpen((value) => !value)}
    >
      {number && <span className="task-question-quote-number">{number}</span>}
      <span className="task-question-quote-text">{plain(question)}</span>
    </button>
    {open && <div className="task-question-quote-full" id={detailId}>
      {question.trim() && <MarkdownBody text={question} />}
      {!!options?.length && <ul className="task-question-record-options" aria-label="当时的选项">
        {options.map((option, i) => <li key={i} className={questionOptionSelected(answer ?? "", option) ? "is-selected" : undefined}>{option}</li>)}
      </ul>}
    </div>}
  </>;
}

/**
 * 答过的一次提问：就是你的一个气泡（跟你别的话同一种长相），问题引在答案上面。
 * 多题时一题一段：引文、答案，留空的题写「未答复」。
 *
 * `deletable`：这张卡出自会话里的那条答复（有出处才删得掉，见 MessageDelete.tsx）。
 */
export function AnsweredQuestionCard({ record, deletable }: { record: QuestionRecord; deletable?: DeletableItem }) {
  const items = questionItems(record);
  const answers = record.answers ?? (items.length === 1 ? [record.answer] : undefined);
  const partial = answers?.some((answer) => !answer.trim());
  const answerText = answers ? formatQuestionAnswers(answers) : record.answer;
  const multi = items.length > 1;
  return (
    <article className="task-message task-message--user task-question-record">
      <div className="task-user-bubble task-question-bubble">
        <header>
          <b>你</b>
          {partial && <small>已部分答复</small>}
          {record.answeredAt && <time>{formatInstant(record.answeredAt)}</time>}
          <CopyButton value={answerText} ariaLabel="复制答案" icon />
          {deletable && <DeleteMessageButton item={deletable} />}
        </header>
        {multi && record.question?.trim() && <QuestionQuote question={record.question} />}
        {answers
          ? items.map((item, index) => (
            <section key={index} className="task-question-pair">
              <QuestionQuote question={item.question} options={item.options} answer={answers[index]} number={multi ? index + 1 : undefined} />
              <p className={answers[index]?.trim() ? undefined : "is-empty"}>{answers[index]?.trim() || "未答复"}</p>
            </section>
          ))
          : <>
            {items.map((item, index) => <QuestionQuote key={index} question={item.question} options={item.options} number={multi ? index + 1 : undefined} />)}
            <p>{record.answer}</p>
          </>}
      </div>
    </article>
  );
}

export function AnsweredQuestionMessage({ text, id, at, deletable }: { text: string; id: string; at?: string; deletable?: DeletableItem }) {
  const { pairing } = useContext(HistoryContext);
  const paired = pairing.paired.get(id);
  const record = (paired && !paired.deleted ? paired : undefined)
    ?? legacyQuestionRecord(text, id, at)
    ?? { id, question: "你的答复", answer: text.trimStart().replace(/^【答复】\s*/, ""), reply: text, answeredAt: at ?? "" };
  // 删除时指名这张卡对的那条记录：老会话的段上没有 answerIds，服务端靠它认（核对原文才删）。
  const target = deletable && paired
    ? { sources: deletable.sources?.map((source) => "index" in source ? { ...source, answerId: paired.id } : source) }
    : deletable;
  return <AnsweredQuestionCard record={record} deletable={target} />;
}

/** 问答历史里有、会话里找不到出处的那些答复（不在这几条会话里），补成卡片放在末尾。 */
export function QuestionHistoryRemainder() {
  const { pairing, error, retry } = useContext(HistoryContext);
  return <>
    {pairing.unpaired.map((record) => <AnsweredQuestionCard key={record.id} record={record} />)}
    {error && <p className="task-question-history-error" role="status">问答记录加载失败 <button type="button" onClick={retry}>重试</button></p>}
  </>;
}

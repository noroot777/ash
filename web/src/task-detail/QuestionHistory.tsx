import { createContext, useContext, useId, useMemo, useState, type ReactNode } from "react";
import {
  formatQuestionAnswers, legacyQuestionRecord, pairAnswerMessages, questionItems, questionOptionSelected, type QuestionRecord,
} from "@navi/shared/questions";
import { parseAttachmentText } from "@navi/shared/attachments";
import { dispatchLaunchOf } from "@navi/shared/dispatch-plan";
import { CopyButton } from "../components/CopyButton.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import type { ConversationSource } from "./conversationModel.ts";
import { MessageAttachments } from "./Attachments.tsx";
import { DispatchNoteLine } from "./DispatchNoteLine.tsx";
import { DeleteMessageButton, type DeletableItem } from "./MessageDelete.tsx";
import { formatInstant } from "./utils.ts";
import type { QuestionHistoryState } from "./useQuestionHistory.ts";

/** 会话里的一句真人输入（气泡）。答复卡按 `answerIds` / 出处认它对的是哪条问答记录。 */
type QuestionMessage = { id: string; text: string; answerIds?: readonly string[]; sources?: ConversationSource[] };
type Pairing = ReturnType<typeof pairAnswerMessages>;
const HistoryContext = createContext<{ pairing: Pairing; error?: string; retry?: () => void; onOpenTask?: (taskId: string) => void }>({
  pairing: { paired: new Map(), unpaired: [] },
});

const segmentOf = (sources: readonly ConversationSource[] | undefined) => {
  const source = sources?.find((candidate) => "index" in candidate);
  return source && "index" in source ? { sessionId: source.sessionId, index: source.index } : undefined;
};

/** 答复 ↔ 记录的配对，判据与服务端删除同一份（shared/questions.ts `pairAnswerMessages`）。 */
function PairedHistory({ records, messages, error, retry, onOpenTask, children }: {
  records: QuestionRecord[]; messages: QuestionMessage[]; error?: string; retry?: () => void;
  onOpenTask?: (taskId: string) => void; children: ReactNode;
}) {
  const pairing = useMemo(() => pairAnswerMessages(records, messages.map((message) => ({
    key: message.id, text: message.text, answerIds: message.answerIds, source: segmentOf(message.sources),
  }))), [records, messages]);
  return <HistoryContext value={{ pairing, error, retry, onOpenTask }}>{children}</HistoryContext>;
}

/**
 * 会话里答过的气泡认记录用的那一层。记录本身由会话组件用 useQuestionHistory 取好传进来——同一份
 * 还要拿去判结算说明画不画（见 useQuestionHistory.ts 开头），这里不另读一份。
 */
export function QuestionHistoryProvider({ history, messages, onOpenTask, children }: {
  history: QuestionHistoryState;
  messages: QuestionMessage[];
  /** 派出记录那几句点了打开哪条任务；不给（远程视图）就只是一句话。 */
  onOpenTask?: (taskId: string) => void;
  children: ReactNode;
}) {
  return <PairedHistory records={history.records} messages={messages} error={history.error} retry={history.retry} onOpenTask={onOpenTask}>{children}</PairedHistory>;
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
export function AnsweredQuestionCard({ record, deletable, attachments = [] }: {
  record: QuestionRecord;
  deletable?: DeletableItem;
  /** 随答复贴的图和文件（问答记录里没有，出自会话里那条答复）。 */
  attachments?: readonly string[];
}) {
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
        <MessageAttachments paths={[...attachments]} />
      </div>
    </article>
  );
}

export function AnsweredQuestionMessage({ text, id, at, deletable, attachments = [] }: {
  text: string; id: string; at?: string; deletable?: DeletableItem; attachments?: readonly string[];
}) {
  const { pairing } = useContext(HistoryContext);
  const paired = pairing.paired.get(id);
  if (paired && dispatchLaunchOf(paired)) return <DispatchLaunchLines record={paired} />;
  // 带了附件的答复，会话原文尾部是附件块（server attachmentsPrompt）：摘出来画成缩略图，答案只留正文。
  const parsed = parseAttachmentText(text);
  const record = (paired && !paired.deleted ? paired : undefined)
    ?? legacyQuestionRecord(parsed.body, id, at)
    ?? { id, question: "你的答复", answer: parsed.body.replace(/^【答复】\s*/, ""), reply: text, answeredAt: at ?? "" };
  // 删除时指名这张卡对的那条记录：老会话的段上没有 answerIds，服务端靠它认（核对原文才删）。
  const target = deletable && paired
    ? { sources: deletable.sources?.map((source) => "index" in source ? { ...source, answerId: paired.id } : source) }
    : deletable;
  return <AnsweredQuestionCard record={record} deletable={target} attachments={[...parsed.paths, ...attachments]} />;
}

/**
 * 派活单「派出去」那一下（shared dispatch-plan.ts `dispatchLaunchOf`）：每条新任务一句「开了新任务」，不画「你」的
 * 气泡——那段答复只是交给智能体的回执。出自问答记录本身，远程视图、子任务删掉以后照样在。
 */
function DispatchLaunchLines({ record }: { record: QuestionRecord }) {
  const { onOpenTask } = useContext(HistoryContext);
  return <>{dispatchLaunchOf(record)!.map((task) => <DispatchNoteLine key={task.id} note={task} onOpen={onOpenTask} />)}</>;
}

/** 问答历史里有、会话里找不到出处的那些答复（不在这几条会话里），补成卡片放在末尾。 */
export function QuestionHistoryRemainder() {
  const { pairing, error, retry } = useContext(HistoryContext);
  return <>
    {pairing.unpaired.map((record) => dispatchLaunchOf(record)
      ? <DispatchLaunchLines key={record.id} record={record} />
      : <AnsweredQuestionCard key={record.id} record={record} />)}
    {error && <p className="task-question-history-error" role="status">问答记录加载失败 <button type="button" onClick={retry}>重试</button></p>}
  </>;
}

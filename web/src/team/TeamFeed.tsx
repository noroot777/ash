import { useMemo, useRef } from "react";
import type { Task, TaskListItem } from "@ash/shared";
import { runActivityPhase, runActivityTail } from "@ash/shared/run-activity";
import { annotationBatchDisplayText } from "@ash/shared/page-annotation-display";
import type { Batch } from "@ash/shared/team";
import { ArrowElbowDownRight, ArrowRight, SpinnerGap } from "@phosphor-icons/react";
import { ConversationScrollControls } from "../components/ConversationScrollControls.tsx";
import { contentVersion } from "../lib/useStickToBottom.ts";
import { conversationItemSize } from "../task-detail/conversationContentSize.ts";
import { AgentRunMeta } from "../components/AgentRunMeta.tsx";
import { AgentTurnBody } from "../components/AgentTurnBody.tsx";
import { ImagePreviewGroup } from "../components/ImagePreview.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { RunActivity } from "../components/RunActivity.tsx";
import { MessageFooter } from "../components/MessageFooter.tsx";
import { TaskStatusDot } from "../components/TaskStatusDot.tsx";
import type { IndicatorForTask } from "../lib/useTaskReadState.ts";
import { MessageAttachments } from "../task-detail/Attachments.tsx";
import { AnsweredQuestionMessage, QuestionHistoryProvider, QuestionHistoryRemainder } from "../task-detail/QuestionHistory.tsx";
import { isQuestionAnswer } from "@ash/shared/questions";
import { SystemAuthoredMessage, SystemBoundary, SystemEventNote } from "../task-detail/SystemNotice.tsx";
import { isReviewSystemPrompt } from "../task-detail/systemNoticeModel.ts";
import { durationBetween, formatInstant, parseAttachmentText } from "../task-detail/utils.ts";
import { executorLabel, parseInbound, teamLeadLabel, workerStatusText, type InboundMessage, type TeamFeedRow } from "./teamModel.ts";
import { MonitorWakeReply } from "../task-detail/MonitorWakeInput.tsx";
import { monitorWakeReplyIds } from "../task-detail/monitorWakeModel.ts";
import { conversationInputAnchor, conversationInputs, REQUIREMENT_INPUT_ID, requirementAuthor } from "../task-detail/conversationInputs.ts";
import { ReuseInputButton, type ReusableInput } from "../task-detail/ReuseInput.tsx";

function AgentRow({
  row,
  taskId,
  hideTime,
  wakeReply,
}: {
  row: Extract<TeamFeedRow, { kind: "conv" }>["item"];
  /** 这条发言是在哪个任务的工作目录里说的（正文里的图靠它去那个目录取），见 AgentTurnBody。 */
  taskId: string;
  hideTime?: boolean;
  wakeReply?: boolean;
}) {
  if (row.kind !== "agent") return null;
  const duration = durationBetween(row.at, row.endedAt);
  const compactContinuation = !!row.continuation && !!hideTime && !duration;
  return (
    <article className={`team-feed-agent${row.continuation ? " is-continuation" : ""}`}>
      {!compactContinuation && (
        <header>
          {!row.continuation && (
            <span className="agent-run-identity">
              <b>{row.label}</b>
              <AgentRunMeta run={row.run} />
            </span>
          )}
          {!hideTime && row.at && <time>{formatInstant(row.at)}</time>}
          {duration && <small className="task-turn-duration" title={`开始 ${formatInstant(row.at)} · 结束 ${formatInstant(row.endedAt)}`}>{row.continuation ? "" : "· "}⏱ {duration} 用时</small>}
        </header>
      )}
      {wakeReply && <MonitorWakeReply />}
      <AgentTurnBody segments={row.segments} running={!row.endedAt} taskId={taskId} />
      <MessageFooter
        turnUsage={row.usage}
        session={row.showSessionMeta ? row.session : null}
        sessionContext={row.sessionContext}
      />
    </article>
  );
}

function UserRow({ row, onReuse }: { row: Extract<TeamFeedRow, { kind: "conv" }>["item"]; onReuse?: (input: ReusableInput) => void }) {
  if (row.kind !== "user") return null;
  if (row.isAnswer || isQuestionAnswer(row.text)) return <AnsweredQuestionMessage text={row.text} id={row.id} at={row.at} />;
  const bySystem = !!row.bySystem;
  if (bySystem && !isReviewSystemPrompt(row.text)) {
    return <SystemAuthoredMessage item={row} surface="team" />;
  }
  return <UserBubble id={row.id} author={bySystem ? "系统" : "你"} text={row.text} attachments={row.attachments} at={row.at} bySystem={bySystem} onReuse={onReuse} />;
}

/**
 * 一颗普通的输入气泡。调度台的原始需求（任务正文）直接用它画第一颗、不经 UserRow：那是任意一段
 * 需求文字，以「【答复】」开头也不当答复卡、不当系统代写（同 ConversationFeed 的 RequirementMessage）。
 */
function UserBubble({ id, author, text, attachments, at, bySystem = false, onReuse }: {
  id: string;
  author: string;
  text: string;
  attachments: readonly string[];
  at?: string;
  bySystem?: boolean;
  /** 放回对话框改了再发，判据同 ConversationFeed 的 UserBubble。 */
  onReuse?: (input: ReusableInput) => void;
}) {
  const parsed = parseAttachmentText(text);
  const displayBody = annotationBatchDisplayText(parsed.body) ?? parsed.body;
  const paths = [...parsed.paths, ...attachments];
  const reusable = !bySystem && displayBody === parsed.body && (!!parsed.body || paths.length > 0);
  return (
    <article className={`team-feed-user${bySystem ? " is-system-authored" : ""}`}>
      <div {...conversationInputAnchor(id)}>
        <header>
          <b>{author}</b>{at && <time>{formatInstant(at)}</time>}
          {onReuse && reusable && <ReuseInputButton onReuse={() => onReuse({ source: id, text: parsed.body, paths })} />}
        </header>
        {displayBody && (bySystem ? <MarkdownBody text={displayBody} /> : <p>{displayBody}</p>)}
        <MessageAttachments paths={paths} />
      </div>
    </article>
  );
}

function InboundRow({
  message,
  worker,
  number,
  at,
  onOpenWorker,
  onAskLead,
  delegating,
}: {
  message: InboundMessage;
  worker?: TaskListItem;
  number: number;
  at?: string;
  onOpenWorker: (taskId: string) => void;
  onAskLead: (worker: TaskListItem) => void | Promise<void>;
  delegating: boolean;
}) {
  const body = message.kind === "question" && worker?.question ? worker.question : message.body;
  return (
    <article className={`team-feed-inbound is-${message.kind}`} title={message.raw}>
      <header>
        <span>{number || "工"}</span>
        {worker ? <button type="button" onClick={() => onOpenWorker(worker.id)}>{worker.title}</button> : <b>{message.title || "系统"}</b>}
        {message.kind !== "note" && <em>· {message.kind === "question" ? "提问，卡住了" : message.kind === "failed" ? "失败了" : "汇报完成"}</em>}
        <ArrowRight size={10} />
        <small>调度者</small>
        {at && <time>{formatInstant(at)}</time>}
      </header>
      <p>{body}</p>
      {message.kind === "question" && worker?.question && (
        <div className="team-question-actions">
          <button
            className="team-question-delegate"
            type="button"
            disabled={delegating}
            title="把问题转给调度者，让它调查后答复"
            onClick={() => void onAskLead(worker)}
          >
            {delegating && <SpinnerGap size={11} className="is-spinning" />}
            {delegating ? "转交中…" : "让调度者答"}
          </button>
          <button className="team-feed-answer" type="button" onClick={() => onOpenWorker(worker.id)}>我来答</button>
        </div>
      )}
    </article>
  );
}

function BatchCard({
  batch,
  allWorkers,
  onOpenWorker,
  indicatorForTask,
}: {
  batch: Batch;
  allWorkers: TaskListItem[];
  onOpenWorker: (taskId: string) => void;
  indicatorForTask: IndicatorForTask;
}) {
  return (
    <article className="team-dispatch-card">
      <header>
        <ArrowElbowDownRight size={12} />
        <b>派活 · {batch.workers.length} 个执行者</b>
        <span>{batch.serial ? "串行" : "并行"}</span>
        {batch.group?.paused && <span>组已停止</span>}
        <time>{formatInstant(batch.at)}</time>
      </header>
      {batch.workers.map((worker) => {
        const indicator = indicatorForTask(worker);
        return (
          <button type="button" key={worker.id} onClick={() => onOpenWorker(worker.id)}>
            {indicator && <TaskStatusDot indicator={indicator} surface="team" />}
            <span className="team-dispatch-index">{allWorkers.findIndex((item) => item.id === worker.id) + 1}</span>
            <b>{worker.title}</b>
            <code title={executorLabel(worker)}>{executorLabel(worker)}</code>
            <small>{workerStatusText(worker, !!batch.group?.paused)}</small>
          </button>
        );
      })}
      <footer>{batch.group?.paused ? "本批执行已停止，已完成结果仍保留" : "点任一行查看完整会话与运行状态"}</footer>
    </article>
  );
}

/* 团队这条流里混着两种行:会话条目和派活卡片。规模与普通任务共用同一张逐字段登记表
   (`conversationItemSize`),派活卡片没有正文、只靠条数和身份推动。
   求和而不是只看最后一行:派活卡片常年压在末尾,前面那条执行者回复还在长。 */
const teamTailKey = (rows: readonly TeamFeedRow[]) => contentVersion(
  rows,
  (row) => row.kind === "conv" ? conversationItemSize(row.item) : 0,
  (row) => row.key,
);

export function TeamFeed({
  task,
  rows,
  workers,
  onOpenWorker,
  onAskLead,
  delegatingIds,
  indicatorForTask,
  historyReady = true,
  onReuseInput,
}: {
  task: Task;
  rows: TeamFeedRow[];
  workers: TaskListItem[];
  onOpenWorker: (taskId: string) => void;
  onAskLead: (worker: TaskListItem) => void | Promise<void>;
  delegatingIds: ReadonlySet<string>;
  indicatorForTask: IndicatorForTask;
  /** 会话正文读完之前算不出「哪些问答还没出现在正文里」，见 ConversationFeed 同名参数。 */
  historyReady?: boolean;
  /** 你发的那几句（含原始需求）放回对话框改了再发；归档了没有对话框就不给。 */
  onReuseInput?: (input: ReusableInput) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const byId = new Map(workers.map((worker) => [worker.id, worker]));
  const wakeReplies = monitorWakeReplyIds(rows.flatMap((row) => row.kind === "conv" ? [row.item] : []));
  // 调度台的原始需求同样不在会话正文里（首条会话从调度者的拆解开始）：流的最顶上拿任务正文
  // 补画第一颗气泡，左侧导航也靠它排出第一格。
  const inputs = useMemo(
    () => conversationInputs({ text: task.body, at: task.createdAt }, rows.flatMap((row) => row.kind === "conv" ? [row.item] : [])),
    [rows, task.body, task.createdAt],
  );
  const hiddenTimes = new Set<string>();
  let previousConversationItem: Extract<TeamFeedRow, { kind: "conv" }>["item"] | null = null;
  for (const row of rows) {
    if (row.kind !== "conv") continue;
    const item = row.item;
    if (
      item.kind === "agent"
      && item.continuation
      && item.at
      && previousConversationItem?.kind === "event"
      && previousConversationItem.variant === "note"
      && previousConversationItem.at === item.at
    ) hiddenTimes.add(item.id);
    previousConversationItem = item;
  }
  // 派活卡片和事件行都不是「消息」:夹在末尾不该把「已收到你的消息」冲掉。
  const activityPhase = runActivityPhase(
    task.status,
    runActivityTail(rows.map((row) => (row.kind === "conv" ? row.item : { kind: "batch" }))),
  );
  return (
    <QuestionHistoryProvider key={task.id} taskId={task.id} history={task.questionHistory} live
      messages={rows.flatMap((row) => row.kind === "conv" && row.item.kind === "user" ? [row.item] : [])}>
    <ImagePreviewGroup isolated>
      <div className="conversation-scroll-region">
        <section className="team-feed" aria-label="团队调度流" ref={scroll}>
          {inputs[0]?.id === REQUIREMENT_INPUT_ID && (
            <UserBubble id={REQUIREMENT_INPUT_ID} author={requirementAuthor(task.creationOrigin)} text={task.body} attachments={[]} at={task.createdAt} onReuse={onReuseInput} />
          )}
          {!rows.length && !activityPhase && <p className="team-feed-empty">运行后，调度者的拆解、派活、执行者提问与汇报会按发生顺序出现在这里。</p>}
          {rows.map((row) => {
            if (row.kind === "batch") return <BatchCard key={row.key} batch={row.batch} allWorkers={workers} onOpenWorker={onOpenWorker} indicatorForTask={indicatorForTask} />;
            const item = row.item;
            // 执行者各有自己的工作目录（团队共享那一档也一样按会话行走），所以按发言
            // 所属的会话取任务，不是一律用调度台。
            if (item.kind === "agent") return <AgentRow key={row.key} row={item} taskId={item.session?.taskId ?? task.id} hideTime={hiddenTimes.has(item.id)} wakeReply={wakeReplies.has(item.id)} />;
            if (item.kind === "user") return <UserRow key={row.key} row={item} onReuse={onReuseInput} />;
            const inbound = parseInbound(item.text);
            if (inbound) {
              return (
                <div key={row.key}>
                  {inbound.map((message, index) => {
                    const worker = message.taskId ? byId.get(message.taskId) : undefined;
                    return (
                      <InboundRow
                        key={index}
                        message={message}
                        worker={worker}
                        number={worker ? workers.indexOf(worker) + 1 : 0}
                        at={item.at}
                        onOpenWorker={onOpenWorker}
                        onAskLead={onAskLead}
                        delegating={!!worker && delegatingIds.has(worker.id)}
                      />
                    );
                  })}
                </div>
              );
            }
            if (item.variant === "boundary") {
              return <SystemBoundary item={item} surface="team" key={row.key} />;
            }
            return <SystemEventNote item={item} key={row.key} />;
          })}
          {historyReady && <QuestionHistoryRemainder />}
          {activityPhase && <RunActivity status={task.status} mode={task.mode} phase={activityPhase} executor={teamLeadLabel(task)} queuePosition={task.queuePosition} />}
        </section>
        <ConversationScrollControls scrollRef={scroll} resetKey={task.id} tailKey={teamTailKey(rows)} inputs={inputs} revealReady={historyReady} />
      </div>
    </ImagePreviewGroup>
    </QuestionHistoryProvider>
  );
}

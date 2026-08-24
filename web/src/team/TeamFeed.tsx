import { useRef } from "react";
import type { Task } from "@ash/shared";
import { runActivityPhase, runActivityTail } from "@ash/shared/run-activity";
import type { Batch } from "@ash/shared/team";
import { ArrowElbowDownRight, ArrowRight, SpinnerGap } from "@phosphor-icons/react";
import { ConversationScrollControls } from "../components/ConversationScrollControls.tsx";
import { AgentRunMeta } from "../components/AgentRunMeta.tsx";
import { ExecutionDetails } from "../components/ExecutionTrace.tsx";
import { ImagePreviewGroup } from "../components/ImagePreview.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { RunActivity } from "../components/RunActivity.tsx";
import { MessageFooter } from "../components/MessageFooter.tsx";
import { TaskStatusDot } from "../components/TaskStatusDot.tsx";
import type { IndicatorForTask } from "../lib/useTaskReadState.ts";
import { MessageAttachments } from "../task-detail/Attachments.tsx";
import { durationBetween, formatInstant, parseAttachmentText } from "../task-detail/utils.ts";
import { executorLabel, parseInbound, teamLeadLabel, workerStatusText, type InboundMessage, type TeamFeedRow } from "./teamModel.ts";

function AgentRow({
  row,
  hideTime,
}: {
  row: Extract<TeamFeedRow, { kind: "conv" }>["item"];
  hideTime?: boolean;
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
      {row.segments.map((segment, index) => (
        <section className="task-agent-segment" key={segment.id}>
          <ExecutionDetails events={segment.events} running={!row.endedAt && index === row.segments.length - 1} />
          <MessageAttachments paths={segment.attachments} />
          {segment.markdown && <MarkdownBody text={segment.markdown} />}
        </section>
      ))}
      <MessageFooter
        turnUsage={row.usage}
        session={row.showSessionMeta ? row.session : null}
        sessionUsage={row.sessionUsage}
        sessionContext={row.sessionContext}
      />
    </article>
  );
}

function UserRow({ row }: { row: Extract<TeamFeedRow, { kind: "conv" }>["item"] }) {
  if (row.kind !== "user") return null;
  const parsed = parseAttachmentText(row.text);
  const paths = [...parsed.paths, ...row.attachments];
  const bySystem = !!row.bySystem;
  return (
    <article className={`team-feed-user${bySystem ? " is-system-authored" : ""}`}>
      <div>
        <header><b>{bySystem ? "系统" : "你"}</b>{row.at && <time>{formatInstant(row.at)}</time>}</header>
        {parsed.body && (bySystem ? <MarkdownBody text={parsed.body} /> : <p>{parsed.body}</p>)}
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
  worker?: Task;
  number: number;
  at?: string;
  onOpenWorker: (taskId: string) => void;
  onAskLead: (worker: Task) => void | Promise<void>;
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
  allWorkers: Task[];
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

export function TeamFeed({
  task,
  rows,
  workers,
  onOpenWorker,
  onAskLead,
  delegatingIds,
  indicatorForTask,
}: {
  task: Task;
  rows: TeamFeedRow[];
  workers: Task[];
  onOpenWorker: (taskId: string) => void;
  onAskLead: (worker: Task) => void | Promise<void>;
  delegatingIds: ReadonlySet<string>;
  indicatorForTask: IndicatorForTask;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const byId = new Map(workers.map((worker) => [worker.id, worker]));
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
    <ImagePreviewGroup isolated>
      <div className="conversation-scroll-region">
        <section className="team-feed" aria-label="团队调度流" ref={scroll}>
          {!rows.length && !activityPhase && <p className="team-feed-empty">运行后，调度者的拆解、派活、执行者提问与汇报会按发生顺序出现在这里。</p>}
          {rows.map((row) => {
            if (row.kind === "batch") return <BatchCard key={row.key} batch={row.batch} allWorkers={workers} onOpenWorker={onOpenWorker} indicatorForTask={indicatorForTask} />;
            const item = row.item;
            if (item.kind === "agent") return <AgentRow key={row.key} row={item} hideTime={hiddenTimes.has(item.id)} />;
            if (item.kind === "user") return <UserRow key={row.key} row={item} />;
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
              return <div className={`team-feed-event${item.tone === "error" ? " is-error" : ""}`} key={row.key}><span />{item.text}<span /></div>;
            }
            return (
              <p className={`conversation-note${item.tone === "error" ? " is-error" : ""}${item.verify ? " is-verify" : ""}`} key={row.key}>
                {item.text}
                {item.at && <time>{formatInstant(item.at)}</time>}
              </p>
            );
          })}
          {activityPhase && <RunActivity status={task.status} mode={task.mode} phase={activityPhase} executor={teamLeadLabel(task)} queuePosition={task.queuePosition} />}
        </section>
        <ConversationScrollControls scrollRef={scroll} resetKey={task.id} />
      </div>
    </ImagePreviewGroup>
  );
}

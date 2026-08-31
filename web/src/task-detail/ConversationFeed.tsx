import { useRef } from "react";
import { Copy, File, ShieldCheck } from "@phosphor-icons/react";
import type { Session, TaskListItem } from "@ash/shared";
import { isTaskLive } from "@ash/shared";
import type { FreeReviewRun } from "@ash/shared";
import { runActivityExecutor, runActivityPhase, runActivityTail } from "@ash/shared/run-activity";
import type { ConversationItem } from "./conversationModel.ts";
import { ConversationScrollControls } from "../components/ConversationScrollControls.tsx";
import { AgentRunMeta } from "../components/AgentRunMeta.tsx";
import { AgentTurnBody } from "../components/AgentTurnBody.tsx";
import { ImagePreviewGroup } from "../components/ImagePreview.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { RunActivity } from "../components/RunActivity.tsx";
import { MessageFooter } from "../components/MessageFooter.tsx";
import { TurnRetryButton } from "../components/TurnRetryButton.tsx";
import { MessageAttachments } from "./Attachments.tsx";
import { conversationFeedRows } from "./conversationReviewLanes.ts";
import { ReviewerLane } from "./ReviewerLane.tsx";
import { type TurnRetryTarget, turnRetryTarget } from "./turnRetry.ts";
import { durationBetween, formatInstant, parseAttachmentText } from "./utils.ts";

function copyText(text: string) {
  void navigator.clipboard.writeText(text);
}

// 审查者的身份标：这一回合不是在做需求，是在验收刚才的产物。就地验证跑在被验任务
// 自己的会话里（常常还是同一个执行器），不标出来的话它跟上一条实现回合长得一模一样。
function ReviewerBadge({ round }: { round: number | null }) {
  return (
    <span className="verify-badge">
      <ShieldCheck size={11} weight="fill" aria-hidden="true" />
      审查者{round ? ` · 第 ${round} 轮` : ""}
    </span>
  );
}

function AgentMessage({
  item,
  taskLive,
  retry,
  hideTime,
}: {
  item: Extract<ConversationItem, { kind: "agent" }>;
  /** 整个任务还在跑：过程折叠块在跑的中途不自动收起。 */
  taskLive: boolean;
  /** 这条气泡是不是「上一回合崩了」的那一条：给了就在尾栏挂重试按钮。 */
  retry?: React.ReactNode;
  /** 紧邻的旁注已经显示了同一个时间。 */
  hideTime?: boolean;
}) {
  const duration = durationBetween(item.at, item.endedAt);
  const reviewer = item.reviewer;
  const compactContinuation = !!item.continuation && !!hideTime && !duration;
  const footerActions = compactContinuation ? (
    <>
      <button className="task-message-copy-action" type="button" onClick={() => copyText(item.markdown)} aria-label="复制这条回复">
        <Copy size={12} aria-hidden="true" />
        复制这条回复
      </button>
      {retry}
    </>
  ) : retry;
  return (
    <article
      className={`task-message task-message--agent${item.continuation ? " is-continuation" : ""}${reviewer ? " is-reviewer" : ""}`}
    >
      <span className="task-message-avatar" aria-hidden="true">
        {item.continuation ? "" : reviewer ? <ShieldCheck size={13} weight="fill" /> : item.label.slice(0, 1).toUpperCase()}
      </span>
      <div className="task-message-content">
        {!compactContinuation && (
          <header>
            {!item.continuation && (
              <span className="agent-run-identity">
                <b>{item.label}</b>
                <AgentRunMeta run={item.run} />
              </span>
            )}
            {reviewer && !item.continuation && <ReviewerBadge round={reviewer.round} />}
            {!hideTime && item.at && <time>{formatInstant(item.at)}</time>}
            {duration && (
              <small className="task-turn-duration" title={`开始 ${formatInstant(item.at)} · 结束 ${formatInstant(item.endedAt)}`}>
                {item.continuation ? "" : "· "}⏱ {duration} 用时
              </small>
            )}
            <button type="button" onClick={() => copyText(item.markdown)} aria-label="复制这条回复">
              <Copy size={13} aria-hidden="true" />
            </button>
          </header>
        )}
        <AgentTurnBody segments={item.segments} running={!item.endedAt} taskLive={taskLive} />
        {/* 账目一律在尾栏，头部不放。位置不许随「是不是会话最后一条」变——
            那样同一个数会在气泡顶和气泡底之间跳，而这条规则用户看不见。 */}
        <MessageFooter
          turnUsage={item.usage}
          session={item.showSessionMeta ? item.session : null}
          sessionUsage={item.sessionUsage}
          sessionContext={item.sessionContext}
          actions={footerActions}
        />
      </div>
    </article>
  );
}

function UserMessage({
  item,
}: {
  item: Extract<ConversationItem, { kind: "user" }>;
}) {
  const parsed = parseAttachmentText(item.text);
  const paths = [...parsed.paths, ...item.attachments];
  const bySystem = !!item.bySystem;
  return (
    <article className={`task-message task-message--user${bySystem ? " is-system-authored" : ""}`}>
      <div className="task-user-bubble">
        <header>
          <b>{bySystem ? "系统" : "你"}</b>
          {item.at && <time>{formatInstant(item.at)}</time>}
          {parsed.body && (
            <button type="button" onClick={() => copyText(parsed.body)} aria-label="复制这条回复">
              <Copy size={13} aria-hidden="true" />
            </button>
          )}
        </header>
        {parsed.body && (bySystem ? <MarkdownBody text={parsed.body} /> : <p>{parsed.body}</p>)}
        <MessageAttachments paths={paths} />
      </div>
    </article>
  );
}

export function ConversationFeed({
  task,
  items,
  sessions,
  pendingExecutor,
  loading,
  error,
  footer,
  onRetryTurn,
  reviewRetryable,
  reviews,
}: {
  task: TaskListItem;
  items: ConversationItem[];
  sessions: Session[];
  /** 刚发出去、服务端还没落下会话行的那一回合目标(见 runActivityExecutor)。 */
  pendingExecutor?: string | null;
  loading: boolean;
  error: Error | null;
  footer?: React.ReactNode;
  /** 重跑上一回合。不给就不出重试按钮（只读的会话视图用得上）。 */
  onRetryTurn?: (target: TurnRetryTarget) => Promise<void> | void;
  /** 自由工作流的审查链停在「异常结束」——只有它为真，审查会话上才出重跑按钮。 */
  reviewRetryable?: boolean;
  /** 自由派审的落盘记录：折叠卡靠它反查报告的 runId（旁注里只有轮号）。 */
  reviews?: readonly FreeReviewRun[] | null;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const activityPhase = runActivityPhase(task.status, runActivityTail(items));
  const activityExecutor = runActivityExecutor({
    sessions,
    pending: pendingExecutor,
    fallback: task.executorLabel ?? task.agentType,
  });
  // 崩掉的那一回合挂在会话最后一条 agent 气泡上；不满足条件时是 null，一颗按钮都不出。
  const retry = onRetryTurn ? turnRetryTarget(task, items, { reviewRetryable }) : null;
  const retryItemId = retry
    ? [...items].reverse().find((item) => item.kind === "agent")?.id ?? null
    : null;
  const rows = conversationFeedRows(items, { reviews });
  const hiddenTimes = new Set<string>();
  for (let index = 1; index < items.length; index += 1) {
    const item = items[index]!;
    const previous = items[index - 1]!;
    if (
      item.kind === "agent"
      && item.continuation
      && item.at
      && previous.kind === "event"
      && previous.variant === "note"
      && previous.at === item.at
    ) hiddenTimes.add(item.id);
  }

  const renderItem = (item: ConversationItem) => {
    if (item.kind === "agent") {
      return (
        <AgentMessage
          key={item.id}
          item={item}
          taskLive={isTaskLive(task.status)}
          hideTime={hiddenTimes.has(item.id)}
          retry={retry && item.id === retryItemId ? (
            <TurnRetryButton
              exitStatus={retry.exitStatus}
              kind={retry.kind}
              onRetry={() => onRetryTurn!(retry)}
            />
          ) : undefined}
        />
      );
    }
    if (item.kind === "user") return <UserMessage key={item.id} item={item} />;
    // 回合边界才配得上一条横贯的分隔线；系统旁注只是贴在会话边上的一行小字，
    // 它不该看起来像「这里换了一段对话」。
    if (item.variant === "boundary") {
      return (
        <div className={`task-event-line${item.tone === "error" ? " is-error" : ""}`} key={item.id}>
          <span />
          <p>{item.text}{item.at ? ` · ${formatInstant(item.at)}` : ""}</p>
          <span />
        </div>
      );
    }
    return (
      <p
        className={`conversation-note${item.tone === "error" ? " is-error" : ""}${item.verify ? " is-verify" : ""}`}
        key={item.id}
      >
        {item.text}
        {item.at && <time>{formatInstant(item.at)}</time>}
      </p>
    );
  };

  return (
    <ImagePreviewGroup isolated>
      <div className="conversation-scroll-region task-conversation-wrap">
        <div className="task-conversation" ref={scroll}>
          {rows.map((row) => row.kind === "item"
            ? renderItem(row.item)
            : (
              <ReviewerLane key={row.id} taskId={task.id} lane={row}>
                {row.items.map(renderItem)}
              </ReviewerLane>
            ))}
          {activityPhase && !loading && !error && (
            <RunActivity
              status={task.status}
              mode={task.mode}
              phase={activityPhase}
              executor={activityExecutor}
              queuePosition={task.queuePosition}
            />
          )}
          {!items.length && !loading && !error && !activityPhase && (
            <div className="task-conversation-empty">
              <File size={20} aria-hidden="true" />
              <p>点击「运行」开始，执行输出会实时显示在这里。</p>
            </div>
          )}
          {loading && !items.length && <p className="task-conversation-note">正在读取会话…</p>}
          {error && <p className="task-conversation-error">{error.message}</p>}
          {footer}
        </div>
        <ConversationScrollControls scrollRef={scroll} resetKey={task.id} />
      </div>
    </ImagePreviewGroup>
  );
}

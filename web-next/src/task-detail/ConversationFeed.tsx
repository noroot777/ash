import { useRef } from "react";
import { Copy, File } from "@phosphor-icons/react";
import type { Session, Task } from "@harness/shared";
import { runActivityExecutor, runActivityPhase, runActivityTail } from "@harness/shared/run-activity";
import type { ConversationItem } from "./conversationModel.ts";
import { ConversationScrollControls } from "../components/ConversationScrollControls.tsx";
import { AgentRunMeta } from "../components/AgentRunMeta.tsx";
import { ExecutionDetails } from "../components/ExecutionTrace.tsx";
import { ImagePreviewGroup } from "../components/ImagePreview.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { RunActivity } from "../components/RunActivity.tsx";
import { MessageFooter } from "../components/MessageFooter.tsx";
import { MessageAttachments } from "./Attachments.tsx";
import { durationBetween, formatInstant, parseAttachmentText } from "./utils.ts";

function copyText(text: string) {
  void navigator.clipboard.writeText(text);
}

function AgentMessage({
  item,
}: {
  item: Extract<ConversationItem, { kind: "agent" }>;
}) {
  const duration = durationBetween(item.at, item.endedAt);
  return (
    <article className="task-message task-message--agent">
      <span className="task-message-avatar" aria-hidden="true">{item.label.slice(0, 1).toUpperCase()}</span>
      <div className="task-message-content">
        <header>
          <span className="agent-run-identity">
            <b>{item.label}</b>
            <AgentRunMeta run={item.run} />
          </span>
          {item.at && <time>{formatInstant(item.at)}</time>}
          {duration && (
            <small className="task-turn-duration" title={`开始 ${formatInstant(item.at)} · 结束 ${formatInstant(item.endedAt)}`}>
              · ⏱ {duration} 用时
            </small>
          )}
          <button type="button" onClick={() => copyText(item.markdown)} aria-label="复制这条回复">
            <Copy size={13} aria-hidden="true" />
          </button>
        </header>
        {item.segments.map((segment, index) => (
          <section className="task-agent-segment" key={segment.id}>
            <ExecutionDetails events={segment.events} running={!item.endedAt && index === item.segments.length - 1} />
            <MessageAttachments paths={segment.attachments} />
            {segment.markdown && <MarkdownBody text={segment.markdown} />}
          </section>
        ))}
        {/* 账目一律在尾栏，头部不放。位置不许随「是不是会话最后一条」变——
            那样同一个数会在气泡顶和气泡底之间跳，而这条规则用户看不见。 */}
        <MessageFooter
          turnUsage={item.usage}
          session={item.showSessionMeta ? item.session : null}
          sessionUsage={item.sessionUsage}
          sessionContext={item.sessionContext}
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
}: {
  task: Task;
  items: ConversationItem[];
  sessions: Session[];
  /** 刚发出去、服务端还没落下会话行的那一回合目标(见 runActivityExecutor)。 */
  pendingExecutor?: string | null;
  loading: boolean;
  error: Error | null;
  footer?: React.ReactNode;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const activityPhase = runActivityPhase(task.status, runActivityTail(items));
  const activityExecutor = runActivityExecutor({
    sessions,
    pending: pendingExecutor,
    fallback: task.executorLabel ?? task.agentType,
  });

  return (
    <ImagePreviewGroup isolated>
      <div className="conversation-scroll-region task-conversation-wrap">
        <div className="task-conversation" ref={scroll}>
          {items.map((item) => {
            if (item.kind === "agent") return <AgentMessage key={item.id} item={item} />;
            if (item.kind === "user") return <UserMessage key={item.id} item={item} />;
            return (
              <div className={`task-event-line${item.tone === "error" ? " is-error" : ""}`} key={item.id}>
                <span />
                <p>{item.text}{item.at ? ` · ${formatInstant(item.at)}` : ""}</p>
                <span />
              </div>
            );
          })}
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

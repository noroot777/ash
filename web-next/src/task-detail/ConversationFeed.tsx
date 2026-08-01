import { useRef } from "react";
import { CaretRight, Copy, File, Wrench, X } from "@phosphor-icons/react";
import type { AgentAuxEvent, ConversationItem } from "./conversationModel.ts";
import { ConversationScrollControls } from "../components/ConversationScrollControls.tsx";
import { ImagePreviewGroup } from "../components/ImagePreview.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { SessionMeta } from "../components/SessionMeta.tsx";
import { MessageAttachments } from "./Attachments.tsx";
import { durationBetween, formatInstant, parseAttachmentText } from "./utils.ts";

function copyText(text: string) {
  void navigator.clipboard.writeText(text);
}

function ExecutionDetails({ events, running }: { events: AgentAuxEvent[]; running: boolean }) {
  if (!events.length) return null;
  const thinking = events.filter((event) => event.kind === "thinking").length;
  const tools = events.filter((event) => event.kind === "tool").length;
  const errors = events.filter((event) => event.kind === "error").length;
  const counts = [
    thinking ? `${thinking} 次分析` : "",
    tools ? `${tools} 次工具` : "",
    errors ? `${errors} 个异常` : "",
  ].filter(Boolean).join(" · ");

  return (
    <details className={`task-execution-block${errors ? " has-error" : ""}`}>
      <summary>
        <CaretRight className="task-execution-caret" size={11} weight="bold" aria-hidden="true" />
        {running && <span className="task-execution-pulse" aria-hidden="true" />}
        <span className="task-execution-title">执行过程</span>
        <small>{counts || `${events.length} 个步骤`}</small>
      </summary>
      <div className="task-execution-events">
        {events.map((event, index) => (
          <details className={`task-tool-line task-tool-line--${event.kind}`} key={`${event.kind}:${index}`}>
            <summary>
              {event.kind === "tool" ? <Wrench size={12} /> : event.kind === "error" ? <X size={12} /> : <span>◌</span>}
              <span>{event.label}</span>
            </summary>
            {event.detail && <pre>{event.detail}</pre>}
          </details>
        ))}
      </div>
    </details>
  );
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
          <b>{item.label}</b>
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
        {item.markdown && <MarkdownBody text={item.markdown} />}
        <ExecutionDetails events={item.events} running={!item.endedAt} />
        {item.showSessionMeta && item.session && <SessionMeta session={item.session} />}
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
  return (
    <article className="task-message task-message--user">
      <div className="task-user-bubble">
        <header>
          <b>你</b>
          {item.at && <time>{formatInstant(item.at)}</time>}
          {parsed.body && (
            <button type="button" onClick={() => copyText(parsed.body)} aria-label="复制这条回复">
              <Copy size={13} aria-hidden="true" />
            </button>
          )}
        </header>
        {parsed.body && <p>{parsed.body}</p>}
        <MessageAttachments paths={paths} />
      </div>
    </article>
  );
}

export function ConversationFeed({
  taskId,
  taskBody,
  items,
  loading,
  error,
  footer,
}: {
  taskId: string;
  taskBody: string;
  items: ConversationItem[];
  loading: boolean;
  error: Error | null;
  footer?: React.ReactNode;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const objective = parseAttachmentText(taskBody);

  return (
    <ImagePreviewGroup isolated>
      <div className="conversation-scroll-region task-conversation-wrap">
        <div className="task-conversation" ref={scroll}>
          {taskBody.trim() && (
            <details className="task-objective" open={items.length === 0}>
              <summary>任务目标</summary>
              <MarkdownBody text={objective.body} />
              <MessageAttachments paths={objective.paths} />
            </details>
          )}
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
          {!items.length && !loading && !error && (
            <div className="task-conversation-empty">
              <File size={20} aria-hidden="true" />
              <p>点击「运行」开始，执行输出会实时显示在这里。</p>
            </div>
          )}
          {loading && !items.length && <p className="task-conversation-note">正在读取会话…</p>}
          {error && <p className="task-conversation-error">{error.message}</p>}
          {footer}
        </div>
        <ConversationScrollControls scrollRef={scroll} resetKey={taskId} />
      </div>
    </ImagePreviewGroup>
  );
}

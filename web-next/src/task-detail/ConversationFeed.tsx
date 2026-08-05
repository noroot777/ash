import { useEffect, useRef, useState } from "react";
import { CaretRight, Copy, File, Wrench, X } from "@phosphor-icons/react";
import type { Task } from "@harness/shared";
import { runActivityPhase, type RunActivityTail } from "@harness/shared/run-activity";
import type { AgentAuxEvent, ConversationItem } from "./conversationModel.ts";
import { ConversationScrollControls } from "../components/ConversationScrollControls.tsx";
import { ImagePreviewGroup } from "../components/ImagePreview.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { RunActivity } from "../components/RunActivity.tsx";
import { SessionMeta } from "../components/SessionMeta.tsx";
import { MessageAttachments } from "./Attachments.tsx";
import { durationBetween, formatInstant, parseAttachmentText } from "./utils.ts";

function copyText(text: string) {
  void navigator.clipboard.writeText(text);
}

function compact(text: string, limit = 52): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function eventPreview(event: AgentAuxEvent): string {
  if (event.kind === "error") return compact(`异常 · ${event.label}`);
  if (event.kind === "thinking") return compact(`分析 · ${event.detail || event.label}`);
  return compact(`${event.label}${event.detail ? ` · ${event.detail}` : ""}`);
}

function textSwapDuration(): number {
  if (typeof document === "undefined") return 150;
  return parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--text-swap-dur"),
  ) || 150;
}

function TransientExecutionLabel({
  baseLabel,
  events,
  running,
}: {
  baseLabel: string;
  events: AgentAuxEvent[];
  running: boolean;
}) {
  const label = useRef<HTMLSpanElement>(null);
  const previousCount = useRef(running ? 0 : events.length);
  const [display, setDisplay] = useState(baseLabel);
  const [phase, setPhase] = useState("");
  const latestPreview = events.length ? eventPreview(events.at(-1)!) : "";

  useEffect(() => {
    if (!running) {
      previousCount.current = events.length;
      setDisplay(baseLabel);
      setPhase("");
      return;
    }
    if (events.length <= previousCount.current) return;
    previousCount.current = events.length;
    if (!latestPreview) return;

    const timers: number[] = [];
    const frames: number[] = [];
    const swapText = (next: string, settled?: () => void) => {
      setPhase("is-exit");
      timers.push(window.setTimeout(() => {
        setDisplay(next);
        setPhase("is-enter-start");
        frames.push(window.requestAnimationFrame(() => {
          if (label.current) void label.current.offsetHeight;
          setPhase("");
          settled?.();
        }));
      }, textSwapDuration()));
    };
    swapText(latestPreview, () => {
      timers.push(window.setTimeout(() => swapText(baseLabel), 3_600));
    });
    return () => {
      timers.forEach(window.clearTimeout);
      frames.forEach(window.cancelAnimationFrame);
    };
  }, [baseLabel, events.length, latestPreview, running]);

  return (
    <span
      className={`task-execution-label t-text-swap ${phase}${running ? " t-shimmer" : ""}`}
      data-text={running ? display : undefined}
      aria-label={running ? display : undefined}
      ref={label}
    >
      {display}
    </span>
  );
}

export function ExecutionDetails({ events, running }: { events: AgentAuxEvent[]; running: boolean }) {
  if (!events.length) return null;
  const thinking = events.filter((event) => event.kind === "thinking").length;
  const tools = events.filter((event) => event.kind === "tool").length;
  const errors = events.filter((event) => event.kind === "error").length;
  const counts = [
    thinking ? `${thinking} 分析` : "",
    tools ? `${tools} 工具` : "",
    errors ? `${errors} 异常` : "",
  ].filter(Boolean).join(" · ");
  const baseLabel = `执行过程${counts ? ` · ${counts}` : ""}`;

  return (
    <details className={`task-execution-block${errors ? " has-error" : ""}`}>
      <summary>
        <CaretRight className="task-execution-caret" size={11} weight="bold" aria-hidden="true" />
        {running && <span className="task-execution-pulse" aria-hidden="true" />}
        <TransientExecutionLabel baseLabel={baseLabel} events={events} running={running} />
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
        {item.segments.map((segment, index) => (
          <section className="task-agent-segment" key={segment.id}>
            <ExecutionDetails events={segment.events} running={!item.endedAt && index === item.segments.length - 1} />
            {segment.markdown && <MarkdownBody text={segment.markdown} />}
          </section>
        ))}
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
  task,
  items,
  loading,
  error,
  footer,
}: {
  task: Task;
  items: ConversationItem[];
  loading: boolean;
  error: Error | null;
  footer?: React.ReactNode;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const last = items.at(-1);
  const tail: RunActivityTail = !last
    ? "empty"
    : last.kind === "user"
      ? "user"
      : last.kind === "agent"
        ? last.endedAt ? "agent-ended" : "agent-active"
        : "other";
  const activityPhase = runActivityPhase(task.status, tail);

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
              executor={task.executorLabel?.trim() || task.agentType}
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

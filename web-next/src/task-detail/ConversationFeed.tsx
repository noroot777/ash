import { useEffect, useRef, useState } from "react";
import { ArrowDown, Copy, File, Wrench, X } from "@phosphor-icons/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ConversationItem } from "./conversationModel.ts";
import { useStickToBottom } from "../lib/useStickToBottom.ts";
import { MessageAttachments } from "./Attachments.tsx";
import { formatInstant, parseAttachmentText } from "./utils.ts";

function copyText(text: string) {
  void navigator.clipboard.writeText(text);
}

function MarkdownBody({
  text,
  onPreview,
}: {
  text: string;
  onPreview: (url: string, name: string) => void;
}) {
  return (
    <div className="task-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
          img: ({ src, alt }) => {
            const url = typeof src === "string" ? src : "";
            return (
              <button className="task-markdown-image" type="button" onClick={() => onPreview(url, alt ?? "图片")}>
                <img src={url} alt={alt ?? ""} />
              </button>
            );
          },
          pre: ({ children }) => <pre className="task-code-block">{children}</pre>,
          code: ({ children, className }) => <code className={className}>{children}</code>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function AgentMessage({
  item,
  onPreview,
}: {
  item: Extract<ConversationItem, { kind: "agent" }>;
  onPreview: (url: string, name: string) => void;
}) {
  return (
    <article className="task-message task-message--agent">
      <span className="task-message-avatar" aria-hidden="true">{item.label.slice(0, 1).toUpperCase()}</span>
      <div className="task-message-content">
        <header>
          <b>{item.label}</b>
          {item.at && <time>{formatInstant(item.at)}</time>}
          <button type="button" onClick={() => copyText(item.markdown)} aria-label="复制这条回复">
            <Copy size={13} aria-hidden="true" />
          </button>
        </header>
        {item.markdown && <MarkdownBody text={item.markdown} onPreview={onPreview} />}
        {item.events.map((event, index) => (
          <details className={`task-tool-line task-tool-line--${event.kind}`} key={`${event.kind}:${index}`}>
            <summary>
              {event.kind === "tool" ? <Wrench size={12} /> : event.kind === "error" ? <X size={12} /> : <span>◌</span>}
              <span>{event.label}</span>
            </summary>
            {event.detail && <pre>{event.detail}</pre>}
          </details>
        ))}
      </div>
    </article>
  );
}

function UserMessage({
  item,
  onPreview,
}: {
  item: Extract<ConversationItem, { kind: "user" }>;
  onPreview: (url: string, name: string) => void;
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
        <MessageAttachments paths={paths} onPreview={onPreview} />
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
  const { resume } = useStickToBottom(scroll, taskId);
  const [atBottom, setAtBottom] = useState(true);
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);

  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const update = () => setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight <= 80);
    element.addEventListener("scroll", update, { passive: true });
    update();
    return () => element.removeEventListener("scroll", update);
  }, [taskId]);

  return (
    <div className="task-conversation-wrap">
      <div className="task-conversation" ref={scroll}>
        {taskBody.trim() && (
          <details className="task-objective" open={items.length === 0}>
            <summary>任务目标</summary>
            <MarkdownBody text={parseAttachmentText(taskBody).body} onPreview={(url, name) => setPreview({ url, name })} />
            <MessageAttachments paths={parseAttachmentText(taskBody).paths} onPreview={(url, name) => setPreview({ url, name })} />
          </details>
        )}
        {items.map((item) => {
          if (item.kind === "agent") return <AgentMessage key={item.id} item={item} onPreview={(url, name) => setPreview({ url, name })} />;
          if (item.kind === "user") return <UserMessage key={item.id} item={item} onPreview={(url, name) => setPreview({ url, name })} />;
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
      {!atBottom && (
        <button
          className="task-scroll-bottom"
          type="button"
          onClick={() => {
            resume();
            scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" });
          }}
          aria-label="滚动到会话底部"
        >
          <ArrowDown size={15} weight="bold" aria-hidden="true" />
        </button>
      )}
      {preview && (
        <div className="task-image-lightbox" role="dialog" aria-modal="true" aria-label={preview.name} onClick={() => setPreview(null)}>
          <button type="button" onClick={() => setPreview(null)} aria-label="关闭图片预览"><X size={18} /></button>
          <img src={preview.url} alt={preview.name} onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </div>
  );
}

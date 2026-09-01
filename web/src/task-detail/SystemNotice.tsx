import { ArrowClockwise, CheckCircle, Clock, Info, WarningCircle } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { MessageAttachments } from "./Attachments.tsx";
import type { ConversationItem } from "./conversationModel.ts";
import { formatInstant, parseAttachmentText } from "./utils.ts";
import {
  conflictFiles,
  isConflictHandoff,
  systemEventKind,
  systemPromptBody,
  systemPromptSummary,
  systemPromptTitle,
  type SystemEventKind,
} from "./systemNoticeModel.ts";

type EventLike = Pick<Extract<ConversationItem, { kind: "event" }>, "text" | "at" | "tone" | "verify">;

function eventIcon(kind: SystemEventKind): ReactNode {
  if (kind === "recovery") return <ArrowClockwise size={11} weight="bold" />;
  if (kind === "success") return <CheckCircle size={11} weight="fill" />;
  if (kind === "progress") return <Clock size={11} weight="fill" />;
  if (kind === "error" || kind === "warning" || kind === "notice") return <WarningCircle size={11} weight="fill" />;
  return <Info size={11} weight="fill" />;
}

export function SystemEventNote({ item }: { item: EventLike }) {
  const kind = systemEventKind(item.text, item.tone);
  const recovery = kind === "recovery";
  return (
    <div
      className={`conversation-note system-event-row is-${kind}${item.verify ? " is-verify" : ""}${recovery ? " system-recovery-row" : ""}`}
      role={kind === "error" || kind === "warning" || kind === "notice" ? "status" : undefined}
    >
      <span className="system-event-icon" aria-hidden="true">{eventIcon(kind)}</span>
      <p>
        {recovery && <b>工作区已恢复</b>}
        {recovery ? "原目录已不存在，系统已重建空工作区；会话与用户消息均已保留。" : item.text.replace(/^〔系统〕/, "").trim()}
      </p>
      {item.at && <time>{formatInstant(item.at)}</time>}
    </div>
  );
}

export function SystemBoundary({ item, surface = "task" }: { item: EventLike; surface?: "task" | "team" }) {
  return (
    <div className={`${surface === "team" ? "team-feed-event" : "task-event-line"} system-boundary${item.tone === "error" ? " is-error" : ""}`}>
      <span />
      <p>{item.text}{item.at ? ` · ${formatInstant(item.at)}` : ""}</p>
      <span />
    </div>
  );
}

type SystemMessageProps = {
  item: Extract<ConversationItem, { kind: "user" }>;
  related?: Array<Extract<ConversationItem, { kind: "event" }>>;
  surface?: "task" | "team";
};

export function SystemAuthoredMessage({ item, related = [], surface = "task" }: SystemMessageProps) {
  const parsed = parseAttachmentText(item.text);
  const paths = [...parsed.paths, ...item.attachments];
  const text = parsed.body || item.text;
  const conflict = isConflictHandoff(text);
  const files = conflict ? conflictFiles(text) : [];
  const title = conflict ? "验收遇到冲突" : systemPromptTitle(text);
  const summary = conflict
    ? "合并已安全回滚，目标分支未改动；请在任务分支解决冲突后重新验收。"
    : systemPromptSummary(text);
  const raw = systemPromptBody(text);
  const outer = surface === "team" ? "team-feed-user" : "task-message task-message--user";
  return (
    <article className={`${outer} is-system-authored system-action-wrap`}>
      <section className={`system-action-note${conflict ? " is-conflict" : ""}`} aria-label={title}>
        <span className="system-action-icon" aria-hidden="true">
          {conflict ? <WarningCircle size={12} weight="fill" /> : <Info size={12} weight="fill" />}
        </span>
        <div className="system-action-main">
          <div className="system-action-line">
            <p><b>{title}</b>{summary && <span> · {summary}</span>}</p>
            {item.at && <time>{formatInstant(item.at)}</time>}
          </div>
          <div className="system-action-meta">
            {!!files.length && <span>{files.length} 个冲突文件</span>}
            <details className="system-action-details">
              <summary>{conflict ? "查看处理步骤" : "查看完整内容"}</summary>
              <div>
                {!!files.length && (
                  <ul className="system-action-files" aria-label="冲突文件">
                    {files.map((file) => <li key={file}><code>{file}</code></li>)}
                  </ul>
                )}
                <MarkdownBody text={raw} />
              </div>
            </details>
            {related.length > 0 && (
              <details className="system-action-related">
                <summary>流程记录 {related.length} 条</summary>
                <ol>{related.map((event) => <li key={event.id}>{event.text}{event.at ? <time>{formatInstant(event.at)}</time> : null}</li>)}</ol>
              </details>
            )}
          </div>
          <MessageAttachments paths={paths} />
        </div>
      </section>
    </article>
  );
}

import { Info, WarningCircle } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { openGitWorkbench } from "../git-workbench/navigation.ts";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { previewNoticeText } from "../lib/previewUrl.ts";
import { MessageAttachments } from "./Attachments.tsx";
import { FootnoteLine } from "./FootnoteLine.tsx";
import { MonitorWakeInput } from "./MonitorWakeInput.tsx";
import { monitorWakeInput } from "./monitorWakeModel.ts";
import type { ConversationItem } from "./conversationModel.ts";
import { DeleteMessageButton } from "./MessageDelete.tsx";
import { formatInstant, parseAttachmentText } from "./utils.ts";
import { conflictFiles, isConflictHandoff, systemPromptBody, systemPromptSummary, systemPromptTitle } from "./systemNoticeModel.ts";
import { isPreviewLifecycleNotice, noticeView, type NoticeView } from "./timelineNoticeCopy.ts";
import { noticeTail } from "./turnFootnote.ts";

type EventItem = Extract<ConversationItem, { kind: "event" }>;
type EventLike = Pick<EventItem, "id" | "text" | "at" | "tone" | "variant" | "notice" | "sources">;

/**
 * 你那条斜杠命令的回答（/goal --scopes 一类）：是你要看的东西，在原处常显、原样分行，左缘跟
 * 正文对齐。是哪条命令、什么时候答的，指到再看。
 */
export function CommandReply({ item, view }: { item: EventLike; view: NoticeView }) {
  const tail = noticeTail(view, item.at);
  return (
    <div className="command-reply">
      <p className="command-reply-text" data-selection-content="">{view.text}</p>
      {tail && <time className="turn-footnote-tail">{tail}</time>}
      <DeleteMessageButton item={item} />
    </div>
  );
}

/**
 * 一条时间线旁注单独摆成一句（团队时间线上用：那里没有回合尾注可归、也没有「N 条记录」，
 * 所以删除留在这一句上）。长相跟任务会话里的尾注同一种小灰字。
 */
export function SystemEventNote({ item, action }: { item: EventLike; action?: ReactNode }) {
  if (isPreviewLifecycleNotice(item.text)) return null;
  const view = noticeView(item);
  if (view.tier === "reply") return <CommandReply item={item} view={view} />;
  return (
    <FootnoteLine
      placement="standalone"
      footnote={{ id: item.id, live: false, parts: [{ kind: "event", id: item.id, at: item.at, view }] }}
      actionFor={action ? () => action : undefined}
      deletable={item}
    />
  );
}

/** 团队时间线上的回合边界：一条很淡的分隔线和一句说明。 */
export function SystemBoundary({ item, surface = "task" }: { item: Omit<EventLike, "id">; surface?: "task" | "team" }) {
  return (
    <div className={`${surface === "team" ? "team-feed-event" : "task-event-line"} system-boundary${item.tone === "error" ? " is-error" : ""}`}>
      <span className="system-boundary-rule" aria-hidden="true" />
      <p>{previewNoticeText(item.text)}{item.at ? ` · ${formatInstant(item.at)}` : ""}</p>
      <DeleteMessageButton item={item} />
      <span className="system-boundary-rule" aria-hidden="true" />
    </div>
  );
}

type SystemMessageProps = {
  item: Extract<ConversationItem, { kind: "user" }>;
  related?: EventItem[];
  surface?: "task" | "team";
};

/** 后端代写、占着真人回合的那几种指令（验收冲突交接等）。 */
export function SystemAuthoredMessage({ item, related = [], surface = "task" }: SystemMessageProps) {
  const wakeInput = monitorWakeInput(item);
  if (wakeInput) return <MonitorWakeInput item={item} input={wakeInput} surface={surface} />;
  const parsed = parseAttachmentText(item.text);
  const paths = [...parsed.paths, ...item.attachments];
  const text = parsed.body || item.text;
  const conflict = isConflictHandoff(text);
  const location = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  const projectId = location.get("project");
  const taskId = location.get("task");
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
            <DeleteMessageButton item={item} />
          </div>
          <div className="system-action-meta">
            {conflict && projectId && taskId && <button type="button" onClick={() => openGitWorkbench({ projectId, taskId, view: "branches" })}>打开 Git 工作台处理</button>}
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
                <ol>{related.map((event) => <li key={event.id}>{previewNoticeText(event.text)}{event.at ? <time>{formatInstant(event.at)}</time> : null}</li>)}</ol>
              </details>
            )}
          </div>
          <MessageAttachments paths={paths} />
        </div>
      </section>
    </article>
  );
}

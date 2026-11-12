import { ArrowClockwise, CheckCircle, Info, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import { useId, useState, type ReactNode } from "react";
import { openGitWorkbench } from "../git-workbench/navigation.ts";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { previewNoticeText } from "../lib/previewUrl.ts";
import { MessageAttachments } from "./Attachments.tsx";
import { MonitorWakeInput } from "./MonitorWakeInput.tsx";
import { monitorWakeInput } from "./monitorWakeModel.ts";
import type { ConversationItem } from "./conversationModel.ts";
import { DeleteMessageButton } from "./MessageDelete.tsx";
import { formatInstant, parseAttachmentText } from "./utils.ts";
import { conflictFiles, isConflictHandoff, systemPromptBody, systemPromptSummary, systemPromptTitle } from "./systemNoticeModel.ts";
import { noticeView, type NoticeGlyph, type NoticeView } from "./timelineNoticeCopy.ts";

type EventItem = Extract<ConversationItem, { kind: "event" }>;
type EventLike = Pick<EventItem, "text" | "at" | "tone" | "variant" | "notice" | "sources">;

export function NoticeIcon({ glyph }: { glyph: NoticeGlyph }) {
  if (glyph === "review") return <ShieldCheck size={14} weight="fill" />;
  if (glyph === "check") return <CheckCircle size={14} weight="fill" />;
  if (glyph === "recovery") return <ArrowClockwise size={14} weight="bold" />;
  if (glyph === "warn") return <WarningCircle size={14} weight="fill" />;
  return <Info size={14} weight="fill" />;
}

/**
 * 会话里常显的那一行：里程碑（审查出了结论、验收了），或者出了岔子 / 要你拍板的。
 *
 * 一行一句，图标落在头像轴上，颜色只在图标上，结论写在字里。`tail`（谁审的、用时、时刻）
 * 紧跟在字后面，指到这一行才显示，触屏上常显。整行是一颗键：给了 `onOpen` 就去那儿
 * （审查轮去右侧「审查」格），否则有原文细节时就地摊开它。
 */
export function NoticeLine({
  view,
  tail,
  onOpen,
  openLabel,
  action,
  deletable,
  live = false,
}: {
  view: Pick<NoticeView, "tier" | "tone" | "glyph" | "text" | "detail">;
  tail?: string | null;
  onOpen?: () => void;
  /** onOpen 去哪儿，读屏用（「在审查格里打开第 3 轮」）。 */
  openLabel?: string;
  /** 「去裁定」这一类：摆在这一行最后，不跟着整行的键走。 */
  action?: ReactNode;
  deletable?: EventLike;
  /** 还没出结论（审查进行中）：字上走一道流光。 */
  live?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const expandable = !onOpen && !!view.detail;
  const line = (
    <>
      <span className={`notice-line-text${live ? " is-live" : ""}`} data-selection-content="">{view.text}</span>
      {tail && <time className="notice-line-tail">{tail}</time>}
    </>
  );
  return (
    <div
      className={`notice-line is-${view.tier} tone-${view.tone}`}
      role={view.tier === "alert" ? "status" : undefined}
    >
      <span className="notice-line-icon" aria-hidden="true"><NoticeIcon glyph={view.glyph} /></span>
      <div className={`notice-line-main${onOpen || expandable ? "" : " is-flow"}`}>
        {onOpen || expandable ? (
          <button
            type="button"
            className="notice-line-button"
            aria-label={openLabel ? `${view.text}，${openLabel}` : undefined}
            aria-expanded={expandable ? open : undefined}
            aria-controls={expandable ? detailId : undefined}
            onClick={() => (onOpen ? onOpen() : setOpen((value) => !value))}
          >
            {line}
          </button>
        ) : (
          // 不能点的一行按文字排：「去裁定」这类动作接在最后一行字后面，不另起一行。
          <span className="notice-line-button is-static">
            {line}
            {action && <span className="notice-line-action">{action}</span>}
          </span>
        )}
        {(onOpen || expandable) && action && <span className="notice-line-action">{action}</span>}
        {deletable && <DeleteMessageButton item={deletable} />}
        {expandable && open && <p className="notice-line-detail" id={detailId}>{view.detail}</p>}
      </div>
    </div>
  );
}

/** 指到才出的那半句：（是哪条命令 ·）时刻。 */
export function noticeTail(view: Pick<NoticeView, "meta">, at?: string): string | null {
  return [view.meta, at ? formatInstant(at) : ""].filter(Boolean).join(" · ") || null;
}

/** 一条时间线旁注，按它的类型摆成常显的一行（团队时间线、审查卡里也用这一份）。 */
export function SystemEventNote({ item, action }: { item: EventLike; action?: ReactNode }) {
  const view = noticeView(item);
  return <NoticeLine view={view} tail={noticeTail(view, item.at)} action={action} deletable={item} />;
}

/** 团队时间线上的回合边界：一条很淡的分隔线和一句说明。 */
export function SystemBoundary({ item, surface = "task" }: { item: EventLike; surface?: "task" | "team" }) {
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

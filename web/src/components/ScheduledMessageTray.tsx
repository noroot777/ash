import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ScheduledMessage } from "@ash/shared";
import { ArrowUUpLeft, CaretDown, CaretUp, ChatsCircle, Clock, Pulse, Queue, SpinnerGap, Stack, Warning, X } from "@phosphor-icons/react";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { formatInstant } from "../task-detail/utils.ts";
import {
  bySendTime, scheduledMessageCounts, scheduledMessageExitCode, scheduledMessageMatches, scheduledMessageSource,
  scheduledMessageSummary, scheduledMessageText, type ScheduledMessageFilter,
} from "./scheduledMessagePresentation.ts";

type TrayProps = {
  messages: ScheduledMessage[];
  loading: boolean;
  error: string | null;
  cancelingIds: ReadonlySet<string>;
  steeringIds?: ReadonlySet<string>;
  onSteer?: (messageId: string) => void;
  onWithdraw: (message: ScheduledMessage) => void;
  onCancel?: (messageId: string) => void;
};

function MessageRow({ message, busy, steering, steerable, onSteer, onWithdraw, onCancel, onInspect, previewIndex }: {
  message: ScheduledMessage;
  busy: boolean;
  steering: boolean;
  steerable: boolean;
  onSteer?: TrayProps["onSteer"];
  onWithdraw: TrayProps["onWithdraw"];
  onCancel?: TrayProps["onCancel"];
  onInspect?: () => void;
  previewIndex?: number;
}) {
  const displayText = scheduledMessageText(message);
  const label = displayText || (message.attachments.length ? `[${message.attachments.length} 个附件]` : "[空消息]");
  const summary = scheduledMessageSummary(message) || label;
  const queued = message.mode === "queued";
  // 哨兵口径（脉冲图标、「取消这次唤醒」、「不执行停止哨兵操作」）只许落在真哨兵上，
  // 判据与后端同源，见 scheduledMessageSource。
  const source = scheduledMessageSource(message);
  const fromMonitor = source === "monitor";
  const exitCode = scheduledMessageExitCode(message);
  const when = queued ? "排队中" : formatInstant(message.sendAt);
  return <div className="scheduled-message-row">
    {previewIndex !== undefined && <span className="scheduled-message-position">{previewIndex + 1}</span>}
    {fromMonitor ? <Pulse size={12} aria-hidden="true" />
      : queued ? <Queue size={12} aria-hidden="true" /> : <Clock size={12} aria-hidden="true" />}
    {fromMonitor ? <em>哨兵</em>
      : source === "managed" ? <em>审查答复</em> : source === "system" ? <em>系统</em> : queued ? <em>我的消息</em>
        : <time dateTime={message.sendAt}>{formatInstant(message.sendAt)}</time>}
    {message.agent && <span className="scheduled-message-agent">@{message.agent}</span>}
    <b>{onInspect ? <button type="button" className="scheduled-message-inspect" onClick={onInspect} aria-label={`查看完整输入：${summary}`}>{summary}</button> : summary}</b>
    {previewIndex !== undefined && exitCode !== null && <span className={`scheduled-message-preview-exit${exitCode !== 0 ? " is-attention" : ""}`}>exit {exitCode}</span>}
    {source === "mine" && steerable && onSteer && <button type="button" className="scheduled-message-guide" disabled={busy}
      aria-label={`用最早的排队消息“${displayText || "附件"}”引导会话`} onClick={() => onSteer(message.id)}>
      {steering ? <SpinnerGap size={13} className="is-spinning" aria-hidden="true" /> : <ChatsCircle size={13} weight="duotone" aria-hidden="true" />}
      <span>{steering ? "引导中" : "引导会话"}</span>
    </button>}
    {fromMonitor ? onCancel && <button type="button" disabled={busy}
      aria-label={`取消哨兵事件“${displayText}”这一次唤醒（仅移除本条输入，不执行停止哨兵操作）`} onClick={() => onCancel(message.id)}>
      {busy ? <SpinnerGap size={12} className="is-spinning" /> : <X size={12} weight="bold" />}
    </button> : source === "managed" ? <small className="scheduled-message-managed">审查会话的答复 · 由审查链投递</small>
      : source === "system" ? <small className="scheduled-message-managed">由系统排入 · 不可撤回</small>
      : <button type="button" className="scheduled-message-withdraw" disabled={busy}
        aria-label={`撤回${when}的待发送消息“${displayText || "附件"}”，内容放回输入框`} onClick={() => onWithdraw(message)}>
        {busy ? <SpinnerGap size={12} className="is-spinning" /> : <ArrowUUpLeft size={12} weight="bold" />}
      </button>}
  </div>;
}

export function ScheduledMessageTray(props: TrayProps) {
  const { messages, loading, error, cancelingIds, steeringIds, onSteer, onWithdraw, onCancel } = props;
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<ScheduledMessageFilter>("all");
  const [pendingCancel, setPendingCancel] = useState<string | null>(null);
  const [revealId, setRevealId] = useState<string | null>(null);
  const [readableIds, setReadableIds] = useState<ReadonlySet<string>>(() => new Set());
  const trayRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const ordered = bySendTime(messages);
  const previews = ordered.filter((message, index) => index < 2 || scheduledMessageSource(message) === "mine");
  const counts = scheduledMessageCounts(ordered);
  const hasMessages = ordered.length > 0;
  const open = hasMessages && expanded;
  const cancelMessage = ordered.find((message) => message.id === pendingCancel);
  const steerable = ordered.find((message) => message.mode === "queued" && scheduledMessageSource(message) === "mine");

  useEffect(() => {
    if (!hasMessages) {
      setExpanded(false);
    }
    if (!hasMessages || ((filter === "managed" || filter === "system") && !counts[filter])) setFilter("all");
    if (!cancelMessage) setPendingCancel(null);
  }, [hasMessages, filter, counts.managed, counts.system, cancelMessage]);

  useEffect(() => {
    setReadableIds((current) => {
      const next = new Set([...current].filter((messageId) => messages.some((message) => message.id === messageId)));
      return next.size === current.size ? current : next;
    });
  }, [messages]);

  useLayoutEffect(() => {
    if (!open || !revealId || !listRef.current) return;
    const list = listRef.current;
    const details = [...list.querySelectorAll<HTMLDetailsElement>("details[data-message-id]")]
      .find((element) => element.dataset.messageId === revealId);
    if (details) {
      setReadableIds((current) => new Set(current).add(revealId));
      list.scrollTop += details.getBoundingClientRect().top - list.getBoundingClientRect().top;
      details.querySelector("summary")?.focus({ preventScroll: true });
    }
    setRevealId(null);
  }, [open, revealId]);

  if (!loading && !error && !messages.length) return null;
  const collapse = () => {
    setExpanded(false);
    setFilter("all");
    toggleRef.current?.focus({ preventScroll: true });
  };
  const inspect = (messageId: string) => {
    setFilter("all");
    setExpanded(true);
    setRevealId(messageId);
  };
  const row = (message: ScheduledMessage, previewIndex?: number) => <MessageRow key={message.id} message={message} previewIndex={previewIndex}
    busy={cancelingIds.has(message.id) || !!steeringIds?.has(message.id)} steering={!!steeringIds?.has(message.id)}
    steerable={message.id === steerable?.id} onSteer={onSteer} onWithdraw={onWithdraw}
    onCancel={onCancel ? setPendingCancel : undefined} onInspect={previewIndex !== undefined ? () => inspect(message.id) : undefined} />;
  const details = (message: ScheduledMessage) => <details className="scheduled-message-details" data-message-id={message.id}
    open={readableIds.has(message.id)} onToggle={(event) => {
      const visible = event.currentTarget.open;
      setReadableIds((current) => {
        if (current.has(message.id) === visible) return current;
        const next = new Set(current);
        if (visible) next.add(message.id); else next.delete(message.id);
        return next;
      });
    }}><summary>查看完整输入</summary>
    <div className="scheduled-message-body">{scheduledMessageText(message) || "[无文字内容]"}</div>
    {message.attachments.length > 0 && <ul aria-label="消息附件">{message.attachments.map((path, index) => <li key={`${index}:${path}`}>{path}</li>)}</ul>}
  </details>;
  const filters: [ScheduledMessageFilter, string][] = [["all", "全部"], ["mine", "我的消息"], ["monitor", "哨兵"],
    ...(counts.managed ? [["managed", "审查答复"] as [ScheduledMessageFilter, string]] : []),
    ...(counts.system ? [["system", "系统"] as [ScheduledMessageFilter, string]] : []), ["attention", "需留意"]];
  const timed = ordered.filter((message) => message.mode === "timed").length;
  const sources = [counts.mine ? `我的消息 ${counts.mine}` : "", counts.monitor ? `哨兵 ${counts.monitor}` : "",
    counts.managed ? `审查答复 ${counts.managed}` : "", counts.system ? `系统 ${counts.system}` : "",
    timed ? `含 ${timed} 条定时` : ""].filter(Boolean).join(" · ");

  return <>
    <div ref={trayRef} className="scheduled-message-tray" aria-label="待发送消息" onKeyDown={(event) => {
      if (event.key === "Escape" && open) {
        event.preventDefault();
        event.stopPropagation();
        collapse();
      }
    }}>
      {loading && !messages.length && <small>正在加载待发送消息…</small>}
      {error && <p role="alert">待发送消息：{error}</p>}
      {hasMessages && <section className={`scheduled-message-card${open ? " is-expanded" : ""}${ordered.length > 1 ? " has-stack" : ""}`} aria-label="排队输入">
        <header className="scheduled-message-summary">
          <span className="scheduled-message-stack"><Stack size={15} aria-hidden="true" /></span>
          <div className="scheduled-message-summary-copy"><strong>排队输入 <span>{ordered.length}</span></strong>
            <small>{sources}<span> · </span>{timed === ordered.length ? "按设定时间发送" : "等待当前一轮结束"}</small></div>
          {counts.attention > 0 && <button type="button" className="scheduled-message-attention" onClick={() => {
            setFilter("attention"); setExpanded(true);
            if (listRef.current) listRef.current.scrollTop = 0;
          }} aria-label={`查看 ${counts.attention} 条退出码非零的输入`}><Warning size={12} aria-hidden="true" />{counts.attention} 条需留意</button>}
          <button ref={toggleRef} type="button" className="scheduled-message-toggle" aria-expanded={open} aria-controls={listId}
            onClick={() => { if (open) collapse(); else { setFilter("all"); setExpanded(true); } }}>
            {open ? "收起列表" : `展开全部 ${ordered.length} 条`}{open ? <CaretDown size={12} /> : <CaretUp size={12} />}
          </button>
        </header>
        {open ? <div id={listId} className="scheduled-message-expanded">
          <div className="scheduled-message-filters" role="group" aria-label="筛选待发送消息">{filters.map(([key, label]) => <button key={key}
            type="button" aria-pressed={filter === key} onClick={() => { setFilter(key); if (listRef.current) listRef.current.scrollTop = 0; }}>
            {label} <span>{counts[key]}</span></button>)}</div>
          <div ref={listRef} className="scheduled-message-items" role="region" aria-label="排队输入完整列表" tabIndex={0}>
            {ordered.filter((message) => scheduledMessageMatches(message, filter)).map((message) => {
              const exitCode = scheduledMessageExitCode(message);
              return <article className="scheduled-message-item" key={message.id}>
                <div className="scheduled-message-item-meta"><span>#{ordered.indexOf(message) + 1}</span>
                  {exitCode !== null && <span className={exitCode !== 0 ? "is-attention" : undefined}>exit {exitCode}</span>}</div>
                {row(message)}
                {details(message)}
              </article>;
            })}
            {!ordered.some((message) => scheduledMessageMatches(message, filter)) && <p className="scheduled-message-empty">这个分类下没有待发送输入。</p>}
          </div>
          <footer className="scheduled-message-footer">按发送时间和入队顺序处理；筛选不改变顺序。</footer>
        </div> : <div id={listId} className="scheduled-message-previews">{previews.map(message => row(message, ordered.indexOf(message)))}
          {ordered.length > previews.length && <small>另有 {ordered.length - previews.length} 条系统输入已收起 · 按原顺序等待处理</small>}</div>}
      </section>}
      <span className="scheduled-message-announcement" role="status">{ordered.length} 条待发送消息{counts.attention > 0 && `，${counts.attention} 条需留意`}</span>
    </div>
    {cancelMessage && onCancel && <ConfirmDialog title="取消这次唤醒？" message="仅移除这条待发送输入，不执行停止哨兵操作。"
      confirmLabel="取消这次唤醒" cancelLabel="保留输入" busy={cancelingIds.has(cancelMessage.id)} danger
      onConfirm={() => onCancel(cancelMessage.id)} onClose={() => setPendingCancel(null)}>
      <p className="scheduled-message-cancel-text">{scheduledMessageText(cancelMessage)}</p>
      {error && <p role="alert">{error}</p>}
    </ConfirmDialog>}
  </>;
}

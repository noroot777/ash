import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { ScheduledMessage } from "@harness/shared";
import { Clock, Queue, SpinnerGap, X } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { useDismissable } from "../lib/useDismissable.ts";
import { toLocalDateTime } from "./ScheduleControl.tsx";
import { formatInstant } from "../task-detail/utils.ts";

function bySendTime(messages: ScheduledMessage[]): ScheduledMessage[] {
  return [...messages].sort((left, right) => left.sendAt.localeCompare(right.sendAt));
}

export function useScheduledMessages(taskId: string) {
  const [messages, setMessages] = useState<ScheduledMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelingIds, setCancelingIds] = useState<ReadonlySet<string>>(() => new Set());

  // quiet=true:不闪 loading 态。任务状态一变就重拉一次(排队消息可能刚被投递
  // 出去),托盘要么原样、要么少一行,不该在用户眼皮底下闪一下「正在加载」。
  const reload = useCallback(async (options?: { quiet?: boolean }) => {
    if (!options?.quiet) setLoading(true);
    try {
      setMessages(bySendTime(await api.scheduledMessages(taskId)));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    let alive = true;
    setMessages([]);
    setCancelingIds(new Set());
    setLoading(true);
    setError(null);
    void api.scheduledMessages(taskId).then(
      (next) => {
        if (!alive) return;
        setMessages(bySendTime(next));
        setLoading(false);
      },
      (reason) => {
        if (!alive) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      },
    );
    return () => { alive = false; };
  }, [taskId]);

  const add = useCallback((message: ScheduledMessage) => {
    setMessages((current) => bySendTime([...current.filter((item) => item.id !== message.id), message]));
  }, []);

  const cancel = useCallback(async (messageId: string) => {
    setCancelingIds((current) => new Set(current).add(messageId));
    setError(null);
    try {
      await api.cancelScheduledMessage(messageId);
      setMessages((current) => current.filter((message) => message.id !== messageId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCancelingIds((current) => {
        const next = new Set(current);
        next.delete(messageId);
        return next;
      });
    }
  }, []);

  return { messages, loading, error, cancelingIds, add, cancel, reload };
}

export function ScheduledMessageTray({
  messages,
  loading,
  error,
  cancelingIds,
  onCancel,
}: {
  messages: ScheduledMessage[];
  loading: boolean;
  error: string | null;
  cancelingIds: ReadonlySet<string>;
  onCancel: (messageId: string) => void;
}) {
  if (!loading && !error && messages.length === 0) return null;
  return (
    <div className="scheduled-message-tray" aria-label="待发送消息">
      {loading && messages.length === 0 && <small>正在加载待发送消息…</small>}
      {error && <p role="alert">待发送消息：{error}</p>}
      {messages.map((message) => {
        const canceling = cancelingIds.has(message.id);
        // 排队消息没有「几点发」可言——它等的是任务空下来,所以那一格写它在等什么。
        const queued = message.mode === "queued";
        const when = queued ? "排队中" : formatInstant(message.sendAt);
        return (
          <div className="scheduled-message-row" key={message.id}>
            {queued ? <Queue size={12} aria-hidden="true" /> : <Clock size={12} aria-hidden="true" />}
            {queued
              ? <em>排队中 · 跑完自动发送</em>
              : <time dateTime={message.sendAt}>{formatInstant(message.sendAt)}</time>}
            {message.agent && <span>@{message.agent}</span>}
            <b title={message.text || message.attachments.join("\n")}>
              {message.text || (message.attachments.length ? `[${message.attachments.length} 个附件]` : "[空消息]")}
            </b>
            <button
              type="button"
              disabled={canceling}
              title={queued ? "取消这条排队消息" : "取消定时发送"}
              aria-label={`取消${when}的待发送消息`}
              onClick={() => onCancel(message.id)}
            >
              {canceling ? <SpinnerGap size={12} className="is-spinning" /> : <X size={12} weight="bold" />}
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function ScheduledSendPanel({
  value,
  busy,
  canSubmit,
  triggerRef,
  onChange,
  onCancel,
  onSubmit,
}: {
  value: string;
  busy: boolean;
  canSubmit: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDismissable({
    enabled: true,
    containerRef: panelRef,
    onClose: onCancel,
    restoreFocusRef: triggerRef,
  });

  return (
    <div ref={panelRef} className="scheduled-send-panel" role="dialog" aria-label="定时发送回复">
      <b>定时发送</b>
      <label>
        <span>发送时间</span>
        <input
          type="datetime-local"
          value={value}
          min={toLocalDateTime(new Date(Date.now() + 60_000))}
          disabled={busy}
          autoFocus
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <footer>
        <button type="button" disabled={busy} onClick={onCancel}>取消</button>
        <button type="button" disabled={!canSubmit || busy} onClick={onSubmit}>
          {busy ? <SpinnerGap size={12} className="is-spinning" /> : <Clock size={12} />}
          定时发送
        </button>
      </footer>
    </div>
  );
}

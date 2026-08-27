import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { ScheduledMessage } from "@ash/shared";
import { ArrowUUpLeft, ChatsCircle, Clock, Queue, SpinnerGap } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";
import { useDismissable } from "../lib/useDismissable.ts";
import { toLocalDateTime } from "./ScheduleControl.tsx";
import { formatInstant } from "../task-detail/utils.ts";

function messageOrder(left: ScheduledMessage, right: ScheduledMessage): number {
  return left.sendAt.localeCompare(right.sendAt)
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id);
}

function bySendTime(messages: ScheduledMessage[]): ScheduledMessage[] {
  return [...messages].sort(messageOrder);
}

type ScheduledMessageActionError = { messageId: string; message: string };

export function retainScheduledMessageActionError(
  error: ScheduledMessageActionError | null,
  messages: Pick<ScheduledMessage, "id">[],
): ScheduledMessageActionError | null {
  return error && messages.some((message) => message.id === error.messageId) ? error : null;
}

export function useScheduledMessages(taskId: string) {
  const [messages, setMessages] = useState<ScheduledMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ScheduledMessageActionError | null>(null);
  const [cancelingIds, setCancelingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [steeringIds, setSteeringIds] = useState<ReadonlySet<string>>(() => new Set());

  // quiet=true:不闪 loading 态。任务状态一变就重拉一次(排队消息可能刚被投递
  // 出去),托盘要么原样、要么少一行,不该在用户眼皮底下闪一下「正在加载」。
  const reload = useCallback(async (options?: { quiet?: boolean }) => {
    if (!options?.quiet) setLoading(true);
    try {
      const next = bySendTime(await api.scheduledMessages(taskId));
      setMessages(next);
      setActionError((current) => retainScheduledMessageActionError(current, next));
      setLoadError(null);
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    let alive = true;
    setMessages([]);
    setCancelingIds(new Set());
    setSteeringIds(new Set());
    setLoading(true);
    setLoadError(null);
    setActionError(null);
    void api.scheduledMessages(taskId).then(
      (next) => {
        if (!alive) return;
        setMessages(bySendTime(next));
        setLoading(false);
      },
      (reason) => {
        if (!alive) return;
        setLoadError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      },
    );
    return () => { alive = false; };
  }, [taskId]);

  const add = useCallback((message: ScheduledMessage) => {
    setActionError(null);
    setMessages((current) => bySendTime([...current.filter((item) => item.id !== message.id), message]));
  }, []);

  // 托盘该少一行的唯一权威信号:服务端在入队/投递/取消时发的 task.pendingMessages。
  // 排队消息一发出去任务立刻又回到 running,「任务不在跑了」那个空档前端常常一次都
  // 看不到 —— 靠它反推就会把已经进了会话的消息一直挂在托盘上。
  useServerEvents((event) => {
    if (event.type !== "task.pendingMessages" || event.taskId !== taskId) return;
    void reload({ quiet: true });
  });

  // 服务端只有「取消」这一个动作；界面上它是**撤回**——调用方在取消成功后把这条
  // 消息的正文和附件放回对话框（见 task-detail/withdrawDraft.ts），所以这里要如实
  // 返回成功与否：失败了消息还在队列上，绝不能再往输入框里塞一份。
  const cancel = useCallback(async (messageId: string): Promise<boolean> => {
    setCancelingIds((current) => new Set(current).add(messageId));
    setActionError(null);
    try {
      await api.cancelScheduledMessage(messageId);
      setMessages((current) => current.filter((message) => message.id !== messageId));
      return true;
    } catch (reason) {
      setActionError({ messageId, message: reason instanceof Error ? reason.message : String(reason) });
      void reload({ quiet: true });
      return false;
    } finally {
      setCancelingIds((current) => {
        const next = new Set(current);
        next.delete(messageId);
        return next;
      });
    }
  }, [reload]);

  const steer = useCallback(async (messageId: string) => {
    setSteeringIds((current) => new Set(current).add(messageId));
    setActionError(null);
    try {
      await api.steerScheduledMessage(messageId);
      // 端点只有在原话真正落进同一会话、服务端已标 sent 后才返回成功；SSE 是权威
      // 收口，这里同步少一行只是让按钮点击后的反馈不受网络事件时序影响。
      setMessages((current) => current.filter((message) => message.id !== messageId));
    } catch (reason) {
      // 失败不做乐观删除：消息仍在队列，用户可以继续等或再次尝试引导。
      setActionError({ messageId, message: reason instanceof Error ? reason.message : String(reason) });
      void reload({ quiet: true });
    } finally {
      setSteeringIds((current) => {
        const next = new Set(current);
        next.delete(messageId);
        return next;
      });
    }
  }, [reload]);

  return {
    messages,
    loading,
    error: actionError?.message ?? loadError,
    cancelingIds,
    steeringIds,
    add,
    cancel,
    steer,
    reload,
  };
}

export function ScheduledMessageTray({
  messages,
  loading,
  error,
  cancelingIds,
  steeringIds,
  onSteer,
  onWithdraw,
}: {
  messages: ScheduledMessage[];
  loading: boolean;
  error: string | null;
  cancelingIds: ReadonlySet<string>;
  steeringIds?: ReadonlySet<string>;
  onSteer?: (messageId: string) => void;
  // 撤回:把这条消息从队列上取下来,内容(正文 + 附件)放回对话框继续编辑。
  onWithdraw: (message: ScheduledMessage) => void;
}) {
  if (!loading && !error && messages.length === 0) return null;
  const orderedMessages = bySendTime(messages);
  const steerable = orderedMessages.find((message) => message.mode === "queued");
  return (
    <div className="scheduled-message-tray" aria-label="待发送消息">
      {loading && messages.length === 0 && <small>正在加载待发送消息…</small>}
      {error && <p role="alert">待发送消息：{error}</p>}
      {orderedMessages.map((message) => {
        const canceling = cancelingIds.has(message.id);
        const steering = steeringIds?.has(message.id) ?? false;
        const busy = canceling || steering;
        // 排队消息没有「几点发」可言——它等的是任务空下来,所以那一格写它在等什么。
        const queued = message.mode === "queued";
        const when = queued ? "排队中" : formatInstant(message.sendAt);
        return (
          <div className="scheduled-message-row" key={message.id}>
            {queued ? <Queue size={12} aria-hidden="true" /> : <Clock size={12} aria-hidden="true" />}
            {queued
              ? <em>排队 · 当前回合结束后发送</em>
              : <time dateTime={message.sendAt}>{formatInstant(message.sendAt)}</time>}
            {message.agent && <span>@{message.agent}</span>}
            <b title={message.text || message.attachments.join("\n")}>
              {message.text || (message.attachments.length ? `[${message.attachments.length} 个附件]` : "[空消息]")}
            </b>
            {message.id === steerable?.id && onSteer && (
              <button
                type="button"
                className="scheduled-message-guide"
                disabled={busy}
                aria-label={`用最早的排队消息“${message.text || "附件"}”引导会话`}
                onClick={() => onSteer(message.id)}
              >
                {steering
                  ? <SpinnerGap size={13} className="is-spinning" aria-hidden="true" />
                  : <ChatsCircle size={13} weight="duotone" aria-hidden="true" />}
                <span>{steering ? "引导中" : "引导会话"}</span>
              </button>
            )}
            <button
              type="button"
              className="scheduled-message-withdraw"
              disabled={busy}
              title={queued ? "撤回这条排队消息，内容放回输入框" : "撤回这条定时消息，内容放回输入框"}
              aria-label={`撤回${when}的待发送消息“${message.text || "附件"}”，内容放回输入框`}
              onClick={() => onWithdraw(message)}
            >
              {canceling
                ? <SpinnerGap size={12} className="is-spinning" />
                : <ArrowUUpLeft size={12} weight="bold" />}
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

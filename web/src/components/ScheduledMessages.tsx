import { useCallback, useEffect, useState } from "react";
import type { ScheduledMessage } from "@ash/shared";
import { api } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";
import { bySendTime } from "./scheduledMessagePresentation.ts";
export { ScheduledMessageTray } from "./ScheduledMessageTray.tsx";

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

  // 入队回执(POST /reply)只有这一行本身,不带服务端按此刻事实算的 wait / steerable:它可能比
  // task.pendingMessages 触发的那次重拉晚到,直接替换就会把完整的那份盖掉,引导键和等待说明一起
  // 消失。所以已有同一行时保留那两项,再重拉一次拿权威值。
  const add = useCallback((message: ScheduledMessage) => {
    setActionError(null);
    setMessages((current) => {
      const known = current.find((item) => item.id === message.id);
      const merged = known ? { ...message, wait: known.wait, steerable: known.steerable } : message;
      return bySendTime([...current.filter((item) => item.id !== message.id), merged]);
    });
    void reload({ quiet: true });
  }, [reload]);

  // 托盘该少一行的唯一权威信号:服务端在入队/投递/取消时发的 task.pendingMessages。
  // 排队消息一发出去任务立刻又回到 running,「任务不在跑了」那个空档前端常常一次都
  // 看不到 —— 靠它反推就会把已经进了会话的消息一直挂在托盘上。
  // 每条在等什么、能不能引导(wait / steerable)读的那些事实一变(本任务与同队成员换状态、队列
  // 变动、分组暂停/恢复),服务端也发这同一个事件(server/src/pending-wait.ts 的失效通知)。
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
      // 队首换了人,剩下那几条能不能引导要服务端重新判(steerable),别等 SSE 那一拍。
      void reload({ quiet: true });
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

  // 「不等了」:等前置任务的消息改成普通排队,任务一空闲就发。成功后那一行由 SSE 重拉改口,
  // 这里不做乐观改写 —— 改成什么样以服务端为准。
  const sendNow = useCallback(async (messageId: string) => {
    setCancelingIds((current) => new Set(current).add(messageId));
    setActionError(null);
    try {
      await api.sendScheduledMessageNow(messageId);
      await reload({ quiet: true });
    } catch (reason) {
      setActionError({ messageId, message: reason instanceof Error ? reason.message : String(reason) });
      void reload({ quiet: true });
    } finally {
      setCancelingIds((current) => {
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
    sendNow,
    reload,
  };
}

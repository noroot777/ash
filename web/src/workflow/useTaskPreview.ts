// 预设工作流「打开预览」那一站读的当前预览：开着没有、地址是什么。
//
// 起来了、收掉了都不往会话里写（那句「预览已起：地址」曾经是这条线唯一的入口），所以地址
// 必须由这一站自己现读、刷新后照样在。
//
// 给出去的只能是**确认过的**当下：
// - 连着事件通道时靠推：预览起停服务端都发 task.review（任务重新开跑收预览还跟着 task.status），
//   据此重读；
// - 断线期间推不过来、重连后服务端也不补发错过的事件：重连那一下重读一次，断着的时候自己拉；
// - 最近一次没读到，就不知道它现在开没开：不给入口（宁可暂时没有，也不给一个可能已经死掉的
//   地址），隔一会儿再读。
import { useCallback, useEffect, useRef, useState } from "react";
import type { FreeWorkflowPreviewState } from "@ash/shared/free-workflow";
import { request } from "../lib/apiClient.ts";
import { useServerEvents } from "../lib/events.ts";

const PULL_MS = 2500;

export function useTaskPreview(taskId: string): { preview: FreeWorkflowPreviewState | null; reload: () => void } {
  const [read, setRead] = useState<{ preview: FreeWorkflowPreviewState | null; ok: boolean }>({ preview: null, ok: false });
  // 只认最后发出的那一发：先发后到的旧结果不能盖掉新的。
  const ticket = useRef(0);
  const reload = useCallback(() => {
    const mine = ++ticket.current;
    void request<FreeWorkflowPreviewState>(`/tasks/${encodeURIComponent(taskId)}/preview`)
      .then((next) => { if (mine === ticket.current) setRead({ preview: next, ok: true }); })
      .catch(() => { if (mine === ticket.current) setRead((last) => ({ ...last, ok: false })); });
  }, [taskId]);
  useEffect(() => {
    setRead({ preview: null, ok: false });
    reload();
    return () => { ++ticket.current; };
  }, [reload]);
  const connected = useServerEvents(useCallback((event) => {
    if ((event.type === "task.review" || event.type === "task.status") && event.taskId === taskId) reload();
  }, [reload, taskId]));
  const wasConnected = useRef(connected);
  useEffect(() => {
    if (connected && !wasConnected.current) reload();
    wasConnected.current = connected;
  }, [connected, reload]);
  useEffect(() => {
    if (connected && read.ok) return;
    const timer = window.setInterval(reload, PULL_MS);
    return () => window.clearInterval(timer);
  }, [connected, read.ok, reload]);
  return { preview: read.ok ? read.preview : null, reload };
}

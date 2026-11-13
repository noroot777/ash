// 预设工作流「打开预览」那一站读的当前预览：开着没有、地址是什么。
//
// 起来了、收掉了都不往会话里写（那句「预览已起：地址」曾经是这条线唯一的入口），所以地址
// 必须由这一站自己现读、刷新后照样在。预览起停时服务端都会发 task.review（任务重新开跑
// 收预览那一下还会跟着 task.status），据此重读，不轮询。
import { useCallback, useEffect, useRef, useState } from "react";
import type { FreeWorkflowPreviewState } from "@ash/shared/free-workflow";
import { request } from "../lib/apiClient.ts";
import { useServerEvents } from "../lib/events.ts";

export function useTaskPreview(taskId: string): { preview: FreeWorkflowPreviewState | null; reload: () => void } {
  const [preview, setPreview] = useState<FreeWorkflowPreviewState | null>(null);
  // 只认最后发出的那一发：先发后到的旧结果不能盖掉新的。
  const ticket = useRef(0);
  const reload = useCallback(() => {
    const mine = ++ticket.current;
    void request<FreeWorkflowPreviewState>(`/tasks/${encodeURIComponent(taskId)}/preview`)
      .then((next) => { if (mine === ticket.current) setPreview(next); })
      .catch(() => { /* 读不到就保持现状，下一次事件再读 */ });
  }, [taskId]);
  useEffect(() => {
    setPreview(null);
    reload();
    return () => { ++ticket.current; };
  }, [reload]);
  useServerEvents(useCallback((event) => {
    if ((event.type === "task.review" || event.type === "task.status") && event.taskId === taskId) reload();
  }, [reload, taskId]));
  return { preview, reload };
}

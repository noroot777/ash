// 预设工作流「打开预览」那一站读的当前预览：开着没有、地址是什么。
//
// 起来了、收掉了都不往会话里写（那句「预览已起：地址」曾经是这条线唯一的入口），所以地址
// 必须由这一站自己现读、刷新后照样在。给出去的只能是**确认过的**当下：最近一次没读到，
// 就不知道它现在开没开，不给入口（宁可暂时没有，也不给一个可能已经死掉的地址）。
//
// 什么时候读——挂上时、事件来时（预览起停服务端都发 task.review，任务重新开跑收预览还跟着
// task.status）、事件通道断开或重连时（断着推不过来，重连后服务端也不补发错过的事件）、
// 断线期间与上一次没读到之后隔一会儿再拉、点完重启。这些全走同一个调度，它守三条：
//
// 1. **同一时刻只有一发在路上**。读的途中又要读，记一笔，这一发回来后再补读一次：慢的那一发
//    照样落地（它比手上的新），补读的那一发保证读到触发之后的状态。重试要能取得进展，靠的
//    就是这一条——每次重试都作废上一发的话，比重试间隔慢的响应永远落不了地。
// 2. **下一次拉排在这一次回来之后**，不按固定节拍发；
// 3. **一发最多等 READ_TIMEOUT_MS**。挂死的请求不放掉，第 1 条就成了永远在路上的那一发。
//
// 换任务或卸下时整个调度作废，还在路上的那一发回来也不认。
import { useCallback, useEffect, useRef, useState } from "react";
import type { FreeWorkflowPreviewState } from "@ash/shared/free-workflow";
import { request } from "../lib/apiClient.ts";
import { useServerEvents } from "../lib/events.ts";

const PULL_MS = 2500;
const READ_TIMEOUT_MS = 10_000;

type Read = { preview: FreeWorkflowPreviewState | null; ok: boolean };

export function useTaskPreview(taskId: string): { preview: FreeWorkflowPreviewState | null; reload: () => void } {
  const [read, setRead] = useState<Read>({ preview: null, ok: false });
  const connectedRef = useRef(false);
  const syncRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let alive = true;
    let inFlight: AbortController | null = null;
    let again = false;
    let next: number | undefined;
    setRead({ preview: null, ok: false });
    const sync = () => {
      window.clearTimeout(next);
      if (inFlight) { again = true; return; }
      again = false;
      const controller = new AbortController();
      inFlight = controller;
      const timeout = window.setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
      let ok = false;
      request<FreeWorkflowPreviewState>(`/tasks/${encodeURIComponent(taskId)}/preview`, { signal: controller.signal })
        .then((preview) => { ok = true; if (alive) setRead({ preview, ok: true }); })
        .catch(() => { if (alive) setRead((last) => ({ ...last, ok: false })); })
        .finally(() => {
          window.clearTimeout(timeout);
          inFlight = null;
          if (!alive) return;
          if (again) sync();
          else if (!ok || !connectedRef.current) next = window.setTimeout(sync, PULL_MS);
        });
    };
    syncRef.current = sync;
    sync();
    return () => {
      alive = false;
      window.clearTimeout(next);
      inFlight?.abort();
      syncRef.current = null;
    };
  }, [taskId]);

  const reload = useCallback(() => syncRef.current?.(), []);
  const connected = useServerEvents(useCallback((event) => {
    if ((event.type === "task.review" || event.type === "task.status") && event.taskId === taskId) reload();
  }, [reload, taskId]));
  const wasConnected = useRef(connected);
  useEffect(() => {
    connectedRef.current = connected;
    if (connected === wasConnected.current) return;
    wasConnected.current = connected;
    // 断开：从这一刻起推不过来，改成自己拉；重连：中间错过的事件不会补发，重读一次。
    reload();
  }, [connected, reload]);
  return { preview: read.ok ? read.preview : null, reload };
}

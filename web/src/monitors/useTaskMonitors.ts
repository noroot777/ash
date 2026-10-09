// 任务上挂着的哨兵：界面这一侧的数据源。
//
// 为什么它必须有界面：哨兵的进程是**故意脱离 ash** 的（agent 回合结束、会话结束、
// server 重启都带不走它），代价就是「有个进程在后台跑着」这件事再没有别的地方看得见。
// 只在 agent 的对话里说一句「已起哨兵」不算数——刷新页面后就什么都不剩了。
import { useCallback, useEffect, useState } from "react";
import type { TaskMonitor } from "@ash/shared/monitor";
import { api } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";

/** 已结束的哨兵留在列表里多久仍然算「当前」——「它刚刚停了、推了几条」是用户要的信息。 */
const KEEP_ENDED_MS = 30 * 60_000;

export function visibleMonitors(all: TaskMonitor[], at = Date.now()): TaskMonitor[] {
  return all.filter((m) => m.status === "running" || (m.endedAt && at - new Date(m.endedAt).getTime() < KEEP_ENDED_MS));
}

export const MONITOR_ENDED_LABEL: Record<string, string> = {
  exited: "命令自己跑完了",
  expired: "盯满时长",
  stopped: "已停止",
  lost: "进程已不在",
};

export interface StartMonitorInput {
  command: string;
  description?: string;
  timeoutMs?: number;
}

export type TaskMonitorsState = ReturnType<typeof useTaskMonitors>;

export function useTaskMonitors(taskId: string) {
  const [monitors, setMonitors] = useState<TaskMonitor[]>([]);
  const [stoppingIds, setStoppingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setMonitors(await api.taskMonitors(taskId));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [taskId]);

  useEffect(() => {
    setMonitors([]);
    setError(null);
    void reload();
  }, [reload]);

  // 权威信号只有服务端这一条：起了、推了一批、结束了，都发 task.monitors。
  useServerEvents((event) => {
    if (event.type !== "task.monitors" || event.taskId !== taskId) return;
    void reload();
  });

  const stop = useCallback(async (monitorId: string) => {
    setStoppingIds((current) => new Set(current).add(monitorId));
    setError(null);
    try {
      await api.stopMonitor(monitorId);
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStoppingIds((current) => {
        const next = new Set(current);
        next.delete(monitorId);
        return next;
      });
    }
  }, [reload]);

  /** 手动起一个。成功返回 true，失败把原因留在 `error` 上——表单据此决定要不要收起来。 */
  const start = useCallback(async (input: StartMonitorInput): Promise<boolean> => {
    setStarting(true);
    setError(null);
    try {
      await api.startMonitor(taskId, input);
      await reload();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setStarting(false);
    }
  }, [reload, taskId]);

  return { monitors, stoppingIds, starting, error, start, stop, reload };
}

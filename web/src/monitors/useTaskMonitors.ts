// 任务上挂着的哨兵：界面这一侧的数据源。
//
// 为什么它必须有界面：哨兵的进程是**故意脱离 ash** 的（agent 回合结束、会话结束、
// server 重启都带不走它），代价就是「有个进程在后台跑着」这件事再没有别的地方看得见。
// 只在 agent 的对话里说一句「已起哨兵」不算数——刷新页面后就什么都不剩了。
import { useCallback, useEffect, useRef, useState } from "react";
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
  /**
   * 「现在是哪个任务、这是它的第几次读取」。
   *
   * 宿主组件跨任务复用（切任务不重挂载），而 `setMonitors([])` 只能清掉当下那一份值、
   * 撤不回已经发出去的请求：网慢的时候从 A 切到 B，A 的迟到响应会原样盖在 B 的面板上
   * ——而那张列表每一行都带着「停掉」按钮，点下去真停的是 A 的活（第 1 轮审查实测：
   * 标题、侧栏、地址栏全是 B，停掉的是 A 的哨兵）。
   *
   * 三样各管一件事，缺一不可：
   * - `taskId` 管**出门前**。`stop`/`start` 收尾时调的 `reload` 是它们被创建那一刻的
   *   那份闭包，里面带的是旧 taskId；切走之后它才跑到这一句，就会去读上一个任务的列表
   *   然后堂堂正正地写进当前面板（事后再比代号也认不出来——代号是它自己出门时取的）。
   * - `gen` 管**跨任务的迟到响应**：换任务时 +1，让在途的那些回来时作废。
   * - `seq` 管**同一任务内乱序回来的旧响应**：每次发起 +1。
   */
  const stamp = useRef({ gen: 0, seq: 0, taskId: "" });

  const reload = useCallback(async () => {
    if (stamp.current.taskId !== taskId) return;
    const gen = stamp.current.gen;
    const seq = ++stamp.current.seq;
    const mine = () => stamp.current.gen === gen && stamp.current.seq === seq;
    try {
      const next = await api.taskMonitors(taskId);
      if (!mine()) return;
      setMonitors(next);
      setError(null);
    } catch (reason) {
      if (!mine()) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [taskId]);

  useEffect(() => {
    // 换任务：在途的那些请求当场作废，它们回来时已经不是「这个任务的列表」了。
    stamp.current = { gen: stamp.current.gen + 1, seq: 0, taskId };
    setMonitors([]);
    setError(null);
    void reload();
  }, [reload, taskId]);

  // 权威信号只有服务端这一条：起了、推了一批、结束了，都发 task.monitors。
  useServerEvents((event) => {
    if (event.type !== "task.monitors" || event.taskId !== taskId) return;
    void reload();
  });

  const stop = useCallback(async (monitorId: string) => {
    const gen = stamp.current.gen;
    setStoppingIds((current) => new Set(current).add(monitorId));
    setError(null);
    try {
      await api.stopMonitor(monitorId);
      await reload();
    } catch (reason) {
      // 切走之后才回来的失败不要往新任务的面板上贴：那句报错说的是上一个任务的事。
      if (stamp.current.gen === gen) setError(reason instanceof Error ? reason.message : String(reason));
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
    const gen = stamp.current.gen;
    setStarting(true);
    setError(null);
    try {
      await api.startMonitor(taskId, input);
      await reload();
      return true;
    } catch (reason) {
      if (stamp.current.gen === gen) setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setStarting(false);
    }
  }, [reload, taskId]);

  return { monitors, stoppingIds, starting, error, start, stop, reload };
}

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
    setStoppingIds(new Set());
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

  /**
   * 手动起一个。成功返回 true，失败把原因留在 `error` 上——表单据此决定要不要收起来。
   *
   * **切走之后它一律返回 false**，哪怕服务端那一边真的起成功了。调用方拿 true 去做的
   * 唯一一件事是「把表单收起来」，而此刻屏幕上那张表单已经是**另一个任务**的了，里面
   * 往往还有没提交的草稿。它起没起成功由那个任务自己的列表去说，不该由一句跨任务的
   * 返回值去动当前的表单。
   *
   * 「正在创建中」这件事**故意不住在这里**：同一个任务上可以有一张在途的表单和一张刚
   * 重开的表单，而忙碌状态要回答的是「**这张**表单的提交按钮要不要锁」——按任务存就只有
   * 一个值，取消重开之后新表单照样被旧请求按住（第 3 轮审查实测：
   * reopenedBlockedByOldStart=true）。所以它归调用方按表单实例自己存。
   */
  const start = useCallback(async (input: StartMonitorInput): Promise<boolean> => {
    const gen = stamp.current.gen;
    const mine = () => stamp.current.gen === gen;
    setError(null);
    try {
      await api.startMonitor(taskId, input);
      await reload();
      return mine();
    } catch (reason) {
      if (mine()) setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    }
  }, [reload, taskId]);

  return { monitors, stoppingIds, error, start, stop, reload };
}

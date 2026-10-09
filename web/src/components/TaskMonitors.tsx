// 任务上挂着的哨兵。界面上要回答的只有三句话：谁在盯、盯到哪了、怎么让它停。
//
// 为什么它必须有界面：哨兵的进程是**故意脱离 ash** 的（agent 回合结束、会话结束、
// server 重启都带不走它），代价就是「有个进程在后台跑着」这件事再没有别的地方看得见。
// 只在 agent 的对话里说一句「已起哨兵」不算数——刷新页面后就什么都不剩了。
import { useCallback, useEffect, useState } from "react";
import type { TaskMonitor } from "@ash/shared/monitor";
import { Pulse, SpinnerGap, StopCircle } from "@phosphor-icons/react";
import { HoverTip, useHoverTip } from "./HoverTip.tsx";
import { api } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";
import { formatInstant } from "../task-detail/utils.ts";

/** 已结束的哨兵留在列表里多久仍然展示——「它刚刚停了、推了几条」是用户要的信息。 */
const KEEP_ENDED_MS = 30 * 60_000;

export function visibleMonitors(all: TaskMonitor[], at = Date.now()): TaskMonitor[] {
  return all.filter((m) => m.status === "running" || (m.endedAt && at - new Date(m.endedAt).getTime() < KEEP_ENDED_MS));
}

const ENDED_LABEL: Record<string, string> = {
  exited: "命令自己跑完了",
  expired: "盯满时长",
  stopped: "已停止",
  lost: "进程已不在",
};

export function useTaskMonitors(taskId: string) {
  const [monitors, setMonitors] = useState<TaskMonitor[]>([]);
  const [stoppingIds, setStoppingIds] = useState<ReadonlySet<string>>(() => new Set());
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

  return { monitors, stoppingIds, error, stop, reload };
}

export function TaskMonitorStrip({
  monitors,
  stoppingIds,
  error,
  onStop,
}: {
  monitors: TaskMonitor[];
  stoppingIds: ReadonlySet<string>;
  error: string | null;
  onStop: (monitorId: string) => void;
}) {
  const shown = visibleMonitors(monitors);
  if (!shown.length && !error) return null;
  return (
    <div className="monitor-strip" aria-label="哨兵">
      {error && <p role="alert">哨兵：{error}</p>}
      {shown.map((monitor) => (
        <MonitorRow key={monitor.id} monitor={monitor} stopping={stoppingIds.has(monitor.id)} onStop={onStop} />
      ))}
    </div>
  );
}

/**
 * 一行一个哨兵。单独成一个组件只因为 hooks：悬停提示要按行各持一份状态，
 * 不能在 `.map()` 里调 `useHoverTip`。
 *
 * 详情（命令原文、工作目录、结束原因）走应用内提示而不是原生 `title`——这一条是
 * 全局约定（`scripts/check-conventions.mjs` 会数）：任务页每秒都在重渲染，原生
 * tooltip 的悬停计时器被反复打断，气泡永远弹不出来。
 */
function MonitorRow({
  monitor,
  stopping,
  onStop,
}: {
  monitor: TaskMonitor;
  stopping: boolean;
  onStop: (monitorId: string) => void;
}) {
  const detail = useHoverTip();
  const stopTip = useHoverTip();
  const live = monitor.status === "running";
  return (
    <div className={`monitor-row${live ? " is-live" : ""}`}>
      <Pulse size={12} weight={live ? "fill" : "regular"} aria-hidden="true" />
      <b {...detail.anchorProps}>{monitor.description}</b>
      <HoverTip at={detail.at}>
        <>
          {monitor.command}
          <br />工作目录：{monitor.cwd}
          {monitor.endedReason ? <><br />{monitor.endedReason}</> : null}
        </>
      </HoverTip>
      <span>{monitor.events} 条事件</span>
      {live
        ? <em>盯到 {formatInstant(monitor.expiresAt)}</em>
        : (
          <em>
            {ENDED_LABEL[monitor.status] ?? monitor.status}
            {monitor.exitCode === null ? "" : `（退出码 ${monitor.exitCode}）`}
          </em>
        )}
      {live && (
        <>
          <button
            type="button"
            disabled={stopping}
            aria-label={`停掉哨兵“${monitor.description}”`}
            {...stopTip.anchorProps}
            onClick={() => { stopTip.hide(); onStop(monitor.id); }}
          >
            {stopping ? <SpinnerGap size={13} className="is-spinning" /> : <StopCircle size={13} weight="bold" />}
          </button>
          <HoverTip at={stopTip.at}>停掉这个哨兵（杀掉它的进程，不再唤醒任务）</HoverTip>
        </>
      )}
    </div>
  );
}

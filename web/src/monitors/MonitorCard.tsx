import { useCallback, useEffect, useRef, useState } from "react";
import { CaretRight, Pulse, SpinnerGap, StopCircle } from "@phosphor-icons/react";
import type { TaskMonitor } from "@ash/shared/monitor";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { api } from "../lib/api.ts";
import { formatInstant } from "../task-detail/utils.ts";
import { MONITOR_ENDED_LABEL } from "./useTaskMonitors.ts";

/** 展开着的那张卡每隔这么久重拉一次尾巴。只在「正在盯着」且「卡片是展开的」时才走。 */
const LOG_POLL_MS = 2500;

function useMonitorLog(monitorId: string, open: boolean, live: boolean) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 轮询里引用的是「这一刻还该不该拉」，所以 live 进 ref，避免定时器跟着它重建。
  const liveRef = useRef(live);
  liveRef.current = live;

  const load = useCallback(async () => {
    try {
      const tail = await api.monitorLog(monitorId);
      setLines(tail.lines);
      setTruncated(tail.truncated);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [monitorId]);

  useEffect(() => {
    if (!open) return;
    void load();
    if (!live) return;
    const timer = setInterval(() => { if (liveRef.current) void load(); }, LOG_POLL_MS);
    return () => clearInterval(timer);
  }, [live, load, open]);

  return { lines, truncated, error };
}

/**
 * 一个哨兵一张卡。要回答的就是那四句话：谁在盯、盯什么、盯到哪了、怎么让它停。
 *
 * 「看它的输出」是这张卡相对于一行摘要的全部意义：事件数只说明推了几次，而「0 条事件」
 * 既可能是命令还没开始吐，也可能是过滤条件写错了把什么都滤没了——这两件事的处理方式相反，
 * 不看原始输出分不出来。
 */
export function MonitorCard({
  monitor,
  stopping,
  onStop,
}: {
  monitor: TaskMonitor;
  stopping: boolean;
  onStop: (monitorId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const live = monitor.status === "running";
  const log = useMonitorLog(monitor.id, open, live);
  const stopTip = useHoverTip();
  const endedLabel = MONITOR_ENDED_LABEL[monitor.status] ?? monitor.status;
  // 结束原因常常就是那句状态标签本身（命令自己跑完了 / 盯满时长），一字不差时只说一遍。
  const reason = monitor.endedReason && monitor.endedReason !== endedLabel ? monitor.endedReason : null;

  return (
    <article className={`monitor-card${live ? " is-live" : " is-ended"}`}>
      <header>
        <Pulse size={13} weight={live ? "fill" : "regular"} aria-hidden="true" />
        <b>{monitor.description}</b>
        {live && (
          <>
            <button
              type="button"
              className="monitor-card__stop"
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
      </header>
      <code className="monitor-card__command">{monitor.command}</code>
      <p className="monitor-card__meta">
        <span>{monitor.events} 条事件</span>
        <span aria-hidden="true">·</span>
        <span>
          {live
            ? `盯到 ${formatInstant(monitor.expiresAt)}`
            : `${endedLabel}${monitor.exitCode === null ? "" : `（退出码 ${monitor.exitCode}）`}`}
        </span>
        {monitor.pid !== null && (
          <>
            <span aria-hidden="true">·</span>
            <span>pid {monitor.pid}</span>
          </>
        )}
      </p>
      {reason && <p className="monitor-card__reason">{reason}</p>}
      <p className="monitor-card__cwd">{monitor.cwd}</p>
      <button
        type="button"
        className={`monitor-card__toggle${open ? " is-open" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <CaretRight size={11} weight="bold" aria-hidden="true" />
        看它的输出
      </button>
      {open && (
        <div className="monitor-card__log">
          {log.error && <p role="alert">{log.error}</p>}
          {!log.error && log.lines === null && <p>读取中…</p>}
          {!log.error && log.lines?.length === 0 && <p>这个命令到现在一个字都还没吐。</p>}
          {log.lines && log.lines.length > 0 && (
            <>
              {log.truncated && <p>（只显示最后一段，更早的内容在哨兵的日志文件里）</p>}
              <pre>{log.lines.join("\n")}</pre>
            </>
          )}
        </div>
      )}
    </article>
  );
}

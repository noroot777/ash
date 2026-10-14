import { useCallback, useEffect, useRef, useState } from "react";
import { CaretRight, Pulse, SpinnerGap, StopCircle } from "@phosphor-icons/react";
import { canStopMonitor, hasMonitorLog, type TaskMonitor } from "@ash/shared/monitor";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { api } from "../lib/api.ts";
import { formatInstant } from "../task-detail/utils.ts";
import { MONITOR_ENDED_LABEL } from "./useTaskMonitors.ts";

/**
 * 还在盯着的那张卡，右上角那句「盯到什么时候」。
 *
 * **不能无脑写 `盯到 ${expiresAt}`**：claude 内置 Monitor 的期限是来源侧说了算的，而它
 * 可能是持续监听（没有到期时刻），也可能回执还没到（我们还不知道）。编一个确定时刻出来，
 * 用户会当真——第 2 轮审查实测来源侧会把请求的 1 小时钳成 30 分钟甚至 10 分钟。
 *
 * 第四种情况是**知道盯多久、但不知道从哪一刻起算**（历史重建时起点只是一个区间，见
 * shared/monitor.ts 的 MonitorStartEvidence）。那时说时长，不说时刻——上一版会按回执时刻
 * 编一个，而回执要等 PostToolUse hooks 跑完才生成，期限跟着往后漂。
 */
function liveDeadline(monitor: TaskMonitor): string {
  if (monitor.lifetime === "persistent") return "持续盯着（来源没设期限）";
  if (monitor.expiresAt) return `盯到 ${formatInstant(monitor.expiresAt)}`;
  if (monitor.lifetime === "bounded" && monitor.timeoutMs) return `总共盯 ${formatSpan(monitor.timeoutMs)}（起点不确定）`;
  return "盯到什么时候由它自己定";
}

/** 把毫秒说成人话。只给上面那句用。 */
function formatSpan(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} 小时`;
  if (ms % 60_000 === 0) return `${ms / 60_000} 分钟`;
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
  return `${Math.round(ms / 1000)} 秒`;
}

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
 *
 * **两种出身的卡不一样，而且差别必须看得见**（`kind`，语义见 shared/src/monitor.ts）：
 * claude 自带 `Monitor` 起的那种是一份只读投影，停不掉、没有日志、agent 进程一死就没。
 * 所以那种卡不渲染停止按钮、不渲染「看它的输出」，并明写一句它是谁起的、为什么只能看。
 * 把两种画成一模一样是这张卡最容易犯的错：用户会去点一个不存在的停止按钮，或者把
 * 「0 条事件」读成「过滤写错了」——而那种卡的事件数 ash 根本数不到。
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
  const stoppable = canStopMonitor(monitor.kind);
  const logged = hasMonitorLog(monitor.kind);
  // 只读投影没有日志可拉，连请求都不要发：那条路在服务端是按 kind 短路的，发过去只会
  // 拿回一个空数组，白白每 2.5 秒一次。
  const log = useMonitorLog(monitor.id, open && logged, live);
  const stopTip = useHoverTip();
  const endedLabel = MONITOR_ENDED_LABEL[monitor.status] ?? monitor.status;
  // 结束原因常常就是那句状态标签本身（命令自己跑完了 / 盯满时长），一字不差时只说一遍。
  const reason = monitor.endedReason && monitor.endedReason !== endedLabel ? monitor.endedReason : null;

  return (
    <article className={`monitor-card${live ? " is-live" : " is-ended"}`}>
      <header>
        <Pulse size={13} weight={live ? "fill" : "regular"} aria-hidden="true" />
        <b>{monitor.description}</b>
        {monitor.kind === "claude" && <span className="monitor-card__origin">claude 自带</span>}
        {live && stoppable && (
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
        {/* 事件数只有 ash 自己起的那种数得准：claude 把事件直接注回它自己的会话，
            ash 看不到几条，显示一个恒为 0 的「0 条事件」只会被读成「过滤写错了」。 */}
        {logged && (
          <>
            <span>{monitor.events} 条事件</span>
            <span aria-hidden="true">·</span>
          </>
        )}
        <span>
          {live ? liveDeadline(monitor) : `${endedLabel}${monitor.exitCode === null ? "" : `（退出码 ${monitor.exitCode}）`}`}
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
      {!logged && (
        <p className="monitor-card__readonly">
          这是智能体自己起的 Monitor，ash 只能看不能停——它的进程在智能体的进程树里，
          输出也直接进了它自己的会话。{live ? "起它的那个智能体进程结束时，它会跟着消失。" : ""}
        </p>
      )}
      {logged && (
        <button
          type="button"
          className={`monitor-card__toggle${open ? " is-open" : ""}`}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <CaretRight size={11} weight="bold" aria-hidden="true" />
          看它的输出
        </button>
      )}
      {open && logged && (
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

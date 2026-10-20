import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { CaretRight, Pulse, SpinnerGap, StopCircle } from "@phosphor-icons/react";
import { canStopMonitor, hasMonitorLog, type TaskMonitor } from "@ash/shared/monitor";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { api } from "../lib/api.ts";
import { formatInstant } from "../task-detail/utils.ts";
import { claudeMonitorEpilogue, liveDeadline } from "./monitorCopy.ts";
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
  //
  // **跟描述一字不差的也不说**：claude 在回合收尾成批停止时，`summary` 填的就是那条描述
  // 本身，于是卡片会变成「已停止 / 等待全量 unittest 跑完」——描述复读一遍，真正发生的事
  // （它是被收走的、那件事当时还没有结果）一个字都没有。服务端新写的行已经归一过
  // （shared 的 `claudeMonitorEndedReason`），这一道是给存量行的，它们不会自愈。
  const reason = monitor.endedReason
    && monitor.endedReason !== endedLabel
    && monitor.endedReason !== monitor.description
    ? monitor.endedReason
    : null;

  /**
   * 那一行小字，按**时间顺序**排：起于 → 盯到什么时候 / 什么时候结束的 → 结局，
   * 后面才挂事件数和 pid（只有 ash 自己起的那种才有）。
   *
   * **「起于」每张卡都给**（用户 2026-10-20 要的「创建的时间」）：在这之前整张卡上**一个
   * 绝对时刻都没有** —— 还在盯的那张只说「盯到 X」，结束的那张只剩一个状态词。于是最该
   * 一眼看见的那件事反而查不到：**这条哨兵是不是会话里那句「我挂了监听」对应的那一条**。
   * 一个任务上并排躺着四五条描述相近的哨兵时，没有起点就只能去翻库对账。
   *
   * 取的是 `startedAt` —— 全系统拿来计时的那个起点本身（到期时刻就是它加上时长算出来的）。
   * claude 投影那种由服务端按 `task_started` 事件或回执区间定，本机全部样本的不确定度都在
   * 百毫秒量级，分钟粒度上看不出来（证据档位见 shared/src/monitor.ts 的 MonitorStartEvidence）。
   *
   * 结束的那张顺带把**结束时刻**也给出来：「起于」单给会立刻引出下一个问题（那它跑了多久、
   * 是不是在我离开之后才停的），而答案就在同一份 DTO 里（`endedAt`）。
   */
  const startedLabel = formatInstant(monitor.startedAt);
  const endedTimeLabel = formatInstant(monitor.endedAt);
  const metaSegments = [
    // 时刻拿不出来时整段不给，而不是留一个「起于 」的半截（formatInstant 对坏值回空串）。
    startedLabel ? `起于 ${startedLabel}` : null,
    live ? liveDeadline(monitor) : null,
    !live && endedTimeLabel ? `结束于 ${endedTimeLabel}` : null,
    live ? null : `${endedLabel}${monitor.exitCode === null ? "" : `（退出码 ${monitor.exitCode}）`}`,
    // 事件数只有 ash 自己起的那种数得准：claude 把事件直接注回它自己的会话，ash 看不到
    // 几条，显示一个恒为 0 的「0 条事件」只会被读成「过滤写错了」。
    logged ? `${monitor.events} 条事件` : null,
    monitor.pid === null ? null : `pid ${monitor.pid}`,
  ].filter((segment): segment is string => !!segment);

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
        {metaSegments.map((segment, index) => (
          <Fragment key={`${index}-${segment}`}>
            {index > 0 && <span aria-hidden="true">·</span>}
            <span>{segment}</span>
          </Fragment>
        ))}
      </p>
      {reason && <p className="monitor-card__reason">{reason}</p>}
      <p className="monitor-card__cwd">{monitor.cwd}</p>
      {!logged && (
        <p className="monitor-card__readonly">
          这是智能体自己起的 Monitor，ash 只能看不能停——它的进程在智能体的进程树里，
          输出也直接进了它自己的会话。
          {/* 结束之后这句话要换一半：光一个「已停止」读起来像「等到了然后停了」，而实测
              绝大多数是回合一结束就被 CLI 成批收走，它盯的那件事当时还在跑（整段实测行序
              在 server/src/claude-monitor-reaped.ts 的文件头）。用户来这张卡上找的正是
              「那它为什么没叫醒谁」——必须在这儿答，不能只留一个状态词，也不能把四种结束
              方式说成同一种（第 4 轮审查 N1，措辞在 monitorCopy.ts）。 */}
          {live
            ? "起它的那个智能体进程结束时，它会跟着消失。"
            : claudeMonitorEpilogue(monitor.status)}
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

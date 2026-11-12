import { Fragment, forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { CaretRight, Pulse, SpinnerGap } from "@phosphor-icons/react";
import { canStopMonitor, hasMonitorLog, type TaskMonitor } from "@ash/shared/monitor";
import { endConditionNote } from "@ash/shared/monitor-end-condition";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { api } from "../lib/api.ts";
import { InspButton } from "../inspector/parts.tsx";
import { formatDurationShort, formatInstant } from "../task-detail/utils.ts";
import { claudeMonitorEpilogue, emptyLogCopy, liveDeadline, startedAtLabel } from "./monitorCopy.ts";
import { MONITOR_ENDED_LABEL } from "./useTaskMonitors.ts";

/** 展开着的那张卡每隔这么久重拉一次尾巴。只在「正在盯着」且「卡片是展开的」时才走。 */
const LOG_POLL_MS = 2500;

function useMonitorLog(monitorId: string, open: boolean, live: boolean) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  // 日志文件这一刻多大。`null` = 读不出来（或者老后端没这一列）—— 跟 0 不是一回事,空行
  // 列表的三种来由只有它分得开（第 1 轮审查 F4，见 `emptyLogCopy`）。
  // **三态**（第 2 轮审查 N3）：`undefined` = 这个后端没给这一项（旧版本），`null` = 后端说它
  // 读不出来，数字 = 实测大小。归一成两态就等于拿「字段不在」冒充「读失败」。
  const [bytes, setBytes] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // 轮询里引用的是「这一刻还该不该拉」，所以 live 进 ref，避免定时器跟着它重建。
  const liveRef = useRef(live);
  liveRef.current = live;

  const load = useCallback(async () => {
    try {
      const tail = await api.monitorLog(monitorId);
      setLines(tail.lines);
      setTruncated(tail.truncated);
      setBytes(tail.bytes);
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

  return { lines, truncated, bytes, error };
}

/** 在盯着的那张卡，用时每秒走一格；结束了的不起定时器。 */
function useNow(active: boolean): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return Date.now();
}

/** 跑了多久。起点不作数的那种（历史投影的占位值）不算：拿占位值减出来的时长同样会被当真。 */
function tookText(monitor: TaskMonitor, live: boolean, now: number): string | null {
  if (!monitor.startedAtExact) return null;
  const from = Date.parse(monitor.startedAt);
  const to = live ? now : Date.parse(monitor.endedAt ?? "");
  return Number.isFinite(from) && Number.isFinite(to) ? formatDurationShort(Math.max(0, to - from)) : null;
}

/**
 * 一个哨兵一张卡。默认只回答四件事：盯什么、什么状态、跑了多久、几点起的；命令原文、
 * 工作目录、事件数这些对账用的细节收在「命令」里，原始输出收在「输出」里，点开才铺。
 *
 * 「看它的输出」是这张卡相对于一行摘要的全部意义：事件数只说明推了几次，而「0 条事件」
 * 既可能是命令还没开始吐，也可能是过滤条件写错了把什么都滤没了——这两件事的处理方式相反，
 * 不看原始输出分不出来。
 *
 * **两种出身的卡不一样，而且差别必须看得见**（`kind`，语义见 shared/src/monitor.ts）：
 * claude 自带 `Monitor` 起的那种是一份只读投影，停不掉、没有日志、agent 进程一死就没。
 * 所以那种卡不渲染停止按钮、不渲染「输出」，并在细节里明写一句它是谁起的、为什么只能看。
 * 把两种画成一模一样是这张卡最容易犯的错：用户会去点一个不存在的停止按钮，或者把
 * 「0 条事件」读成「过滤写错了」——而那种卡的事件数 ash 根本数不到。
 *
 * 会话里那一轮挂上的哨兵就是这里的一张卡：会话那一行点「在哨兵格里看」带着它的 id 过来，
 * 这一格把它滚进视野并把焦点放上去（MonitorInspector 收那份请求）。
 */
export const MonitorCard = forwardRef<HTMLElement, {
  monitor: TaskMonitor;
  stopping: boolean;
  onStop: (monitorId: string) => void;
  /**
   * 任务这会儿是暂停的（多半就是在等哨兵）。这时停掉它的说法是「不等了」：哨兵收工，
   * 任务原样留在暂停，不会因此被叫醒，也不会被结掉。
   */
  waiting?: boolean;
}>(function MonitorCard({ monitor, stopping, onStop, waiting = false }, ref) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const live = monitor.status === "running";
  const stoppable = canStopMonitor(monitor.kind);
  const logged = hasMonitorLog(monitor.kind);
  const now = useNow(live);
  // 只读投影没有日志可拉，连请求都不要发：那条路在服务端是按 kind 短路的，发过去只会
  // 拿回一个空数组，白白每 2.5 秒一次。
  const log = useMonitorLog(monitor.id, open && logged, live);
  const stopTip = useHoverTip();
  const descTip = useHoverTip();
  /**
   * **结果还欠着的那一类,得有一个人点得到的出路**（第 2 轮审查 N3）。
   *
   * 完成闸的第三类是「结局已经写定、那条结束通知还没持久入队」。正常它只闪一下就没了,
   * 入队那一笔失败时才会一直留着 —— 而那正是用户撞上「完成被一条已经结束的哨兵堵住」的
   * 时刻。在这之前这一类**两处入口都没有**:还没入队所以不在待发送托盘里,已经结束所以
   * 卡片也不给它渲染按钮,只剩「让 agent 调 stop_monitor」—— 而人点不了 MCP 工具。
   *
   * 点下去走的是同一个停止端点:对一条已经结束的哨兵,它什么状态都不改,只落下「它还没送到
   * 的结果我不要了」（server/src/monitor-stop.ts 的 `abandonResults`）。所以措辞也必须是
   * 「不再等它的结果」而不是「停掉」—— 进程早就没了。
   */
  const owesResult = !live && stoppable && !!monitor.resultHandoffAt && !monitor.resultsAbandonedAt;
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
   * 露在外面那一行：状态 · 跑了多久 · 几点起的（按这个顺序，一张卡只说这几样）。
   *
   * **起点那一段每张卡都给**（用户 2026-10-20 要的「创建的时间」）：没有它，最该一眼看见
   * 的那件事反而查不到——**这条哨兵是不是会话里那句「我挂了监听」对应的那一条**。一个任务
   * 上并排躺着四五条描述相近的哨兵时，没有起点就只能去翻库对账。
   *
   * 「每张卡都给」指的是**这一段永远在**，不是「永远给得出一个时刻」：答不出来时它明说答
   * 不出来。时刻**不能直接读 `startedAt` 画出来**：那一列在历史投影上允许退化成占位值，
   * 而退化值照样是个合法日期。判据和措辞都归 `startedAtLabel`（见它的注释，以及 shared 的
   * `startedAtExact`）—— 答不出来时它说「挂上的时刻不确定」，不编一个会被当真的时刻。
   *
   * 「完成被它堵着」也露在外面：用户看到的是一个已经结束的哨兵，而任务那边的
   * `complete_task` 正被它拦着（完成闸第三类）。收进细节里的话，两处现象对不上。
   */
  const took = tookText(monitor, live, now);
  const summary: { text: string; live?: boolean; bad?: boolean }[] = [
    live
      ? { text: "在盯", live: true }
      : { text: `${endedLabel}${monitor.exitCode === null ? "" : `（退出码 ${monitor.exitCode}）`}` },
    ...(took ? [{ text: took }] : []),
    ...(startedAtLabel(monitor) ? [{ text: startedAtLabel(monitor)! }] : []),
    ...(owesResult ? [{ text: "结果还没送到，完成被它堵着", bad: true }] : []),
  ];

  /**
   * 收在「命令」里的那一行对账细节，按**时间顺序**排：盯到什么时候 / 什么时候结束的 →
   * 约定的结束条件，后面才挂事件数和 pid（只有 ash 自己起的那种才有）。
   */
  const endedTimeLabel = formatInstant(monitor.endedAt);
  const facts = [
    // 起点那一段已经自己说了「不确定」，这里就不要再带一遍那句括号。
    live ? liveDeadline(monitor, { startSaidSeparately: true }) : null,
    // **约定的结束条件有就给**：还在盯的那张靠它回答「它到底什么时候叫我」——光一个
    // 「盯到 X」会被读成「只能等到那时候」。已经结束的那张也要给：`expired` + 有条件
    // 合起来才说得出「它等的那一行始终没出现」。措辞归 `endConditionNote`：库里那个值
    // 可能是这一版读不出来的，那它就**不会**提前收工（第 2 轮审查 F2）。
    monitor.stopWhen ? endConditionNote(monitor.stopWhen) : null,
    !live && endedTimeLabel ? `结束于 ${endedTimeLabel}` : null,
    // 事件数只有 ash 自己起的那种数得准：claude 把事件直接注回它自己的会话，ash 看不到
    // 几条，显示一个恒为 0 的「0 条事件」只会被读成「过滤写错了」。
    logged ? `${monitor.events} 条事件` : null,
    monitor.pid === null ? null : `pid ${monitor.pid}`,
    monitor.resultsAbandonedAt ? "已放弃它没送到的结果" : null,
  ].filter((segment): segment is string => !!segment);

  const stopLabel = live ? (waiting ? "不等了" : "停掉") : "不等了";
  const stopTipText = live
    ? waiting
      ? "停掉这个哨兵，任务留在暂停，不会被叫醒"
      : "杀掉它的进程，不再唤醒任务"
    : "不再等它的结果（它早就结束了，这一下只撤掉「必须先收下它的结果」这条放行条件）";

  return (
    <article ref={ref} tabIndex={-1} data-monitor={monitor.id} className={`monitor-card${live ? " is-live" : " is-ended"}`}>
      <header>
        <Pulse size={14} weight={live ? "fill" : "regular"} aria-hidden="true" />
        <b className="insp-cut" {...descTip.anchorProps}>{monitor.description}</b>
        <HoverTip at={descTip.at}>{monitor.description}</HoverTip>
        {((live && stoppable) || owesResult) && (
          <>
            <InspButton
              size="sm"
              className="monitor-card__stop"
              disabled={stopping}
              aria-label={live ? `停掉哨兵“${monitor.description}”` : `不再等哨兵“${monitor.description}”的结果`}
              {...stopTip.anchorProps}
              onClick={() => { stopTip.hide(); onStop(monitor.id); }}
            >
              {stopping && <SpinnerGap size={12} className="is-spinning" aria-hidden="true" />}
              {stopLabel}
            </InspButton>
            <HoverTip at={stopTip.at}>{stopTipText}</HoverTip>
          </>
        )}
      </header>
      <p className="monitor-card__meta">
        {summary.map((segment, index) => (
          <Fragment key={`${index}-${segment.text}`}>
            {index > 0 && <span aria-hidden="true">·</span>}
            <span className={segment.live ? "insp-live" : segment.bad ? "insp-bad" : undefined}>{segment.text}</span>
          </Fragment>
        ))}
      </p>
      <div className="monitor-card__folds">
        <button
          type="button"
          className="monitor-card__fold"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((current) => !current)}
        >
          <CaretRight size={12} aria-hidden="true" />
          命令
        </button>
        {logged && (
          <button
            type="button"
            className="monitor-card__fold monitor-card__toggle"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            <CaretRight size={12} aria-hidden="true" />
            输出
          </button>
        )}
      </div>
      {/* 收着时也留在 DOM 里（只是 hidden）：命令原文、目录这些是读屏和页内查找也要找得到的。 */}
      <div className="monitor-card__details" hidden={!detailsOpen}>
        <code className="monitor-card__command">{monitor.command}</code>
        <p className="monitor-card__cwd">在 {monitor.cwd} 里跑</p>
        {facts.length > 0 && (
          <p className="monitor-card__facts">
            {facts.map((segment, index) => (
              <Fragment key={`${index}-${segment}`}>
                {index > 0 && <span aria-hidden="true">·</span>}
                <span>{segment}</span>
              </Fragment>
            ))}
          </p>
        )}
        {reason && <p className="monitor-card__reason">{reason}</p>}
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
      </div>
      {open && logged && (
        <div className="monitor-card__log">
          {log.error && <p role="alert">{log.error}</p>}
          {!log.error && log.lines === null && <p>读取中…</p>}
          {!log.error && log.lines?.length === 0 && <p>{emptyLogCopy(monitor, live, log.bytes)}</p>}
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
});

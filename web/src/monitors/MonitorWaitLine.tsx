// 「在等哨兵」那一行：任务停下来等哨兵时，最近那一回合的最后一行（docs/ui-ux-audit feed-7）。
//
// 等的时候任务是暂停的，状态机一个字不改：这一行只是把「它为什么不动」说在会话里——
// 在等谁、等了多久、最迟等到几点。字上没有流光（没有东西在跑）。点开是等到以后它接着做
// 什么，和两条出路：不等了（停掉哨兵，任务留在暂停）、去哨兵格看它的输出。
//
// 原来这件事是回复框上方常驻的一条（用户 2026-10-16 要它「主会话里看得见」，这一版仍然
// 看得见，只是挪进了会话最后、不再占着回复框上面那一行）。点开之后的那几段说明照旧：
//
// **「在等」只算 ash 自己起的那些**：claude 内置 Monitor 的通知只注回它那一轮的会话，
// 回合一结束就跟着没了，ash 这边够不着任何唤醒通道 —— 把它算进「在等」就是让用户等一件
// 不会来的事。但也不能当它不存在（agent 明明在对话里说了「已挂监听」），所以它单独说，
// 说清它是什么、以及它不会把任务叫醒。
import { useEffect, useId, useState } from "react";
import { Pulse } from "@phosphor-icons/react";
import { canStopMonitor, type TaskMonitor } from "@ash/shared/monitor";
import { api } from "../lib/api.ts";
import { formatDuration } from "../task-detail/utils.ts";
import { liveDeadline } from "./monitorCopy.ts";

export function MonitorWaitLine({
  monitors,
  builtinCount,
  resumePrompt,
  reviewArmed,
  onOpenPanel,
  notify,
}: {
  /** ash 自己起的、还在盯着的那些（调用方只传 live 的那几条）。 */
  monitors: readonly TaskMonitor[];
  /** 同一时刻 claude 内置 Monitor 里还显示「在跑」的条数（它们不会唤醒任务）。 */
  builtinCount: number;
  /** agent 用 `pause_task` 留下的续跑交代；非空 = 这一轮是它自己安排的等待。 */
  resumePrompt: string | null;
  /** 这个任务上有一条已预约、还没开跑的审查。 */
  reviewArmed: boolean;
  onOpenPanel: () => void;
  notify?: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const bodyId = useId();
  const now = useTicker(monitors.length > 0);
  if (!monitors.length && !builtinCount) return null;
  const builtinOnly = !monitors.length;
  const reviewerOnly = monitors.length > 0 && monitors.every((monitor) => monitor.sourceRole === "reviewer");
  // pid 还空着的那几条：ash 这一刻认不回它的进程（重启恰好打断了「落身份 → 起进程 → 回填 pid」
  // 那一步，见 server/src/monitor-adopt.ts）。接回层照样给它立了 tail 和期限，所以「有事件会叫醒、
  // 到点会收尾」对它们也是真的；认不回号真正影响的是另一件事 —— 点停未必停得掉那个进程。
  // 原因照抄 `endedReason`：措辞分「正在自己重问」和「重问到最后一档仍认不回来」两种。
  const unclaimed = monitors.filter((monitor) => monitor.pid === null && monitor.endedReason);
  const first = monitors[0];
  const name = first ? `${first.description}${monitors.length > 1 ? ` +${monitors.length - 1}` : ""}` : "";
  const waited = earliestStart(monitors);
  const stoppable = monitors.filter((monitor) => canStopMonitor(monitor.kind));

  const quit = async () => {
    setStopping(true);
    try {
      for (const monitor of stoppable) await api.stopMonitor(monitor.id, "用户在会话里点了「不等了」");
      setOpen(false);
    } catch (reason) {
      notify?.(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStopping(false);
    }
  };

  return (
    <section className={`monitor-wait-line${builtinOnly ? " is-builtin-only" : ""}`} aria-label="任务的哨兵">
      <button
        type="button"
        className="monitor-wait-line__bar"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((current) => !current)}
      >
        <Pulse size={13} aria-hidden="true" />
        <span className="monitor-wait-line__label">
          {builtinOnly ? `${builtinCount} 个内置 Monitor 在跑，不会叫醒任务` : `在等哨兵「${name}」`}
        </span>
        {waited !== null && <span className="monitor-wait-line__time">等了 {formatDuration(now - waited)}</span>}
        {first && monitors.length === 1 && dueLabel(first) && <span className="monitor-wait-line__due">{dueLabel(first)}</span>}
      </button>
      {open && (
        <div className="monitor-wait-line__body" id={bodyId}>
          {monitors.length > 1 && (
            <ul className="monitor-wait-line__list">
              {monitors.map((monitor) => (
                <li key={monitor.id}>
                  <span>{monitor.description}</span>
                  <span className="monitor-wait-line__due">{dueLabel(monitor) ?? liveDeadline(monitor)}</span>
                </li>
              ))}
            </ul>
          )}
          {builtinOnly ? (
            <p>
              这几个是智能体用 claude 自带的 <code>Monitor</code> 起的：进程在它自己那一轮里，
              通知也只注回那条会话 —— <b>它们不会把这个任务叫醒</b>，回合一结束就跟着被收走。
              要跨回合等一件事，得用 ash 的哨兵（<code>start_monitor</code>）并用 <code>pause_task</code> 收尾那一轮。
            </p>
          ) : (
            <p>
              有事件时会把{reviewerOnly ? "审查那条会话" : "这条会话"}重新叫醒。
              {resumePrompt
                // 交代原文照抄：它是 agent 对**自己**说的话，用户要判断的恰恰是「醒了之后它会接着做什么」。
                ? <> 等到以后：<q>{resumePrompt}</q></>
                : <> 这一轮没留下续跑交代，醒来时它只会收到事件正文。</>}
              {reviewArmed && <> 已预约的审查会等这件事落地、任务续跑结束之后再开始。</>}
              {builtinCount > 0 && <> 另有 {builtinCount} 个 claude 内置 Monitor 在智能体自己那一轮里跑着，它们不会唤醒任务。</>}
            </p>
          )}
          {unclaimed.length > 0 && (
            <p className="is-stuck">
              其中 {unclaimed.length} 个 ash <b>这一刻认不回它的进程</b>：重启恰好打断了起进程那一步，
              所以它从来没收到过信号。日志和期限照旧有人接着管（有结果会照常叫醒你、到点照常
              收尾），但在认回来之前<b>点停未必停得掉那个进程</b> —— 那一步要先认得出它的号。
              <q>{unclaimed[0]!.endedReason}</q>
            </p>
          )}
          <p className="monitor-wait-line__acts">
            {stoppable.length > 0 && (
              <button type="button" disabled={stopping} onClick={() => void quit()}>不等了</button>
            )}
            <button type="button" onClick={onOpenPanel}>在哨兵格里看</button>
          </p>
        </div>
      )}
    </section>
  );
}

/** 最迟等到几点。算不出确切时刻时退回原来那句（总共盯多久、起点不确定），持续盯着的不说。 */
function dueLabel(monitor: TaskMonitor): string | null {
  if (monitor.lifetime === "persistent") return null;
  const at = monitor.expiresAt
    ?? (monitor.lifetime === "bounded" && monitor.timeoutMs && monitor.startedAtExact
      ? new Date(Date.parse(monitor.startedAt) + monitor.timeoutMs).toISOString()
      : null);
  if (!at) return monitor.lifetime === "bounded" && monitor.timeoutMs ? liveDeadline(monitor) : null;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  const two = (number: number) => String(number).padStart(2, "0");
  const sameDay = date.toDateString() === new Date().toDateString();
  return `最迟 ${sameDay ? "" : `${two(date.getMonth() + 1)}/${two(date.getDate())} `}${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** 等了多久从哪一刻数：最早那个确切的起点。起点不作数的（历史投影上的占位值）不拿来数。 */
function earliestStart(monitors: readonly TaskMonitor[]): number | null {
  const starts = monitors
    .filter((monitor) => monitor.startedAtExact)
    .map((monitor) => Date.parse(monitor.startedAt))
    .filter(Number.isFinite);
  return starts.length ? Math.min(...starts) : null;
}

function useTicker(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}

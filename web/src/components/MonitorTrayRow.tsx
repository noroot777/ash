import { useState } from "react";
import { ArrowSquareOut, X } from "@phosphor-icons/react";
import { canStopMonitor, type TaskMonitor } from "@ash/shared/monitor";
import { monitorWhen } from "../monitors/monitorTray.ts";
import { MonitorMark } from "./MonitorMark.tsx";
import { RevealButton } from "./ScheduledMessageRow.tsx";

/** 托盘里哨兵那几行要的东西（TaskDetail 给；团队回复框不给，那边没有哨兵）。 */
export type TrayMonitors = {
  /** 还在盯的那几个：ash 自己起的 + claude 内置 Monitor 的只读投影。 */
  live: readonly TaskMonitor[];
  /** 任务此刻在跑一轮（或排着队要跑）：哨兵是这一轮里挂上的，不是在「等」它。 */
  running: boolean;
  /** agent 用 `pause_task` 留下的续跑交代；在等的时候照抄进说明。 */
  resumePrompt: string | null;
  /** 这个任务上有一条已预约、还没开跑的审查。 */
  reviewArmed: boolean;
  onOpen: (monitorId: string) => void;
  onStop: (monitor: TaskMonitor) => Promise<void>;
};

/**
 * 托盘里一个还在盯的哨兵：跟排队消息同一张网格上的一行——谁（在盯 / 在等 / 内置）· 盯什么 ·
 * 盯了多久、最迟几点 · 行尾的键（在哨兵格里看、停掉），键指到这一行才出。点「盯什么」就地摊开：
 * 命令原文，等到以后它接着做什么，还有认不回进程时那句实话。
 */
export function MonitorTrayRow({ monitor, monitors, now, open, bodyId, onToggle }: {
  monitor: TaskMonitor;
  monitors: TrayMonitors;
  now: number;
  open: boolean;
  bodyId: string;
  onToggle: () => void;
}) {
  const [stopping, setStopping] = useState(false);
  const { running } = monitors;
  const builtin = monitor.kind !== "ash";
  const stoppable = canStopMonitor(monitor.kind);
  const stopWord = running ? "停掉" : "不等了";
  const stop = async () => {
    setStopping(true);
    try { await monitors.onStop(monitor); } finally { setStopping(false); }
  };
  return <div className={`scheduled-message-item is-monitor${stopping ? " is-busy" : ""}`} data-monitor-id={monitor.id}>
    <div className="scheduled-message-row">
      <span className="scheduled-message-source">
        <MonitorMark state={builtin ? "builtin" : "live"} />{builtin ? "内置" : running ? "在盯" : "在等"}
      </span>
      <button type="button" className="scheduled-message-summary" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        {monitor.description}
      </button>
      <span className="scheduled-message-when">{monitorWhen(monitor, running, now)}</span>
      <span className="scheduled-message-actions">
        <RevealButton className="scheduled-message-open" busy={false} spinning={false} tip="在哨兵格里看"
          label={`在右侧哨兵格里看「${monitor.description}」`} onClick={() => monitors.onOpen(monitor.id)}>
          <ArrowSquareOut size={12} weight="bold" aria-hidden="true" />
        </RevealButton>
        {stoppable && <RevealButton className="scheduled-message-cancel" busy={stopping} spinning={stopping} tip={stopWord}
          label={`${stopWord}：哨兵「${monitor.description}」`} onClick={() => void stop()}>
          <X size={12} weight="bold" aria-hidden="true" />
        </RevealButton>}
      </span>
    </div>
    {open && <div id={bodyId} className="scheduled-message-full">
      <div className="scheduled-message-body scheduled-monitor-body">
        <code>{monitor.command}</code>
        <MonitorNote monitor={monitor} monitors={monitors} />
      </div>
    </div>}
  </div>;
}

function MonitorNote({ monitor, monitors }: { monitor: TaskMonitor; monitors: TrayMonitors }) {
  const { running, resumePrompt, reviewArmed } = monitors;
  if (monitor.kind !== "ash") {
    return <p>
      智能体用 claude 自带的 <code>Monitor</code> 起的：进程在它自己那一轮里，通知也只注回那条会话 ——
      <b>它不会把这个任务叫醒</b>，回合一结束就跟着被收走。要跨回合等一件事，得用 ash 的哨兵（<code>start_monitor</code>）
      并用 <code>pause_task</code> 收尾那一轮。
    </p>;
  }
  const session = monitor.sourceRole === "reviewer" ? "审查那条会话" : "这条会话";
  // pid 还空着：ash 这一刻认不回它的进程（重启恰好打断了「落身份 → 起进程 → 回填 pid」那一步，
  // 见 server/src/monitor-adopt.ts）。接回层照样给它立了 tail 和期限，所以「有事件会叫醒、到点会收尾」
  // 对它也是真的；认不回号真正影响的是另一件事 —— 点停未必停得掉那个进程。原因照抄 `endedReason`。
  const unclaimed = monitor.pid === null && !!monitor.endedReason;
  return <>
    {running
      ? <p>这一轮里挂上的：有事件先排着，这一轮跑完再送进{session}。</p>
      : <p>
        有事件时会把{session}重新叫醒。
        {/* 交代原文照抄：它是 agent 对自己说的话，用户要判断的恰恰是「醒了之后它会接着做什么」。 */}
        {resumePrompt ? <> 等到以后：<q>{resumePrompt}</q></> : <> 这一轮没留下续跑交代，醒来时它只会收到事件正文。</>}
        {reviewArmed && <> 已预约的审查会等这件事落地、任务续跑结束之后再开始。</>}
      </p>}
    {unclaimed && <p className="is-stuck">
      ash <b>这一刻认不回它的进程</b>：重启恰好打断了起进程那一步，所以它从来没收到过信号。日志和期限照旧有人接着管
      （有结果会照常叫醒你、到点照常收尾），但在认回来之前<b>点停未必停得掉那个进程</b> —— 那一步要先认得出它的号。
      <q>{monitor.endedReason}</q>
    </p>}
  </>;
}

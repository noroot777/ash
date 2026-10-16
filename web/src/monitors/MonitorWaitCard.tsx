// 会话区底部那条「这个任务正在等哨兵」。
//
// 为什么不能只放在 inspector 里（用户 2026-10-16 指出）：哨兵往往就是**任务此刻为什么
// 不动**的全部原因，而 inspector 是一格要自己点开的面板。只写在那儿的话，主会话区最后
// 一条是 agent 说的「我挂了监听，等它叫我」，然后一片空白 —— 用户刷新页面后只会疑惑
// 「它到底在干什么、还会不会醒」，而这正是哨兵这件事最需要被看见的那一刻。
//
// 所以这张卡把三件事摊在同一个视野里：**在等谁**（每个哨兵在盯什么、盯到什么时候）、
// **醒了会怎样**（事件会把这条会话叫醒，agent 留的续跑交代会一起喂回去）、以及
// **已经预约的审查会不会跟着等**（会；它要看的是这件事落地之后的工作区）。
import { ArrowRight, Pulse } from "@phosphor-icons/react";
import type { TaskMonitor } from "@ash/shared/monitor";
import { liveDeadline } from "./monitorCopy.ts";

export function MonitorWaitCard({
  monitors,
  status,
  resumePrompt,
  reviewArmed,
  onOpenPanel,
}: {
  /** 还在盯着的那些（调用方只传 live 的那几条；空数组时这张卡不该被渲染）。 */
  monitors: readonly TaskMonitor[];
  /** 任务此刻的状态：决定这张卡说「等着被叫醒」还是「事件排着队等这一轮跑完」。 */
  status: string;
  /** agent 用 `pause_task` 留下的续跑交代；非空 = 这一轮是它自己安排的等待。 */
  resumePrompt: string | null;
  /** 这个任务上有一条已预约、还没开跑的审查。 */
  reviewArmed: boolean;
  onOpenPanel: () => void;
}) {
  if (!monitors.length) return null;
  // 任务自己还在跑时，哨兵事件不会打断它 —— 投递要等这一轮退干净（deliveryVerdict 对
  // running/queued 的单飞任务一律判「等」）。这时说「会把会话叫醒」是错的：没人睡着。
  const busy = status === "running" || status === "queued";
  const reviewerOnly = monitors.every((monitor) => monitor.sourceRole === "reviewer");
  return (
    <article className="monitor-wait" aria-label="任务正在等哨兵">
      <header>
        <Pulse size={13} weight="fill" aria-hidden="true" />
        <b>在等 {monitors.length} 个哨兵</b>
        <button type="button" className="monitor-wait__open" onClick={onOpenPanel}>
          哨兵面板 <ArrowRight size={11} weight="bold" aria-hidden="true" />
        </button>
      </header>
      <ul className="monitor-wait__list">
        {monitors.map((monitor) => (
          <li key={monitor.id}>
            <span className="monitor-wait__what">{monitor.description}</span>
            <span className="monitor-wait__when">{liveDeadline(monitor)}</span>
          </li>
        ))}
      </ul>
      <p className="monitor-wait__note">
        它的进程由 ash 自己起，活得过这一回合。
        {busy
          ? <> 任务这一轮还在跑，事件会排着队等它空下来再送进会话。</>
          : <>
            {" "}有事件时会把{reviewerOnly ? "审查那条会话" : "这条会话"}重新叫醒。
            {resumePrompt
              // 交代原文照抄：它是 agent 对**自己**说的话，概括一下就没用了（用户要判断的
              // 恰恰是「醒了之后它会接着做什么」）。
              ? <> 醒来时它留的这段交代会一起喂回去：<q>{resumePrompt}</q></>
              // 没留交代也不是故障，但得说清后果：醒来那一轮只有事件正文，别的全靠会话本身。
              : <> 这一轮没留下续跑交代，醒来时它只会收到事件正文。</>}
          </>}
        {reviewArmed && <> 已预约的审查会等这件事落地、任务续跑结束之后再开始。</>}
      </p>
    </article>
  );
}

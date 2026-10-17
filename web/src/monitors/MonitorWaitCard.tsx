// 回复框正上方那条「哨兵」。
//
// 为什么不能只放在 inspector 里（用户 2026-10-16 指出）：哨兵往往就是**任务此刻为什么
// 不动**的全部原因，而 inspector 是一格要自己点开的面板。只写在那儿的话，主会话区最后
// 一条是 agent 说的「我挂了监听，等它叫我」，然后一片空白 —— 用户刷新页面后只会疑惑
// 「它到底在干什么、还会不会醒」，而这正是哨兵这件事最需要被看见的那一刻。
//
// **默认是折叠的一条，不是摊开的卡**（用户 2026-10-16 指定了形态和落点：跟派审/预览
// 同一条 rail 上）。常驻的东西必须先便宜：摊开那张卡有四五行，任务一挂上哨兵就把输入
// 区往下压掉一截。而常驻要回答的其实只有一句——**还在等吗、等的是谁**，那一行就说完了。
// 其余三件（醒来会怎样、它留了什么续跑交代、预约的审查跟不跟着等）是用户**想起来要查**
// 时才看的，点开再说。
//
// **「在等」只算 ash 自己起的那些**：claude 内置 Monitor 的通知只注回它那一轮的会话，
// 回合一结束就跟着没了，ash 这边够不着任何唤醒通道 —— 把它算进「在等」就是让用户等一件
// 不会来的事。但也不能当它不存在（agent 明明在对话里说了「已挂监听」），所以它单独占
// 一行，说清它是什么、以及它不会把任务叫醒。两种分开说，不混排（同 MonitorInspector）。
import { useId, useState } from "react";
import { ArrowRight, CaretDown, Pulse } from "@phosphor-icons/react";
import type { TaskMonitor } from "@ash/shared/monitor";
import { liveDeadline } from "./monitorCopy.ts";

export function MonitorWaitCard({
  monitors,
  builtinCount,
  status,
  resumePrompt,
  reviewArmed,
  onOpenPanel,
}: {
  /** ash 自己起的、还在盯着的那些（调用方只传 live 的那几条）。 */
  monitors: readonly TaskMonitor[];
  /** 同一时刻 claude 内置 Monitor 里还显示「在跑」的条数（它们不会唤醒任务）。 */
  builtinCount: number;
  /** 任务此刻的状态：决定这张卡说「等着被叫醒」还是「事件排着队等这一轮跑完」。 */
  status: string;
  /** agent 用 `pause_task` 留下的续跑交代；非空 = 这一轮是它自己安排的等待。 */
  resumePrompt: string | null;
  /** 这个任务上有一条已预约、还没开跑的审查。 */
  reviewArmed: boolean;
  onOpenPanel: () => void;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  if (!monitors.length && !builtinCount) return null;
  // 内置那几个在跑、ash 这边一个都没有：这正是 Bp2LkwfRO37A 那一幕 —— agent 说「挂上了，
  // 结束会叫我」，而实际上没有任何东西会叫它。那时这张卡**只**说这件事，不说「在等」。
  const builtinOnly = !monitors.length;
  // 任务自己还在跑时，哨兵事件不会打断它 —— 投递要等这一轮退干净（deliveryVerdict 对
  // running/queued 的单飞任务一律判「等」）。这时说「会把会话叫醒」是错的：没人睡着。
  const busy = status === "running" || status === "queued";
  const reviewerOnly = monitors.every((monitor) => monitor.sourceRole === "reviewer");
  // **pid 还空着的那几条:ash 这一刻认不回它的进程**（重启恰好打断了「落身份 → 起进程 →
  // 回填 pid」那一步，见 server/src/monitor-adopt.ts 的 `notePendingIntent`）。这件事要说，
  // 但**不能再按「pid 空就没人读日志」说**（第 22 轮审查 N1：那是旧模型，同一段里一句
  // 「日志还没人读」、紧接着照抄的原因里又写着「日志和期限已经有人接着管」，两句话打架）。
  // 现在的事实是：接回层给每条运行行都先立 tail 和期限，跟认不认得回号无关（见
  // server/src/monitor-reattach.ts 的 `reattachMonitors`），所以「有事件会叫醒你、到点会
  // 收尾」对它们**也是真的**；认不回号真正影响的是另一件事 —— 点停未必停得掉那个进程。
  // 原因仍照抄 `endedReason`：措辞分「正在自己重问」和「重问到最后一档仍认不回来」两种，
  // 概括一下就把后者说成了前者。
  const unclaimed = monitors.filter((monitor) => monitor.pid === null && monitor.endedReason);
  // 折叠那一行只放**一眼要答的那句**：在等几个、头一个在盯什么、盯到什么时候。多于一个
  // 时只带头一个加「+N」——期限逐条不同，在一行里并排写出来只会互相干扰，展开有全的。
  const brief = builtinOnly
    ? "它们不会唤醒任务，回合一结束就跟着被收走"
    : monitors.length > 1
      ? `${monitors[0].description} +${monitors.length - 1}`
      : monitors[0].description;
  return (
    <section
      className={`monitor-wait${open ? " is-open" : ""}${builtinOnly ? " is-builtin-only" : ""}`}
      aria-label="任务的哨兵"
    >
      <button
        type="button"
        className="monitor-wait__bar"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((current) => !current)}
      >
        <Pulse size={13} weight={builtinOnly ? "regular" : "fill"} aria-hidden="true" />
        <b>{builtinOnly ? `${builtinCount} 个内置 Monitor 在跑` : `在等 ${monitors.length} 个哨兵`}</b>
        <span className="monitor-wait__brief">{brief}</span>
        {monitors.length === 1 && <span className="monitor-wait__when">· {liveDeadline(monitors[0])}</span>}
        <CaretDown size={11} weight="bold" className="monitor-wait__caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="monitor-wait__body" id={bodyId}>
          {/* 折叠那行只带了头一个，展开要把每一个都摊开（各自盯什么、盯到什么时候）。 */}
          {monitors.length > 0 && (
            <ul className="monitor-wait__list">
              {monitors.map((monitor) => (
                <li key={monitor.id}>
                  <span className="monitor-wait__what">{monitor.description}</span>
                  <span className="monitor-wait__when">{liveDeadline(monitor)}</span>
                </li>
              ))}
            </ul>
          )}
          {builtinOnly ? (
            <p className="monitor-wait__note">
              这几个是智能体用 claude 自带的 <code>Monitor</code> 起的：进程在它自己那一轮里，
              通知也只注回那条会话 —— <b>它们不会把这个任务叫醒</b>，回合一结束就跟着被收走。
              要跨回合等一件事，得用 ash 的哨兵（<code>start_monitor</code>）并用{" "}
              <code>pause_task</code> 收尾那一轮。
            </p>
          ) : (
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
              {/* 两种分开说：内置那几个不参与上面那句「会叫醒」，但不能当它不存在。 */}
              {builtinCount > 0 && (
                <> 另有 {builtinCount} 个 claude 内置 Monitor 在智能体自己那一轮里跑着，它们不会唤醒任务。</>
              )}
            </p>
          )}
          {unclaimed.length > 0 && (
            <p className="monitor-wait__note monitor-wait__note--stuck">
              其中 {unclaimed.length} 个 ash <b>这一刻认不回它的进程</b>：重启恰好打断了起进程那一步，
              所以它从来没收到过信号。日志和期限照旧有人接着管（有结果会照常叫醒你、到点照常
              收尾），但在认回来之前<b>点停未必停得掉那个进程</b> —— 那一步要先认得出它的号。
              <q>{unclaimed[0].endedReason}</q>
            </p>
          )}
          <button type="button" className="monitor-wait__open" onClick={onOpenPanel}>
            哨兵面板 <ArrowRight size={11} weight="bold" aria-hidden="true" />
          </button>
        </div>
      )}
    </section>
  );
}

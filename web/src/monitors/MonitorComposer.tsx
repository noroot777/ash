import { useState } from "react";
import { SpinnerGap } from "@phosphor-icons/react";
import {
  MONITOR_DEFAULT_TIMEOUT_MS, MONITOR_WAKE_LABEL, MONITOR_WAKE_TARGETS, monitorDurationOptions,
} from "@ash/shared/monitor";
import type { MonitorWakeTarget } from "@ash/shared/monitor";
import type { StartMonitorInput } from "./useTaskMonitors.ts";

// **从共享常量推导，不要在这里另列一张表**：写死的那版在时长上限改掉之后整张失真
// （选「2 小时」实际只盯 5 分钟，而且提交值恰好等于缺省值，连「已钳到边界」的回执都没有）。
const DURATIONS = monitorDurationOptions();

/**
 * 手动起一个哨兵。
 *
 * 入口留给人而不只留给 agent 的理由：想盯的那件事常常是**人**先知道的（这轮翻译要跑两
 * 小时、CI 刚推上去），与其先叫醒 agent 让它替你起一个，不如自己挂上去——它下次醒来就
 * 已经带着结果了。工作目录不在表单里：后端一律用任务自己的工作目录，让人在这里填一个
 * 别的路径只会制造「盯错了地方」这一类排查起来最费劲的故障。
 *
 * ── 「醒来叫谁」只在服务端说不清的时候才问 ─────────────────────────────────────
 *
 * 哨兵唯一的出口是唤醒这个任务，而这个任务可能同时有两条会话（实现者那条、审查者那条）。
 * agent 自己挂的那一路服务端答得出来（回合凭据 + 回合角色），**手动挂的不属于任何一条
 * 会话**：这个任务上又有一次审查正在进行时，叫谁都是在猜，所以服务端会拒掉并把
 * `needsWakeTarget` 带回来（见 server 的 monitor-session.ts）。那一刻才长出这个二选一 ——
 * 平时不问，是因为绝大多数任务只有一条线，多问一句只会让人以为自己漏填了什么。
 */
export function MonitorComposer({
  busy,
  needsWakeTarget,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  /** 服务端上一次拒绝的理由是「说不清醒来叫谁」：这时必须选一个才能再提交。 */
  needsWakeTarget: boolean;
  onCancel: () => void;
  onSubmit: (input: StartMonitorInput) => void;
}) {
  const [command, setCommand] = useState("");
  const [description, setDescription] = useState("");
  const [timeoutMs, setTimeoutMs] = useState(MONITOR_DEFAULT_TIMEOUT_MS);
  const [wake, setWake] = useState<MonitorWakeTarget | null>(null);
  // 要选而没选时**不许提交**：带着空的唤醒目标发出去只会再吃同一句拒绝。
  const ready = command.trim().length > 0 && (!needsWakeTarget || wake !== null);

  return (
    <form
      className="monitor-composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || busy) return;
        onSubmit({
          command: command.trim(),
          description: description.trim() || undefined,
          timeoutMs,
          ...(wake ? { wake } : {}),
        });
      }}
    >
      <label>
        <span>命令</span>
        <textarea
          rows={2}
          value={command}
          placeholder={'tail -f build.log | grep --line-buffered -E "ERROR|BUILD OK"'}
          onChange={(event) => setCommand(event.target.value)}
        />
      </label>
      <p className="monitor-composer__hint">
        它吐出的每一行都会唤醒这个任务一次，所以命令本身就是过滤器：只放行你真要被叫醒的那几行，
        并且把失败的特征一起放进去——不然命令崩了，这边只会是一片安静。
      </p>
      <label>
        <span>说明</span>
        <input
          value={description}
          placeholder="盯翻译进度"
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <label>
        <span>盯多久</span>
        <select value={timeoutMs} onChange={(event) => setTimeoutMs(Number(event.target.value))}>
          {DURATIONS.map((duration) => (
            <option key={duration.ms} value={duration.ms}>{duration.label}</option>
          ))}
        </select>
      </label>
      {needsWakeTarget && (
        <fieldset className="monitor-composer__wake">
          <legend>醒来叫谁</legend>
          {/* 为什么要问这一句，照实说：这个任务上有一次审查正在进行，而手动挂的哨兵不属于
              任何一条会话。猜错的两种后果都不便宜——叫实现者会凭空烧一个回合、审查那条会话
              继续等不到人；叫审查会把本该给实现者的结果投进一条正在收尾的审查。 */}
          <p className="monitor-composer__hint">
            这个任务上有一次审查正在进行。哨兵每吐一行都会唤醒一条会话，所以得说清叫谁：
            盯的是这次审查在等的那件事就选「这次审查」，是实现那边的活就选「实现者」。
          </p>
          <div className="monitor-composer__wake-options">
            {MONITOR_WAKE_TARGETS.map((target) => (
              <label key={target}>
                <input
                  type="radio"
                  name="monitor-wake"
                  value={target}
                  checked={wake === target}
                  onChange={() => setWake(target)}
                />
                <span>{MONITOR_WAKE_LABEL[target]}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="monitor-composer__actions">
        <button type="button" onClick={onCancel}>取消</button>
        <button type="submit" className="is-primary" disabled={!ready || busy}>
          {busy && <SpinnerGap size={12} className="is-spinning" />}
          起一个哨兵
        </button>
      </div>
    </form>
  );
}

import { useState } from "react";
import { SpinnerGap } from "@phosphor-icons/react";
import { MONITOR_DEFAULT_TIMEOUT_MS, monitorDurationOptions } from "@ash/shared/monitor";
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
 */
export function MonitorComposer({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: StartMonitorInput) => void;
}) {
  const [command, setCommand] = useState("");
  const [description, setDescription] = useState("");
  const [timeoutMs, setTimeoutMs] = useState(MONITOR_DEFAULT_TIMEOUT_MS);
  const ready = command.trim().length > 0;

  return (
    <form
      className="monitor-composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || busy) return;
        onSubmit({ command: command.trim(), description: description.trim() || undefined, timeoutMs });
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

// 哨兵面板：这个任务后台挂着的长跑命令都在这儿。
//
// 为什么是一整格 Inspector 而不是回复框上面的一条：哨兵不是「一条待办」，它是一个**正在
// 跑的进程**——命令原文、工作目录、还剩多久、它这会儿在吐什么，哪一样都不是一行摘要塞得
// 下的；而回复框上方那条带每多一行，输入区就矮一行。
import { useMemo, useState } from "react";
import { Plus } from "@phosphor-icons/react";
import { InspectorHeadActions } from "../inspector/index.ts";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { MonitorCard } from "./MonitorCard.tsx";
import { MonitorComposer } from "./MonitorComposer.tsx";
import type { TaskMonitorsState } from "./useTaskMonitors.ts";

export function MonitorInspector({
  monitors,
  canStart,
}: {
  monitors: TaskMonitorsState;
  /** 归档任务只读：进程早被收回了，再给一个「起一个」只会起完就被下一次清理掉。 */
  canStart: boolean;
}) {
  const [composing, setComposing] = useState(false);
  const addTip = useHoverTip();
  // 还在盯着的永远排在上面：结束的那几张是存档，正在烧回合的那几个才是要盯着看的。
  // 同一档里按开始时间倒序（listMonitors 已经这么给了），所以只需要把 running 提上来。
  const rows = useMemo(() => [
    ...monitors.monitors.filter((monitor) => monitor.status === "running"),
    ...monitors.monitors.filter((monitor) => monitor.status !== "running"),
  ], [monitors.monitors]);

  return (
    <div className="monitor-inspector">
      {canStart && (
        <InspectorHeadActions>
          <button
            type="button"
            className="monitor-inspector__add"
            aria-label="手动起一个哨兵"
            aria-expanded={composing}
            {...addTip.anchorProps}
            onClick={() => setComposing((current) => !current)}
          >
            <Plus size={13} weight="bold" aria-hidden="true" />
          </button>
          <HoverTip at={composing ? null : addTip.at}>手动起一个哨兵</HoverTip>
        </InspectorHeadActions>
      )}
      {monitors.error && <p className="monitor-inspector__error" role="alert">{monitors.error}</p>}
      {composing && (
        <MonitorComposer
          busy={monitors.starting}
          onCancel={() => setComposing(false)}
          onSubmit={(input) => void monitors.start(input).then((ok) => { if (ok) setComposing(false); })}
        />
      )}
      {rows.length === 0
        ? (
          <div className="monitor-inspector__empty">
            <p>这个任务上还没有哨兵。</p>
            <p>
              哨兵是一条绑在任务上的长跑命令，由 ash 自己起——不在智能体的进程树里，
              所以它的回合结束、会话结束、server 重启都带不走它。它每吐一行，就把这个任务唤醒一次。
            </p>
            <p>智能体可以自己挂（MCP 工具 start_monitor），你也可以从上面那个 + 手动起一个。</p>
          </div>
        )
        : (
          <div className="monitor-inspector__list">
            {rows.map((monitor) => (
              <MonitorCard
                key={monitor.id}
                monitor={monitor}
                stopping={monitors.stoppingIds.has(monitor.id)}
                onStop={(monitorId) => void monitors.stop(monitorId)}
              />
            ))}
          </div>
        )}
    </div>
  );
}

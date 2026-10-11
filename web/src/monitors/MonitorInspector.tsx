// 哨兵面板：这个任务后台挂着的长跑命令都在这儿。
//
// 为什么是一整格 Inspector 而不是回复框上面的一条：哨兵不是「一条待办」，它是一个**正在
// 跑的进程**——命令原文、工作目录、还剩多久、它这会儿在吐什么，哪一样都不是一行摘要塞得
// 下的；而回复框上方那条带每多一行，输入区就矮一行。
import { useMemo, useRef, useState } from "react";
import { Plus } from "@phosphor-icons/react";
import { InspectorHeadActions } from "../inspector/index.ts";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { MonitorCard } from "./MonitorCard.tsx";
import { MonitorComposer } from "./MonitorComposer.tsx";
import type { TaskMonitorsState } from "./useTaskMonitors.ts";

export function MonitorInspector({
  monitors,
  blockedReason,
}: {
  monitors: TaskMonitorsState;
  /**
   * 不能挂哨兵时的原因（`monitorBlockedReason`，与服务端创建闸同一份判据）；null = 能挂。
   *
   * 要的是**原因**而不是一个布尔：按钮凭空消失的话，用户只会以为功能坏了或自己记错了
   * 位置——而这里恰恰有一句话能说清楚（任务已经结束了，它的输出不会再唤醒任何人）。
   */
  blockedReason: string | null;
}) {
  const canStart = blockedReason === null;
  /**
   * 当前这张表单的**实例代号**（null = 没开）。每次打开 +1，`submitting` 记的是哪一张
   * 表单正在提交中。
   *
   * 为什么不是一个 `composing: boolean` 加一个任务级的忙碌标记：在途期间点取消、重新打开
   * 填另一条命令，是同一个任务上的**两张**表单。只按任务判的话，旧请求回来会关掉用户刚
   * 填的那一张（草稿当场没了），它的忙碌标记还一直按着新表单的提交按钮（第 3 轮审查实测：
   * reopenedDraftDisappeared=true、reopenedBlockedByOldStart=true）。代号对不上就什么都
   * 不做——提交的回执只认它自己那一张。
   */
  const nextForm = useRef(0);
  const [form, setForm] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState<number | null>(null);
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
            aria-expanded={form !== null}
            {...addTip.anchorProps}
            onClick={() => setForm((current) => (current === null ? ++nextForm.current : null))}
          >
            <Plus size={13} weight="bold" aria-hidden="true" />
          </button>
          <HoverTip at={form !== null ? null : addTip.at}>手动起一个哨兵</HoverTip>
        </InspectorHeadActions>
      )}
      {monitors.error && <p className="monitor-inspector__error" role="alert">{monitors.error}</p>}
      {blockedReason && <p className="monitor-inspector__blocked">{blockedReason}</p>}
      {form !== null && (
        <MonitorComposer
          // 重开就是一张新表单：代号一换，上一张的草稿不会被继承过来。
          key={form}
          busy={submitting === form}
          onCancel={() => setForm(null)}
          onSubmit={(input) => {
            const mine = form;
            setSubmitting(mine);
            void monitors.start(input).then((ok) => {
              setSubmitting((current) => (current === mine ? null : current));
              if (ok) setForm((current) => (current === mine ? null : current));
            });
          }}
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
            {canStart && <p>智能体可以自己挂（MCP 工具 start_monitor），你也可以从上面那个 + 手动起一个。</p>}
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

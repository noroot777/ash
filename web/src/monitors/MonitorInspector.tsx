// 哨兵面板：这个任务后台挂着的长跑命令都在这儿。
//
// 为什么是一整格 Inspector 而不是回复框上面的一条：哨兵不是「一条待办」，它是一个**正在
// 跑的进程**——命令原文、工作目录、还剩多久、它这会儿在吐什么，哪一样都不是一行摘要塞得
// 下的；而回复框上方那条带每多一行，输入区就矮一行。
import { useMemo, useRef, useState } from "react";
import { Plus } from "@phosphor-icons/react";
import { MONITOR_RECOVERY_LABEL, type MonitorKind, type TaskMonitor } from "@ash/shared/monitor";
import { InspectorHeadActions } from "../inspector/index.ts";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { MonitorCard } from "./MonitorCard.tsx";
import { MonitorComposer } from "./MonitorComposer.tsx";
import type { TaskMonitorsState } from "./useTaskMonitors.ts";

/**
 * 分段的顺序与措辞。ash 那组排在前面：它是这一格的主角（能停、有日志、真的会唤醒任务），
 * 内置那组是「也让你看得见」的旁证。
 */
const MONITOR_GROUPS: readonly { kind: MonitorKind; title: string; hint: string }[] = [
  { kind: "ash", title: "ash 哨兵", hint: "进程由 ash 起，跨回合、跨重启都活着；能停、能看输出" },
  { kind: "claude", title: "claude 内置 Monitor", hint: "只读投影：进程在智能体自己那一轮里，停不掉、没有日志，也不会唤醒任务" },
];

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
  /**
   * **按来源分段，不混排**（用户 2026-10-16 拍板）。
   *
   * 两种哨兵的能力不对等到了「同一个词指两件事」的地步：ash 那种的进程由 server 起、跨
   * 回合活着、停得掉、有日志；claude 内置的那种是一份只读投影，agent 的进程一退就跟着
   * 没了，ash 连停它的手柄都没有。混在一张列表里的后果不是「不够整齐」，而是用户会对着
   * 一张 claude 的卡去找停止按钮，或者把「它会叫醒任务」的预期套到一个只在那一轮里有效
   * 的监听上 —— 那正是 Bp2LkwfRO37A 里「监听已挂上、却没人被叫醒」那一幕的读图版本。
   *
   * 段内仍是「还在盯着的排在上面」：结束的那几张是存档，正在烧回合的才是要盯着看的。
   * 同一档里按开始时间倒序（`listMonitors` 已经这么给了），所以只需要把 running 提上来。
   */
  const groups = useMemo(() => {
    const live = (rows: readonly TaskMonitor[]) => [
      ...rows.filter((monitor) => monitor.status === "running"),
      ...rows.filter((monitor) => monitor.status !== "running"),
    ];
    return MONITOR_GROUPS
      .map((group) => ({ ...group, rows: live(monitors.monitors.filter((m) => m.kind === group.kind)) }))
      .filter((group) => group.rows.length > 0);
  }, [monitors.monitors]);
  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);

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
      {/* 「还没读完」要跟「确实没有」分开说：两者都是空面板，但该做的事完全不同（一个等
          一下再看，一个根本没用过哨兵）。有卡片时也要说——那份列表可能只是其中一部分。 */}
      {monitors.recovery?.pending && (
        <p className="monitor-inspector__pending" role="status">
          历史监听还没读完（{monitors.recovery.reasons.map((reason) => MONITOR_RECOVERY_LABEL[reason]).join("、")}），
          {/* 重试预算用完之后**不能再说「正在自动继续」**——那时定时器已经停了（第 8 轮审查
              不拦项 1）。但也不能说成「已停止」:读这份状态本身就是一次真实请求，它顺手
              把预算还回去又推了一轮（面板开着时每约 9 分钟自己再走一遍阶梯，是有意的）。
              所以这里只说那两件**都成立**的事实:试了很多次还没读完，而每次打开都会再推
              一轮（第 9 轮审查不拦项 3:文案与重试策略要对齐）。 */}
          {monitors.recovery.exhausted
            ? "已重试多次仍没读完；每次打开这一格都会再推一轮。"
            : "正在自动继续。"}
        </p>
      )}
      {rows.length === 0
        ? (
          <div className="monitor-inspector__empty">
            {/* 三种空态分开说：还没读完 / **不知道**（恢复状态自己都没读到）/ 确实没有。
                第三句是一句很强的断言（「这个任务没用过哨兵」），拿不到依据时不许说它。 */}
            <p>
              {monitors.recovery?.pending
                ? "历史还没读完，先给你看现有的（暂时一条也没有）。"
                : monitors.recovery === null
                  ? "读不到这个任务的监听恢复状态，所以还不能说它没用过哨兵。"
                  : "这个任务上还没有哨兵。"}
            </p>
            <p>
              哨兵是一条绑在任务上的长跑命令，由 ash 自己起——不在智能体的进程树里，
              所以它的回合结束、会话结束、server 重启都带不走它。它每吐一行，就把这个任务唤醒一次。
            </p>
            {/* 两种来源都要说到：claude 执行器几乎必然用它自带的那个（CLI 的提示词把长等待
                主动往那边引），用户在这儿只写 start_monitor 的话，会以为面板漏了东西。 */}
            <p>
              智能体用 claude 自带的 Monitor 起的，这里也会列出来，但只能看不能停——
              那种的进程在智能体自己的进程树里。
            </p>
            {canStart && <p>智能体可以自己挂（MCP 工具 start_monitor），你也可以从上面那个 + 手动起一个。</p>}
          </div>
        )
        : (
          <div className="monitor-inspector__groups">
            {groups.map((group) => (
              <section key={group.kind} className="monitor-group">
                {/* 段头一行把这一组是什么、能拿它怎么办说清楚。只有一组时也照样显示——
                    那时它回答的是另一个问题：「为什么这几张卡没有停止按钮」。 */}
                <h4 className="monitor-group__head">
                  <span className="monitor-group__name">{group.title}</span>
                  <span className="monitor-group__hint">{group.hint}</span>
                </h4>
                <div className="monitor-inspector__list">
                  {group.rows.map((monitor) => (
                    <MonitorCard
                      key={monitor.id}
                      monitor={monitor}
                      stopping={monitors.stoppingIds.has(monitor.id)}
                      onStop={(monitorId) => void monitors.stop(monitorId)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
    </div>
  );
}

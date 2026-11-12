// 哨兵面板：这个任务后台挂着的长跑命令都在这儿。
//
// 为什么是一整格 Inspector 而不是回复框上面的一条：哨兵不是「一条待办」，它是一个**正在
// 跑的进程**——命令原文、工作目录、还剩多久、它这会儿在吐什么，哪一样都不是一行摘要塞得
// 下的；而回复框上方那条带每多一行，输入区就矮一行。
import { useMemo, useRef, useState } from "react";
import { Plus } from "@phosphor-icons/react";
import { MONITOR_RECOVERY_LABEL, type MonitorKind, type TaskMonitor } from "@ash/shared/monitor";
import { InspectorHeadActions } from "../inspector/index.ts";
import { useInspectorRequest } from "../inspector/nav.tsx";
import { RequestMissNote } from "../inspector/RequestMissNote.tsx";
import { InspNone, InspNote, InspSec, InspTool } from "../inspector/parts.tsx";
import { MonitorCard } from "./MonitorCard.tsx";
import { MonitorComposer } from "./MonitorComposer.tsx";
import type { TaskMonitorsState } from "./useTaskMonitors.ts";

/**
 * 分段的顺序与措辞。ash 那组排在前面：它是这一格的主角（能停、有日志、真的会唤醒任务），
 * 内置那组是「也让你看得见」的旁证。
 */
const MONITOR_GROUPS: readonly { kind: MonitorKind; title: string; hint: string | null }[] = [
  // ash 那组能停、有输出，按钮和折叠就在卡上，不用再解释一遍。
  { kind: "ash", title: "ash 哨兵", hint: null },
  { kind: "claude", title: "claude 自带 Monitor", hint: "只读：进程在智能体自己那一轮里，停不掉、没有输出可看，也不会唤醒任务。" },
];

export function MonitorInspector({
  monitors,
  blockedReason,
  waiting = false,
}: {
  monitors: TaskMonitorsState;
  /** 任务这会儿是暂停的：在盯的那几张卡上，停掉的说法换成「不等了」（任务留在暂停）。 */
  waiting?: boolean;
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
  const cards = useRef(new Map<string, HTMLElement>());
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

  // 会话里那一行「在哨兵格里看」带着哨兵 id 过来：把那张卡滚进视野、焦点放上去。列表还没读到
  // 就等；读到的那一份里没有（刚挂上的那条还没进列表），重读一次再认，还没有就说出来。
  const requestMiss = useInspectorRequest("monitors", (params) => {
    const id = typeof params.monitorId === "string" ? params.monitorId : null;
    const card = id ? cards.current.get(id) : null;
    if (!card) return monitors.ready || monitors.error ? "missing" : "wait";
    card.scrollIntoView({ block: "nearest" });
    card.focus({ preventScroll: true });
    card.classList.add("is-flash");
    window.setTimeout(() => card.classList.remove("is-flash"), 1600);
  }, { version: [rows, monitors.ready, monitors.error], refresh: () => monitors.reload() });

  return (
    <div className="insp-pane monitor-inspector">
      {canStart && (
        <InspectorHeadActions>
          <InspTool
            label="手动起一个哨兵"
            tip="手动起一个哨兵：一条绑在任务上的长跑命令，由 ash 起，每吐一行就唤醒任务一次。智能体挂的（含 claude 自带的 Monitor）也列在这一格"
            className="monitor-inspector__add"
            aria-expanded={form !== null}
            onClick={() => setForm((current) => (current === null ? ++nextForm.current : null))}
          >
            <Plus aria-hidden="true" />
          </InspTool>
        </InspectorHeadActions>
      )}
      <RequestMissNote miss={requestMiss} what={() => "那个哨兵"} />
      {monitors.error && <p className="insp-hint is-bad monitor-inspector__error" role="alert">{monitors.error}</p>}
      {blockedReason && <div className="monitor-inspector__blocked"><InspNote>{blockedReason}</InspNote></div>}
      {form !== null && (
        <MonitorComposer
          // 重开就是一张新表单：代号一换，上一张的草稿不会被继承过来。
          key={form}
          busy={submitting === form}
          needsWakeTarget={monitors.needsWakeTarget}
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
        <p className="insp-hint monitor-inspector__pending" role="status">
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
          // 三种空态分开说：还没读完 / **不知道**（恢复状态自己都没读到）/ 确实没有。
          // 第三句是一句很强的断言（「这个任务没用过哨兵」），拿不到依据时不许说它。
          //
          // 「哨兵是什么」那段解释收进 + 的悬停提示和起哨兵的表单里，空态只说一句。
          <div className="monitor-inspector__empty">
            <InspNone>
              {monitors.recovery?.pending
                ? "历史还没读完，先给你看现有的（暂时一条也没有）。"
                : monitors.recovery === null
                  ? "读不到这个任务的监听恢复状态，所以还不能说它没用过哨兵。"
                  : "这个任务上还没有哨兵。"}
            </InspNone>
          </div>
        )
        : (
          <div className="monitor-inspector__groups">
            {groups.map((group) => (
              <section key={group.kind} className="monitor-group" aria-label={group.title}>
                {/* 段头只说这一组是谁起的。claude 那组多一句：它回答的是「为什么这几张卡没有
                    停止按钮」，只有一组时也照样显示。 */}
                <InspSec count={group.rows.length}>{group.title}</InspSec>
                {group.hint && <p className="insp-hint monitor-group__hint">{group.hint}</p>}
                <div className="insp-cards monitor-inspector__list">
                  {group.rows.map((monitor) => (
                    <MonitorCard
                      key={monitor.id}
                      ref={(element) => {
                        if (element) cards.current.set(monitor.id, element);
                        else cards.current.delete(monitor.id);
                      }}
                      waiting={waiting}
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

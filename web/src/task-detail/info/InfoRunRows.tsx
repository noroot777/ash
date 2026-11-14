// 「信息」格下半截：这个任务跑得怎么样了。来源、时间、用量（一个执行器一行）、上下文，
// 以及会话号和 resume 命令。后三样以前是会话最后一条回复尾巴上的药丸，搬到这里以后取数
// 照旧（会话行上的账本 + 会话流里最新那条气泡的直播值，见 infoRunFacts.ts），只是换成「标签 值」。
// 每一回合各自烧了多少收在那一回合尾的「更多」菜单里（TurnActions）。
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Session, Task, TokenUsage } from "@ash/shared";
import { addUsage, formatTokens, formatTokensExact, hasContext, hasUsage, usageTotal } from "@ash/shared/usage";
import { taskCreationLabel } from "@ash/shared/task-origin";
import { createPortal } from "react-dom";
import { AgentIcon } from "../../components/AgentIcon.tsx";
import { ContextMeterPanel, contextMeterView } from "../../components/ContextMeterChip.tsx";
import { HoverTip, useHoverTip } from "../../components/HoverTip.tsx";
import { InspCopy, InspRow } from "../../inspector/parts.tsx";
import { useDismissable } from "../../lib/useDismissable.ts";
import { placementStyle, usePanelPlacement } from "../../lib/usePanelPlacement.ts";
import { formatInstant, formatInstantRange, taskDurationInfo } from "../utils.ts";
import type { InfoRunFacts } from "./infoRunFacts.ts";
import { RollingNumber } from "../../lib/motion/index.ts";

/** 一段字，指上去 / 键盘走到再说一句补充（不用原生 title）。 */
function Tipped({ tip, children, className = "" }: { tip: string; children: React.ReactNode; className?: string }) {
  const hover = useHoverTip();
  return (
    <>
      <span className={`insp-has-tip ${className}`.trim()} tabIndex={0} {...hover.anchorProps}>{children}</span>
      <HoverTip at={hover.at}>{tip}</HoverTip>
    </>
  );
}

// 面上只画智能体的标，执行器全名（claude@某台机器）指上去再说。
// 「N 轮」只数真人/系统推着走的回合，被哨兵叫醒的那几轮扣掉，在悬停里另报。
// 服务端在同一笔入账里数总轮数和唤醒轮数，唤醒本来就是总数的子集；token 仍按全部回合计。
function UsageValue({ label, agentType, usage, wakes }: { label: string; agentType: string; usage: TokenUsage; wakes: number }) {
  const total = usage.turns ?? 0;
  const woken = Math.min(wakes, total);
  const turns = total - woken;
  const note = woken > 0 ? `另有哨兵唤醒 ${woken} 轮未计入` : null;
  return (
    <span
      className="insp-cut"
      aria-label={[`${label} 累计 ${formatTokensExact(usageTotal(usage))} token`, total ? `${turns} 轮` : "", note].filter(Boolean).join("，")}
    >
      <Tipped tip={label} className="insp-agent"><AgentIcon agent={agentType} size={14} /></Tipped>
      <RollingNumber className="insp-num" value={usageTotal(usage)} format={formatTokens} />
      {total > 0 && (
        <span className="insp-faint">
          {" · "}
          {note ? <Tipped tip={note}>{turns} 轮</Tipped> : `${turns} 轮`}
        </span>
      )}
    </span>
  );
}

/** 上下文那一行：一根细条画剩下的那一截（剩到 15% 以下变红），右边是「压缩设置」——点开就是原来那颗胶囊的明细加快捷设置。 */
function ContextValue({ facts }: { facts: InfoRunFacts }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(true);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const place = usePanelPlacement(triggerRef, panelRef, { minWidth: editing ? 296 : 224, minHeight: 108, fallbackHeight: 180, enabled: open });
  useDismissable({ enabled: open, containerRef: panelRef, onClose: () => setOpen(false), restoreFocusRef: triggerRef });
  useLayoutEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);
  const context = facts.context;
  if (!hasContext(context)) {
    return facts.compacting ? <span className="insp-live">压缩中</span> : <span className="insp-faint">还没有数据</span>;
  }
  const view = contextMeterView(context);
  const remain = view.remain;
  return (
    <>
      {remain !== null && (
        <span className={`insp-bar${remain <= 15 ? " is-low" : ""}`} aria-hidden="true">
          <i style={{ transform: `scaleX(${remain / 100})` }} />
        </span>
      )}
      <span className={facts.compacting ? "insp-live" : "insp-num"} aria-label={facts.compacting ? "正在压缩上下文" : view.spoken}>
        {facts.compacting
          ? "压缩中"
          : remain === null ? `已用 ${formatTokens(context.used)}` : `剩 ${view.approx}${remain}%`}
      </span>
      <button
        ref={triggerRef}
        type="button"
        className="insp-val is-end"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {facts.session ? "压缩设置" : "明细"}
      </button>
      {open && createPortal(
        <ContextMeterPanel
          ref={panelRef}
          context={context}
          session={facts.session}
          editing={editing}
          onToggleEditing={() => setEditing((current) => !current)}
          style={placementStyle(place)}
        />,
        document.body,
      )}
    </>
  );
}

/** 任务号、来源、创建、用时、用量（一个执行器一行）、上下文。 */
export function InfoRunRows({ task, sessions, facts, notify }: {
  task: Task;
  sessions: Session[];
  facts: InfoRunFacts;
  notify?: (message: string) => void;
}) {
  // 一个 agent 一行，**不同 agent 绝不相加**：单价、上下文、缓存策略都不是一回事，
  // 加出来那个数不代表任何东西（用户 2026-08-07 明确要求分开看）。同一个执行器名下的
  // 多条会话（重跑、续跑各开一行）才合并 —— 那才是同一副账。哨兵唤醒的轮数跟着同一份
  // 分组累加：唤醒照样计费、照样算进轮数，只在悬停里拆开。
  const usageByExecutor = useMemo(() => {
    const groups = new Map<string, { agentType: string; usage: TokenUsage; wakes: number }>();
    for (const session of sessions) {
      if (!session.usage) continue;
      const label = session.executor || session.agentType;
      const previous = groups.get(label);
      const wakes = session.monitorWakeTurns ?? 0;
      groups.set(label, previous
        ? { ...previous, usage: addUsage(previous.usage, session.usage), wakes: previous.wakes + wakes }
        : { agentType: session.agentType, usage: session.usage, wakes });
    }
    return [...groups].filter(([, group]) => hasUsage(group.usage));
  }, [sessions]);
  const duration = taskDurationInfo(task);
  const range = formatInstantRange(task.startedAt, task.endedAt);
  return (
    <>
      {/* 没有地址栏的窗口（mac 版）里，这一行是看见任务号的唯一地方。 */}
      <InspRow label="ID">
        <span className="insp-cut insp-mono">{task.id}</span>
        <InspCopy text={task.id} label="复制任务 ID" onError={notify} />
      </InspRow>
      <InspRow label="来源"><span className="insp-cut">{taskCreationLabel(task.creationOrigin)}</span></InspRow>
      <InspRow label="创建"><span className="insp-num">{formatInstant(task.createdAt)}</span></InspRow>
      {duration && (
        <InspRow label={duration.label}>
          <Tipped tip={[range, duration.note].filter(Boolean).join(" · ") || duration.text} className="insp-num">{duration.text}</Tipped>
        </InspRow>
      )}
      {usageByExecutor.map(([label, { agentType, usage, wakes }], index) => (
        <InspRow key={label} label={index === 0 ? "用量" : ""}>
          <UsageValue label={label} agentType={agentType} usage={usage} wakes={wakes} />
        </InspRow>
      ))}
      {(hasContext(facts.context) || facts.compacting) && (
        <InspRow label="上下文"><ContextValue facts={facts} /></InspRow>
      )}
    </>
  );
}

/** 独立工作区是从哪儿开出来的：起点所在的分支，后面淡淡带上起点提交。还没跑过也有（建任务时就定了）。 */
export function InfoBaseRow({ task }: { task: Task }) {
  if (!task.useWorktree) return null;
  const commit = task.worktreeStartCommit;
  const base = task.worktreeBaseBranch || task.worktreeBase;
  if (!base && !commit) return null;
  const short = commit?.slice(0, 7);
  return (
    <InspRow label="基于">
      <Tipped tip={commit ? `起点提交 ${commit}` : `${base}（还没开工，起点到时再定）`} className="insp-cut">
        {base ?? <span className="insp-num">{short}</span>}
        {base && short && !commit!.startsWith(base) && <span className="insp-faint insp-num"> · {short}</span>}
      </Tipped>
    </InspRow>
  );
}

/** 起点、分支、目录、会话号、resume 命令。后几样可复制。 */
export function InfoSessionRows({ task, session, notify }: { task: Task; session: Session | undefined; notify: (message: string) => void }) {
  if (!session) return <InfoBaseRow task={task} />;
  const cliId = session.cliSessionId;
  return (
    <>
      <InfoBaseRow task={task} />
      {session.branch && (
        <InspRow label="分支" className={task.useWorktree ? "" : "is-danger"}>
          <Tipped tip={task.useWorktree ? session.branch : `${session.branch}（没有独立工作区，直接在这条分支上改）`} className="insp-cut">{session.branch}</Tipped>
          <InspCopy text={session.branch} label="复制分支名" onError={notify} />
        </InspRow>
      )}
      {(session.worktreePath || session.cwd) && (
        <InspRow label="目录">
          <Tipped tip={(session.worktreePath || session.cwd)!} className="insp-cut">{session.worktreePath || session.cwd}</Tipped>
          <InspCopy text={(session.worktreePath || session.cwd)!} label="复制目录" onError={notify} />
        </InspRow>
      )}
      {cliId && (
        <InspRow label="会话">
          <span className="insp-num insp-cut">{cliId}</span>
          <InspCopy text={cliId} label="复制会话号" onError={notify} />
        </InspRow>
      )}
      {session.resumeCommand && (
        <InspRow label="resume">
          <span className="insp-cut insp-mono">{session.resumeCommand}</span>
          <InspCopy text={session.resumeCommand} label="复制 resume 命令" onError={notify} />
        </InspRow>
      )}
    </>
  );
}

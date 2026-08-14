import { useEffect, useMemo, useState } from "react";
import type { Group, Task } from "@harness/shared";
import { STAGE_LABELS } from "@harness/shared";
import { isTeamSettled, timeMs } from "@harness/shared/team";
import { CaretDown } from "@phosphor-icons/react";
import { formatDuration, formatInstant } from "../task-detail/utils.ts";
import { statusTone, teamLeadLabel, type LeadTurn } from "./teamModel.ts";

type Bar = { from: number; to: number; tone: string; pending?: boolean; title: string };
type Row = { id?: string; name: string; bars: Bar[]; pendingOnly?: boolean };

function useClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}

function DeliverySummary({ workers }: { workers: Task[] }) {
  const tracked = workers.filter((worker) => worker.stage || worker.useWorktree);
  if (!tracked.length) return <span className="team-timeline-delivery">尚无验收阶段</span>;
  const failed = tracked.filter((worker) => worker.stage === "verify_failed").length;
  const accepted = tracked.filter((worker) => worker.stage === "accepted").length;
  const awaiting = tracked.filter((worker) => worker.stage === "awaiting_acceptance").length;
  const verified = tracked.filter((worker) => worker.stage === "verified").length;
  const slowest = tracked.find((worker) => !worker.stage)?.stage
    ?? tracked.map((worker) => worker.stage).find((stage) => stage === "verifying" || stage === "implemented")
    ?? tracked[0]?.stage;
  const summary = failed
    ? `${failed} 个验证失败`
    : accepted === tracked.length
      ? "全部验收完成"
      : awaiting
        ? `${awaiting} 个待验收`
        : verified
          ? `${verified} 个已验证`
          : slowest ? STAGE_LABELS[slowest] : "等待阶段上报";
  return (
    <span className={`team-timeline-delivery${failed ? " is-failed" : ""}`}>
      <i className={failed ? "is-failed" : verified || accepted ? "is-done" : ""} />
      验证
      <i className={awaiting || accepted ? "is-done" : ""} />
      待验收
      <i className={accepted === tracked.length ? "is-done" : ""} />
      完成
      <b>{summary}</b>
    </span>
  );
}

export function TeamTimeline({
  lead,
  leadTurns,
  workers,
  groups,
  onOpenWorker,
  defaultOpen = false,
}: {
  lead: Task;
  leadTurns: LeadTurn[];
  workers: Task[];
  groups: Group[];
  onOpenWorker: (taskId: string) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const settled = isTeamSettled(lead.status === "running", workers);
  const live = lead.status === "running" || workers.some((worker) => worker.status === "running" || worker.status === "queued");
  const now = useClock(open && live);
  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const fallbackEnd = timeMs(lead.endedAt) ?? timeMs(lead.updatedAt) ?? now;
  const openEnd = settled ? fallbackEnd : now;
  const rows: Row[] = [
    {
      name: `调度者 ${teamLeadLabel(lead)}`,
      bars: leadTurns.map((turn) => ({
        from: turn.from,
        to: turn.to ?? openEnd,
        tone: turn.to === null && live ? "green" : "indigo",
        title: turn.to === null && live ? "委派中" : `回合用时 ${formatDuration((turn.to ?? openEnd) - turn.from)}`,
      })),
    },
    ...workers.map((worker, index) => {
      const started = timeMs(worker.startedAt);
      const stopped = !!(worker.groupId && groupById.get(worker.groupId)?.paused);
      if (started === null) {
        return { id: worker.id, name: `${index + 1} ${worker.title}`, bars: [], pendingOnly: true };
      }
      const ended = timeMs(worker.endedAt) ?? openEnd;
      return {
        id: worker.id,
        name: `${index + 1} ${worker.title}${stopped ? " · 组已停止" : ""}`,
        bars: [{
          from: started,
          to: ended,
          tone: statusTone(worker),
          pending: worker.status === "queued" || worker.status === "backlog",
          title: `${formatDuration(ended - started)}${worker.endedAt ? "" : " · 进行中"}`,
        }],
      };
    }),
  ];
  const bars = rows.flatMap((row) => row.bars);
  const start = bars.length ? Math.min(...bars.map((bar) => bar.from)) : now;
  const end = bars.length ? Math.max(...bars.map((bar) => bar.to)) : now;
  const span = Math.max(1000, end - start);
  const percent = (value: number) => ((value - start) / span) * 100;

  return (
    <section className={`team-timeline${open ? " is-open" : ""}`}>
      <button type="button" className="team-timeline-summary" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <CaretDown size={12} weight="bold" aria-hidden="true" />
        <b>时间轴（谁跟谁在并行）</b>
        <DeliverySummary workers={workers} />
        <span>{open ? "收起" : "展开"}</span>
      </button>
      {open && (
        <div className="team-gantt">
          {rows.map((row, index) => (
            <div className="team-gantt-row" key={row.id ?? `lead-${index}`}>
              <button type="button" disabled={!row.id} title={row.name} onClick={() => row.id && onOpenWorker(row.id)}>{row.name}</button>
              <div className="team-gantt-track">
                {row.pendingOnly && <i className="team-gantt-pending" title="尚未开始" />}
                {row.bars.map((bar, barIndex) => (
                  <i
                    key={barIndex}
                    className={`team-gantt-bar team-gantt-bar--${bar.tone}${bar.pending ? " is-hatched" : ""}`}
                    title={bar.title}
                    style={{ left: `${percent(bar.from)}%`, width: `${Math.max(1.4, percent(bar.to) - percent(bar.from))}%` }}
                  />
                ))}
              </div>
            </div>
          ))}
          <div className="team-gantt-axis">
            <span>0s</span><span>{formatDuration(span / 2)}</span><span>{settled ? `收工 ${formatInstant(new Date(end).toISOString())}` : "现在"}</span>
          </div>
        </div>
      )}
    </section>
  );
}

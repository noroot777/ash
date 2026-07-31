// /team 的瀑布时间轴:每个执行者一条 track,色条 = startedAt → (endedAt ?? 现在),
// 按状态着色(色号统一取 StatusIcon 那套,不另立一套)。回答的是「谁跟谁在并行、
// 谁把谁堵住了」——这是编排视图里唯一看不出来又必须看出来的信息。
//
// 调度者那条 track 没有独立的数据源,由客户端从已解析的会话推出来(每个回合一段)。
import { useState } from "react";
import type { Group, Task } from "@harness/shared";
import { isTeamSettled, timeMs } from "@harness/shared/team";
import { CaretDown } from "@phosphor-icons/react";
import { statusColor } from "../StatusIcon";
import { formatDuration, formatInstant, useTick } from "../time";
import { teamLeadExecutorLabel } from "../executorLabel";
import { TeamStageSummary } from "./TeamStageSummary";
import type { LeadTurn } from "./teamData";

type Bar = { from: number; to: number; color: string; hatch?: boolean; title: string };
type Row = { id?: string; name: string; bars: Bar[]; pendingOnly?: boolean };

export function TeamTimeline({
  lead,
  leadTurns,
  workers,
  groups,
  onOpen,
}: {
  lead: Task;
  leadTurns: LeadTurn[];
  workers: Task[];
  groups: Group[];
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const leadLive = lead.status === "running";
  const settled = isTeamSettled(leadLive, workers);
  // 只有真的还在跑/排队时才按秒重算；paused/settled 都不会自发变化。
  const live = leadLive || workers.some((w) => w.status === "running" || w.status === "queued");
  const nowMs = useTick(open && live);
  const fallbackEnd = timeMs(lead.endedAt) ?? timeMs(lead.updatedAt) ?? nowMs;
  const openEnd = settled ? fallbackEnd : nowMs;
  const rows: Row[] = [
    {
      name: `调度者 ${teamLeadExecutorLabel(lead)}`,
      bars: leadTurns
        .map((t) => {
          const ended = t.to ?? openEnd;
          const openTurn = t.to === null && live;
          return {
            from: t.from,
            to: ended,
            color: statusColor(openTurn ? "running" : "done"),
            title: t.to !== null
              ? `回合用时 ${formatDuration(ended - t.from)}`
              : openTurn
                ? "正在说话"
                : "回合结束时间缺失",
          };
        })
        .filter((b) => Number.isFinite(b.from)),
    },
    ...workers.map((w, i) => {
      const groupPaused = !!(w.groupId && groupById.get(w.groupId)?.paused);
      const start = timeMs(w.startedAt);
      const color = statusColor(w.status, !!w.question);
      if (start === null) {
        // 还没起跑(排队/待派):不编造过去的时间,只在轴的最右端画一小段斜纹,
        // 表示「从现在往后才轮到它」。
        return {
          id: w.id,
          name: `${i + 1} ${w.title}${groupPaused ? " · 组已停止" : ""}`,
          bars: [] as Bar[],
          pendingOnly: true,
        };
      }
      const recordedEnd = timeMs(w.endedAt);
      const end = recordedEnd ?? openEnd;
      return {
        id: w.id,
        name: `${i + 1} ${w.title}${groupPaused ? " · 组已停止" : ""}`,
        bars: [
          {
            from: start,
            to: end,
            color,
            hatch: w.status === "queued" || w.status === "backlog",
            title: `${formatDuration(end - start)}${recordedEnd === null ? " · 进行中" : ""}${groupPaused ? ` · ${w.status === "done" ? "执行者已正常完成，所属组已停止" : "所属组已停止"}` : ""}`,
          },
        ],
      };
    }),
  ];

  const all = rows.flatMap((r) => r.bars);
  const t0 = all.length ? Math.min(...all.map((b) => b.from)) : nowMs;
  const t1 = all.length ? Math.max(...all.map((b) => b.to)) : nowMs;
  const span = Math.max(1000, t1 - t0);
  const pct = (t: number) => ((t - t0) / span) * 100;
  const rightLabel = settled ? `收工 ${formatInstant(new Date(t1).toISOString())}` : "现在";

  return (
    <div className="mt-2.5 border-t border-dashed border-line pt-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1 text-[11.5px] text-faint transition-colors hover:text-muted"
        >
          <CaretDown size={11} weight="bold" className={`transition-transform ${open ? "" : "-rotate-90"}`} />
          时间轴（谁跟谁在并行）
        </button>
        <TeamStageSummary workers={workers} />
      </div>
      {open && (
        <div className="mt-1.5 grid items-center gap-x-2.5 gap-y-1" style={{ gridTemplateColumns: "132px 1fr" }}>
          {rows.map((r, i) => (
            <Track key={r.id ?? `lead${i}`} row={r} pct={pct} onOpen={onOpen} />
          ))}
          <div className="col-start-2 flex justify-between text-[10px] text-faint">
            {[0, 0.25, 0.5, 0.75].map((f) => (
              <span key={f}>{formatDuration(span * f)}</span>
            ))}
            <span>{rightLabel}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Track({ row, pct, onOpen }: { row: Row; pct: (t: number) => number; onOpen: (id: string) => void }) {
  return (
    <>
      <button
        onClick={() => row.id && onOpen(row.id)}
        disabled={!row.id}
        title={row.name}
        className={`truncate text-left text-[11.5px] text-muted ${row.id ? "hover:text-ink" : "cursor-default"}`}
      >
        {row.name}
      </button>
      <div className="relative h-[9px] rounded-full bg-raised">
        {row.pendingOnly && (
          <span
            title="尚未开始（排队等前面的执行者）"
            className="absolute right-0 top-0 h-[9px] w-[7%] rounded-full"
            style={{
              background:
                "repeating-linear-gradient(45deg,#e2e3e8,#e2e3e8 4px,#eceef2 4px,#eceef2 8px)",
            }}
          />
        )}
        {row.bars.map((b, i) => (
          <span
            key={i}
            title={b.title}
            className="absolute top-0 h-[9px] rounded-full"
            style={{
              left: `${pct(b.from)}%`,
              width: `${Math.max(1.5, pct(b.to) - pct(b.from))}%`,
              background: b.hatch
                ? `repeating-linear-gradient(45deg,${b.color},${b.color} 4px,transparent 4px,transparent 8px)`
                : b.color,
            }}
          />
        ))}
      </div>
    </>
  );
}

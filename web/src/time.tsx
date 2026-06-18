import { useEffect, useState } from "react";
import type { Task } from "@harness/shared";
import { Clock } from "@phosphor-icons/react";

// ── formatting ───────────────────────────────────────────────────────────────
// Instant: compact local "MM/DD HH:mm" (e.g. 06/13 15:35).
export function formatInstant(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Duration: "1h 15m 3s" — from the largest non-zero unit down to seconds (days
// fold in past 24h). Sub-second rounds to "0s".
export function formatDuration(ms: number): string {
  let s = Math.floor((Number.isFinite(ms) ? ms : 0) / 1000);
  if (s < 0) s = 0;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function durationText(from?: string | null, to?: string | null, nowMs?: number): string {
  if (!from) return "";
  const start = new Date(from).getTime();
  if (Number.isNaN(start)) return "";
  const end = to ? new Date(to).getTime() : (nowMs ?? Date.now());
  return formatDuration(end - start);
}

// Re-render once a second while `active` (so a live "用时" ticks). Returns the
// current epoch ms each render. Hook order is stable (always called).
function useTick(active: boolean): number {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => bump((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
  return Date.now();
}

// ── display components ───────────────────────────────────────────────────────
// Elapsed time from→to. While `to` is absent (the run is live) it ticks every
// second; once `to` is set it's static.
export function Duration({
  from,
  to,
  className,
}: {
  from?: string | null;
  to?: string | null;
  className?: string;
}) {
  const live = !!from && !to;
  const nowMs = useTick(live);
  const t = durationText(from, to, nowMs);
  return t ? <span className={className}>{t}</span> : null;
}

// Compact lifecycle-time chip — the title-row replacement for the old full-width
// 创建·开始·结束·用时 row. Shows the single most relevant figure (用时 once a run
// exists, otherwise the 创建 instant); the full breakdown lives in the tooltip so
// it costs no extra width and stays glued to the title. Live-ticks while running.
export function TaskTimeChip({ task, className }: { task: Task; className?: string }) {
  const running = task.status === "running" || task.status === "queued";
  const tip = [
    `创建 ${formatInstant(task.createdAt)}`,
    task.startedAt && `开始 ${formatInstant(task.startedAt)}`,
    task.endedAt && `结束 ${formatInstant(task.endedAt)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span
      title={tip}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] text-faint ${className ?? ""}`}
    >
      <Clock size={12} className="shrink-0" />
      {task.startedAt ? (
        <span className={running ? "text-muted" : undefined}>
          用时 <Duration from={task.startedAt} to={task.endedAt} />
        </span>
      ) : (
        <span>创建 {formatInstant(task.createdAt)}</span>
      )}
    </span>
  );
}

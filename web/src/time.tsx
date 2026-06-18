import { useEffect, useState } from "react";
import type { Task } from "@harness/shared";

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

// One muted line summarizing a task's lifecycle times: 创建 · 开始 · 结束 · 用时.
// Shown in the task detail / debate headers ("具体放哪儿" — under the controls).
export function TaskTimes({ task }: { task: Task }) {
  const running = task.status === "running" || task.status === "queued";
  const sep = <span className="text-line2">·</span>;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-faint">
      <span>创建 {formatInstant(task.createdAt)}</span>
      {task.startedAt && (
        <>
          {sep}
          <span>开始 {formatInstant(task.startedAt)}</span>
        </>
      )}
      {task.endedAt && (
        <>
          {sep}
          <span>结束 {formatInstant(task.endedAt)}</span>
        </>
      )}
      {task.startedAt && (
        <>
          {sep}
          <span className={running ? "text-muted" : ""}>
            用时 <Duration from={task.startedAt} to={task.endedAt} />
          </span>
        </>
      )}
    </div>
  );
}

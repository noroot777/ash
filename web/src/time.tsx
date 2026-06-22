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

// Lifecycle-time chip for the detail header. 创建/开始 used to hide in the tooltip;
// now they sit inline and always-on (创建 … · 开始 … · 用时 …) so the timeline is
// readable without hovering. 用时 live-ticks while running; 结束时刻 stays in the
// tooltip to keep the row compact. The title is flex-1/min-w-0, so it absorbs the
// extra width.
export function TaskTimeChip({ task, className }: { task: Task; className?: string }) {
  const running = task.status === "running" || task.status === "queued";
  // activeMs = real execution time (sum of each turn's active span); null on
  // historical tasks whose per-turn timing was never recorded. liveSince ticks
  // the currently-running turn on top of activeMs.
  const measured = typeof task.activeMs === "number";
  // 兼容期:server 重启前旧进程还没下发 activeMs(字段缺失=undefined)→ 暂沿用墙钟
  // 「用时」,与改动前完全一致,避免重启前所有任务突然变「跨度」。重启后字段出现
  // (数值=已测量 / null=历史无法还原)即切到新口径。
  const legacy = task.activeMs === undefined;
  const live = measured && !!task.liveSince && !task.endedAt;
  const nowMs = useTick(live);
  const ms = measured ? task.activeMs! + (live ? Math.max(0, nowMs - Date.parse(task.liveSince!)) : 0) : 0;
  const dot = <span className="text-line2">·</span>;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] text-faint ${className ?? ""}`}
    >
      <Clock size={12} className="shrink-0" />
      <span>创建 {formatInstant(task.createdAt)}</span>
      {task.startedAt && (
        <>
          {dot}
          <span>开始 {formatInstant(task.startedAt)}</span>
          {dot}
          {measured ? (
            <span
              className={running ? "text-muted" : undefined}
              title={task.endedAt ? `结束 ${formatInstant(task.endedAt)}` : undefined}
            >
              用时 {formatDuration(ms)}
            </span>
          ) : legacy ? (
            // 兼容期:旧 server 未下发执行时间 → 沿用墙钟,行为同改动前。
            <span
              className={running ? "text-muted" : undefined}
              title={task.endedAt ? `结束 ${formatInstant(task.endedAt)}` : undefined}
            >
              用时 <Duration from={task.startedAt} to={task.endedAt} />
            </span>
          ) : (
            // Historical task: turns predate per-turn timing, so execution time
            // can't be reconstructed. Show the lifespan as 跨度 (with a note that
            // it includes idle waits) instead of passing the wait-inflated wall
            // clock off as 用时.
            <span
              className="text-faint"
              title={`${task.endedAt ? `结束 ${formatInstant(task.endedAt)} · ` : ""}跨度含等待回复的空闲，非纯执行时长`}
            >
              跨度 {durationText(task.startedAt, task.endedAt)}
            </span>
          )}
        </>
      )}
    </span>
  );
}

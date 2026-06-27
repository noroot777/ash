import type { TaskStatus } from "@harness/shared";

// Linear-style status glyphs: ringed circles with a pie-fill for progress,
// filled disc + check for done, etc. (Replaces plain colored dots.)
const COLOR: Record<TaskStatus, string> = {
  backlog: "#9ca1a9",
  queued: "#9499a1",
  running: "#e2b203", // Linear in-progress yellow
  awaiting_review: "#8b5cf6",
  paused: "#06b6d4", // cyan：跑到检查点等续跑——比 running 蓝、不抢 done 的 indigo
  done: "#5e6ad2", // Linear done indigo
  failed: "#eb5757",
  canceled: "#9ca1a9",
};

export function StatusIcon({ status, size = 14 }: { status: TaskStatus; size?: number }) {
  const c = COLOR[status];
  const ring = (extra?: React.ReactNode, dash?: string) => (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="5.25" stroke={c} strokeWidth="1.5" strokeDasharray={dash} />
      {extra}
    </svg>
  );
  // pie wedge via thick stroke on a small radius (circumference of r=2.6 ≈ 16.34)
  const pie = (pct: number) => (
    <circle
      cx="7"
      cy="7"
      r="2.6"
      fill="none"
      stroke={c}
      strokeWidth="5.2"
      strokeDasharray={`${(16.34 * pct).toFixed(2)} 16.34`}
      transform="rotate(-90 7 7)"
    />
  );

  switch (status) {
    case "backlog":
      return ring(undefined, "1.6 1.6");
    case "queued":
      return ring();
    case "running":
      return ring(pie(0.5));
    case "awaiting_review":
      return ring(pie(0.7));
    case "paused":
      // 虚线 ring（等待中）+ 经典的两根小竖条（pause 视觉语言）；颜色 cyan，
      // 区别于 running 的 yellow。一眼能扫出「在等不在跑」。
      return (
        <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden>
          <circle cx="7" cy="7" r="5.25" stroke={c} strokeWidth="1.5" strokeDasharray="1.6 1.6" />
          <rect x="5" y="4.5" width="1.3" height="5" fill={c} />
          <rect x="7.7" y="4.5" width="1.3" height="5" fill={c} />
        </svg>
      );
    case "done":
      return (
        <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden>
          <circle cx="7" cy="7" r="6" fill={c} />
          <path d="M4.4 7.2l1.7 1.7 3.3-3.6" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "failed":
      return (
        <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden>
          <circle cx="7" cy="7" r="5.25" stroke={c} strokeWidth="1.5" />
          <path d="M5 5l4 4M9 5l-4 4" stroke={c} strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case "canceled":
      return (
        <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden>
          <circle cx="7" cy="7" r="6" fill={c} />
          <path d="M4.8 4.8l4.4 4.4" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
  }
}

import type { TaskStatus } from "@harness/shared";

// Linear-style status glyphs: ringed circles with a pie-fill for progress,
// filled disc + check for done, etc. (Replaces plain colored dots.)
//
// 配色分工（照 Claude Code 里那套「一眼看出该不该管」的分级）：
// - 「有人在问你话」= 青 #06b6d4 实心圈 + 白问号 —— 全表最扎眼的一格，因为它是
//   唯一「不动手就永远停在这」的状态。它不是一个 TaskStatus，而是「paused/idle +
//   question 非空」的组合，所以走 awaitingAnswer 这个额外入参，不进 COLOR 表。
// - 检查点 paused（harness 自己会续跑，不用人管）让位到蓝灰 #64748b。
// - idle 是团队指挥台专有：在线待命，空心圈 + 中心小点。
const COLOR: Record<TaskStatus, string> = {
  backlog: "#9ca1a9",
  queued: "#9499a1",
  running: "#e2b203", // Linear in-progress yellow
  awaiting_review: "#8b5cf6",
  paused: "#64748b", // 蓝灰：跑到检查点等续跑，harness 自己会推进——不该抢注意力
  idle: "#64748b", // 指挥台在线但这一刻没在说话
  done: "#5e6ad2", // Linear done indigo
  failed: "#eb5757",
  canceled: "#9ca1a9",
};

const ATTENTION = "#06b6d4"; // 「等你答复」专用青

// 同一套配色的取值口 —— 给不能用 <StatusIcon> 的地方(/team 时间轴的色条)用,
// 免得再抄一份色号出去漂移。
export function statusColor(status: TaskStatus, awaitingAnswer?: boolean): string {
  return awaitingAnswer ? ATTENTION : COLOR[status];
}

export function StatusIcon({
  status,
  size = 14,
  awaitingAnswer,
}: {
  status: TaskStatus;
  size?: number;
  /** 有人在问你话（paused/idle + question 非空）：盖掉 status 图标，画成青色实心问号 */
  awaitingAnswer?: boolean;
}) {
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

  if (awaitingAnswer) {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden>
        <circle cx="7" cy="7" r="6" fill={ATTENTION} />
        <path
          d="M5.4 5.1c0-.9.75-1.5 1.6-1.5.9 0 1.6.6 1.6 1.45 0 .7-.42 1.02-.95 1.4-.5.36-.65.6-.65 1.05v.3"
          stroke="#fff"
          strokeWidth="1.25"
          strokeLinecap="round"
          fill="none"
        />
        <circle cx="7" cy="10.3" r="0.85" fill="#fff" />
      </svg>
    );
  }

  switch (status) {
    case "backlog":
      return ring(undefined, "1.6 1.6");
    case "queued":
      return ring();
    case "running":
      return ring(pie(0.5));
    case "awaiting_review":
      return ring(pie(0.7));
    case "idle":
      // 指挥台待命：空心圈 + 中心一个小点（「在线，但没在说话」）。
      return ring(<circle cx="7" cy="7" r="1.6" fill={c} />);
    case "paused":
      // 虚线 ring（等待中）+ 经典的两根小竖条（pause 视觉语言）。蓝灰色，
      // 明确表示「harness 自己会续跑，不用你管」。
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

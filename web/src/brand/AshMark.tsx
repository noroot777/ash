import { MARK, MARK_SIZE, type Run } from "./ashMark.ts";

/** 把几条格子画成 rect。墨色跟文字色走，亮的那一格是 --accent。 */
export const markDots = (runs: Run[], dx = 0) =>
  runs.map((run) => (
    <rect
      key={`${run.x},${run.y}`}
      x={run.x + dx}
      y={run.y}
      width={run.w}
      height={1}
      fill={run.accent ? "var(--accent)" : "currentColor"}
    />
  ));

const DOTS = markDots(MARK);

/**
 * ash 的标，静止的那张。size 取 8 的倍数（16 / 24 / 32），格子才落在整像素上。
 * 它独自代表「ash」时给 label，读屏才念得出来；旁边已经写着名字就不用。
 */
export function AshMark({ size = 16, label, className }: { size?: number; label?: string; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${MARK_SIZE} ${MARK_SIZE}`}
      shapeRendering="crispEdges"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {DOTS}
    </svg>
  );
}

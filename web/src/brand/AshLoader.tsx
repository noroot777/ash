import type { CSSProperties } from "react";
import { LOADER_LINES, LOADER_TIP, MARK_SIZE } from "./ashMark.ts";

// 格子按「火同时烧到的那条斜线」分组，每组只带一个数：第几拍轮到它。怎么亮、怎么淡、
// 一拍多长都在样式那边（styles/ash-loader.css）。所有实例共用这一份元素。
const LINES = LOADER_LINES.map((line) => (
  <g key={line.step} className="ash-loader__line" style={{ "--step": line.step } as CSSProperties}>
    {line.cells.map((cell) => (
      <rect key={`${cell.x},${cell.y}`} x={cell.x} y={cell.y} width={1} height={1} />
    ))}
  </g>
));
const TIP = <rect className="ash-loader__tip" x={LOADER_TIP.x} y={LOADER_TIP.y} width={1} height={1} />;

/**
 * ash 的标动起来：一道火从左下角烧到右上角，烧过的格子亮一下再淡回来。等一块内容读出来的地方用它。
 *
 * 墨色跟文字色走，亮色是 --accent。size 取 8 的倍数（16 / 24 / 32），格子才落在整像素上。
 * 旁边已经有一句「正在读取…」时不用给 label；它独自表示「在加载」时给一个，读屏才念得出来。
 */
export function AshLoader({ size = 16, label, className }: { size?: number; label?: string; className?: string }) {
  return (
    <svg
      className={className ? `ash-loader ${className}` : "ash-loader"}
      width={size}
      height={size}
      viewBox={`0 0 ${MARK_SIZE} ${MARK_SIZE}`}
      shapeRendering="crispEdges"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {LINES}
      {TIP}
    </svg>
  );
}

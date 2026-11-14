import type { CSSProperties } from "react";
import { markDots } from "./AshMark.tsx";
import { LOADER_FRAMES, LOADER_STILL, LOADER_TICK_MS, MARK_SIZE } from "./ashMark.ts";

// 一卷胶片：十四拍横着排开，样式那边（styles/ash-loader.css）一拍推一格。每一拍都是整格的图，
// 不做补间 —— 这张图是点阵，块只能一格一格地跳。所有实例共用这一份元素。
const STILL = markDots(LOADER_STILL);
const REEL = LOADER_FRAMES.map((frame, tick) => <g key={tick}>{markDots(frame, tick * MARK_SIZE)}</g>);
const TIMING = {
  "--ash-loader-frames": LOADER_FRAMES.length,
  "--ash-loader-tick": `${LOADER_TICK_MS}ms`,
} as CSSProperties;

/**
 * ash 的标动起来：散出去的那几块收回来合成一整块，停一下，再炸开。等一块内容读出来的地方用它。
 *
 * 墨色跟文字色走，亮的那一格是 --accent。size 取 8 的倍数（16 / 24 / 32），格子才落在整像素上。
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
      style={TIMING}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {STILL}
      <g className="ash-loader__reel">{REEL}</g>
    </svg>
  );
}

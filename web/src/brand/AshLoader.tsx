import type { CSSProperties } from "react";
import { markDots } from "./AshMark.tsx";
import { LOADER_STILL, LOADER_SWING_MS, LOADER_TAIL, MARK_SIZE } from "./ashMark.ts";

// 身子画一次不动；尾巴上的每一块各带自己的摆幅和起步时刻，怎么摆在样式那边（styles/ash-loader.css）。
// 起步时刻往前拨半程，是让它一出现就从正中间那个姿势（静止的标）开始摆，而不是从一头开始。
// 所有实例共用这一份元素。
const STILL = markDots(LOADER_STILL);
const TAIL = LOADER_TAIL.map((dot) => (
  <rect
    key={`${dot.x},${dot.y}`}
    className="ash-loader__tail"
    x={dot.x}
    y={dot.y}
    width={1}
    height={1}
    fill={dot.accent ? "var(--accent)" : "currentColor"}
    style={{ "--dx": dot.dx, "--dy": dot.dy, animationDelay: `${dot.lagMs - LOADER_SWING_MS / 2}ms` } as CSSProperties}
  />
));
const TIMING = { "--ash-loader-swing": `${LOADER_SWING_MS}ms` } as CSSProperties;

/**
 * ash 的标动起来：身子不动，右上那一撮像尾巴一样左右甩。等一块内容读出来的地方用它。
 *
 * 墨色跟文字色走，亮的那一格是 --accent。size 取 8 的倍数（16 / 24 / 32），格子才落在整像素上；
 * 尾巴尖摆到头时会探出这个尺寸将近一格，紧贴着会裁切的边时留一点空。
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
      {TAIL}
    </svg>
  );
}

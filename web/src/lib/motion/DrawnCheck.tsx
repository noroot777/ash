import { useLayoutEffect, useRef } from "react";
import { animate, createDrawable } from "animejs";
import { motionReduced } from "../useSwapText.ts";

/**
 * 对勾（审查通过）。`draw` 为真的那一次提交从起笔描到收笔（360ms）；平时、减少动效时直接画好。
 * 用一笔描边的折线而不是图标库的填充形状：描线只对描边成立。
 */
export function DrawnCheck({ size = 16, draw }: { size?: number; draw: boolean }) {
  const line = useRef<SVGPolylineElement>(null);
  useLayoutEffect(() => {
    const el = line.current;
    if (!draw || !el || motionReduced()) return;
    const [drawable] = createDrawable(el);
    const run = animate(drawable, { draw: ["0 0", "0 1"], duration: 360, ease: "outQuad" });
    return () => { run.revert(); };
  }, [draw]);
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <polyline ref={line} points="3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

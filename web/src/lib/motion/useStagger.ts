import { useLayoutEffect, type RefObject } from "react";
import { animate, stagger } from "animejs";
import { motionReduced } from "../useSwapText.ts";

/** 最多编排这么多行：再往下的已经在视野外，一起出现就行。 */
const MAX_ROWS = 12;

/**
 * 依次展开：你自己点开的折叠里，各行一条接一条淡入上移（每条间隔 45ms，一段 360ms）。
 * `trigger` 每次点开时加一（0 = 还没点过）：只在这一下播，会话流里系统触发的变化不走这里。
 * 在点击的那一拍就把各行压成透明，免得折叠打开、动画还没起的那一帧先整块闪一下。
 */
export function useStagger(root: RefObject<HTMLElement | null>, selector: string, trigger: number): void {
  useLayoutEffect(() => {
    const host = root.current;
    if (!trigger || !host || motionReduced()) return;
    const rows = [...host.querySelectorAll<HTMLElement>(selector)].slice(0, MAX_ROWS);
    if (!rows.length) return;
    const reset = () => rows.forEach((row) => { row.style.opacity = ""; row.style.transform = ""; });
    rows.forEach((row) => { row.style.opacity = "0"; });
    const run = animate(rows, {
      opacity: [0, 1],
      y: [6, 0],
      delay: stagger(45),
      duration: 360,
      ease: "outExpo",
      onComplete: reset,
    });
    return () => { run.pause(); reset(); };
  }, [trigger, root, selector]);
}

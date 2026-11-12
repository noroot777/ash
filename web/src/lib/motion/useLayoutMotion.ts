import { useLayoutEffect, useRef, type RefObject } from "react";
import { animate } from "animejs";
import { motionReduced } from "../useSwapText.ts";

/** 重排（docs/ui-ux-audit 08「点睛」之一）：留下的滑到新位置，新来的淡入。 */
const MOVE_MS = 320;
const ENTER_MS = 200;

type Point = { x: number; y: number };

/** 到页面的版面位置。走 offsetParent 链，不受正在播的 transform、也不受中间滚动的影响。 */
function pageOffset(el: HTMLElement): Point {
  let x = 0;
  let y = 0;
  for (let node: HTMLElement | null = el; node; node = node.offsetParent as HTMLElement | null) {
    x += node.offsetLeft;
    y += node.offsetTop;
  }
  return { x, y };
}

/**
 * 每次提交后量一遍 root 里匹配 `selector` 的元素：位置变了的从旧位置滑过去，第一次出现的淡入，
 * 头一次量（挂上那一刻）什么都不动。元素按身份认（React 按 key 保住的就是同一个 DOM 节点）。
 * 只动 transform 和 opacity；动完把内联样式还回去，不跟组件自己的样式抢。
 */
export function useLayoutMotion(root: RefObject<HTMLElement | null>, selector: string): void {
  const last = useRef<WeakMap<HTMLElement, Point> | null>(null);
  useLayoutEffect(() => {
    const host = root.current;
    if (!host) return;
    const origin = pageOffset(host);
    const next = new WeakMap<HTMLElement, Point>();
    const previous = last.current;
    const animateNow = previous !== null && !motionReduced();
    // 滚出视野很远的不播：一长串侧栏行整体下移一格时，只有看得见的那几十行值得动。
    const viewTop = host.scrollTop - host.clientHeight;
    const viewBottom = host.scrollTop + host.clientHeight * 2;
    for (const el of host.querySelectorAll<HTMLElement>(selector)) {
      if (!el.offsetParent && el.getClientRects().length === 0) continue;
      const page = pageOffset(el);
      const at = { x: page.x - origin.x, y: page.y - origin.y };
      next.set(el, at);
      if (!animateNow) continue;
      const before = previous.get(el);
      if (!before) {
        animate(el, { opacity: [0, 1], duration: ENTER_MS, ease: "outQuad", onComplete: () => { el.style.opacity = ""; } });
        continue;
      }
      if ((before.y < viewTop || before.y > viewBottom) && (at.y < viewTop || at.y > viewBottom)) continue;
      const dx = before.x - at.x;
      const dy = before.y - at.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      animate(el, {
        x: [dx, 0],
        y: [dy, 0],
        duration: MOVE_MS,
        ease: "outExpo",
        onComplete: () => { el.style.transform = ""; },
      });
    }
    last.current = next;
  });
}

import { useEffect, useRef, useState } from "react";
import { motionReduced } from "./useSwapText.ts";

/** 每拍间隔：一拍放一点。 */
const TICK_MS = 40;
/** 一拍放多少 = 积压 ÷ 这个数（向上取整）：积压越多放得越快，一坨 40 字大约半秒放完。 */
const BACKLOG_SHARE = 14;
/** 同一个淡入片段收多久的字：片段是淡入的最小单位，也是 React 认它的那一格（见 freshText）。 */
const SLOT_MS = 120;

/** 一段新放出来的字：从正文的 `from` 起，到下一段的 `from` 为止；`at` 是它开始放的时刻。 */
export type FreshMark = { from: number; at: number };

/**
 * 正文是服务端攒一坨发一坨的；这里把它匀开放（docs/ui-ux-audit run-4）。
 *
 * - 只在 `live` 时放；不在飞、或「减少动效」时直接给全文。
 * - 挂上那一刻已经在的字不放第二遍（刷新页面、切回来时整段直接在）。
 * - 新到的字不是接在已放的后面（重写、换了一份）时直接跳到全文，不从头再放。
 */
export function useSmoothText(target: string, live: boolean): { text: string; marks: FreshMark[] } {
  const [shown, setShown] = useState(target.length);
  const marks = useRef<FreshMark[]>([]);
  const previous = useRef(target);
  const animate = live && !motionReduced();

  let length = Math.min(shown, target.length);
  if (!animate || !target.startsWith(previous.current.slice(0, length))) {
    length = target.length;
    marks.current = [];
  }
  previous.current = target;

  useEffect(() => {
    if (length !== shown) setShown(length);
    if (!animate || length >= target.length) return;
    const timer = window.setTimeout(() => {
      let next = length + Math.ceil((target.length - length) / BACKLOG_SHARE);
      // 别把一个代理对劈成两半（表情、生僻字）。
      if (next < target.length && /[\uD800-\uDBFF]/.test(target[next - 1] ?? "")) next += 1;
      const now = performance.now();
      const last = marks.current.at(-1);
      if (!last || now - last.at > SLOT_MS) marks.current = [...marks.current, { from: length, at: now }];
      setShown(next);
    }, TICK_MS);
    return () => window.clearTimeout(timer);
  }, [animate, length, shown, target]);

  return { text: target.slice(0, length), marks: animate ? marks.current : [] };
}

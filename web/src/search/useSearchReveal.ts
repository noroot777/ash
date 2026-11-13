import { useEffect, useState, type RefObject } from "react";
import {
  findOccurrences,
  flashOccurrences,
  pendingSearchReveal,
  pickOccurrence,
  scrollToOccurrence,
  settleSearchReveal,
  subscribeSearchReveal,
} from "./searchReveal.ts";

/** 打开一层折叠之后等它画完再找：onToggle → 状态 → 重画是异步的，旧的 Range 可能已经作废。 */
const UNFOLD_SETTLE_MS = 60;
/**
 * 没找到之后隔多久再找。在跑的任务每出一个字 DOM 就变一次，每一帧把整条会话的文字过一遍
 * 太贵；词要是只在不上屏的执行轨迹里，这样空转要一直转到待办过期。
 */
const RETRY_GAP_MS = 250;

/**
 * 会话这一侧：⌘K 给这个任务挂了待办（requestSearchReveal），就在会话读完后把视口落到命中处、
 * 闪几下关键词。
 *
 * - `ready`：正文读完过一轮。之前落下去，正文一到又被挤走；也可能只找到了原始需求里那一处。
 * - `detach`：贴底逻辑的「读者要往回看」（useStickToBottom 的 noteUserScrollIntent）。落地之前
 *   先打这声招呼，否则首屏那次落到最新一条、或者下一条新消息，会把人从落点拽回底部。
 * - 内容还在长、词还没出现就接着等（MutationObserver），到期或读者自己滚了就作罢。
 */
export function useSearchReveal(
  scrollRef: RefObject<HTMLElement | null>,
  taskId: string | null,
  ready: boolean,
  detach: (detachFromBottom: boolean) => void,
) {
  // 同一个任务已经开着时再从 ⌘K 打开它：没有换任务、也没有新内容，靠这个叫醒。
  const [requested, setRequested] = useState(0);
  useEffect(() => subscribeSearchReveal(() => setRequested((value) => value + 1)), []);

  useEffect(() => {
    const container = scrollRef.current;
    if (!taskId || !ready || !container) return;
    const request = pendingSearchReveal(taskId);
    if (!request) return;
    let frame = 0;
    let unfolds = 0;
    let timer = 0;
    let quietUntil = 0;
    let done = false;

    const attempt = () => {
      frame = 0;
      // 面板被藏起来了（窄屏切走、display:none）：几何全是 0，等它回来。
      if (done || !container.clientHeight) return;
      const found = findOccurrences(container, request.terms);
      const target = pickOccurrence(found, request.hint);
      if (!target) {
        quietUntil = performance.now() + RETRY_GAP_MS;
        return;
      }
      if (target.closed.length) {
        if (unfolds >= 2) return finish();
        unfolds += 1;
        target.closed.forEach((fold) => { fold.open = true; });
        quietUntil = performance.now() + UNFOLD_SETTLE_MS;
        schedule();
        return;
      }
      finish();
      detach(true);
      scrollToOccurrence(container, target);
      flashOccurrences(found, target);
    };
    const schedule = () => {
      if (frame || timer || done) return;
      const wait = quietUntil - performance.now();
      if (wait <= 0) {
        frame = requestAnimationFrame(attempt);
        return;
      }
      timer = window.setTimeout(() => {
        timer = 0;
        schedule();
      }, wait);
    };
    // 内容长出来（MutationObserver）、或者藏着的面板重新露出来（ResizeObserver，DOM 不变）都再找一次。
    const observer = new MutationObserver(schedule);
    const resized = new ResizeObserver(schedule);
    // 只停手，不清待办：卸载 / 换视图时走这一支，同一个任务换个视图重新挂上来（团队台 ⇄ 普通
    // 视图）还接着找。
    const stop = () => {
      done = true;
      observer.disconnect();
      resized.disconnect();
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      window.clearTimeout(expiry);
      container.removeEventListener("wheel", finish);
      container.removeEventListener("touchmove", finish);
    };
    // 落地了、到期了，或者读者自己动了（等会话读出来的那几秒里他可能已经开始往上翻）：这张待办用掉。
    function finish() {
      settleSearchReveal(request!);
      stop();
    }
    const expiry = window.setTimeout(finish, Math.max(0, request.expires - Date.now()));
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    resized.observe(container);
    container.addEventListener("wheel", finish, { passive: true });
    container.addEventListener("touchmove", finish, { passive: true });
    schedule();
    return stop;
  }, [detach, ready, requested, scrollRef, taskId]);
}

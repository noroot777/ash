import { useCallback, useEffect, useRef, type RefObject } from "react";

/** 离底多近算「还想看最新」。只决定要不要**跟随**，不决定要不要动 scrollTop。 */
export const STICK_TO_BOTTOM_THRESHOLD = 80;
/** 算「已经贴着底」的像素容差:缩放和高 DPI 下这个差值常带零点几 px 的残留。 */
const BOTTOM_EPSILON = 2;
const OVERLAY_SCROLLBAR_HITBOX = 18;

const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

const isEditableTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest("input, textarea, select, button, [contenteditable='true'], [contenteditable='']");
};

const distanceFromBottom = (element: HTMLElement) =>
  element.scrollHeight - element.scrollTop - element.clientHeight;

const isNearBottom = (element: HTMLElement, threshold: number) =>
  distanceFromBottom(element) <= threshold;

/* 贴底要跟的是这个数而不是 scrollHeight:内容长高、容器被回复框挤矮,两种都让底边往
   下跑,都该跟;而气泡上换个 class、工具栏亮一下不改变它,就不该动用户的滚动位置。 */
const maxScrollTop = (element: HTMLElement) =>
  Math.max(0, element.scrollHeight - element.clientHeight);

/* 这一批 DOM 变更有没有往会话末尾添东西。判据是「新节点的底边落在最后一屏内」而不是
   「它是不是最后一个子元素」—— 会话流的末尾常年挂着尾巴组件(问题补档、footer),新回复
   是插在它**前面**的;反过来往顶上补历史也会往同一个容器里塞节点,那个不能跟。 */
function mutationsAppendTail(element: HTMLElement, records: MutationRecord[]): boolean {
  // 容器内容坐标系:节点底边 - contentTop 就是它在 scrollHeight 里的位置。
  const contentTop = element.getBoundingClientRect().top - element.scrollTop;
  const lastScreenFrom = element.scrollHeight - element.clientHeight;
  const touchesTail = (node: Node | null | undefined) => {
    const target = node instanceof HTMLElement ? node : node?.parentElement ?? null;
    if (!target || !element.contains(target)) return false;
    return target.getBoundingClientRect().bottom - contentTop >= lastScreenFrom;
  };
  for (const record of records) {
    // 最后一条自己在逐字长(流式输出)。
    if (record.type === "characterData") {
      if (touchesTail(record.target)) return true;
      continue;
    }
    if (record.type !== "childList") continue;
    for (const node of record.addedNodes) {
      if (touchesTail(node)) return true;
    }
  }
  return false;
}

const cancelFrameRef = (ref: { current: number }) => {
  if (!ref.current) return;
  cancelAnimationFrame(ref.current);
  ref.current = 0;
};

const clearTimeoutRef = (ref: { current: number }) => {
  if (!ref.current) return;
  window.clearTimeout(ref.current);
  ref.current = 0;
};

const isScrollbarPointerDown = (event: PointerEvent, element: HTMLElement) => {
  const rect = element.getBoundingClientRect();
  const canScrollVertically = element.scrollHeight > element.clientHeight;
  const verticalScrollbarWidth = element.offsetWidth - element.clientWidth;
  if (verticalScrollbarWidth > 0 && event.clientX >= rect.right - verticalScrollbarWidth) return true;
  if (canScrollVertically && event.clientX >= rect.right - OVERLAY_SCROLLBAR_HITBOX) return true;

  const canScrollHorizontally = element.scrollWidth > element.clientWidth;
  const horizontalScrollbarHeight = element.offsetHeight - element.clientHeight;
  if (horizontalScrollbarHeight > 0 && event.clientY >= rect.bottom - horizontalScrollbarHeight) return true;
  if (canScrollHorizontally && event.clientY >= rect.bottom - OVERLAY_SCROLLBAR_HITBOX) return true;

  return false;
};

export function stickStateAfterScroll({
  stuck,
  nearBottom,
  programmatic,
  userDriven,
  detaching,
}: {
  stuck: boolean;
  nearBottom: boolean;
  programmatic: boolean;
  userDriven: boolean;
  detaching: boolean;
}): boolean {
  if (programmatic && !userDriven) return nearBottom ? true : stuck;
  if (userDriven) return nearBottom && !detaching;
  return nearBottom ? true : stuck;
}

/* 一次贴底机会到底要不要动 scrollTop。贴底只为一件事服务:会话尾部多出了要看的东西,
   把视口跟着带下去。除此之外每一次 `scrollTo` 都只剩一个效果 —— 把人从他自己停的位置
   拽到最底,而那恰恰是用户没要的那一跳。 */
export function shouldStickToBottom({
  stuck,
  tailAppended,
  previousMax,
  currentMax,
  distance,
}: {
  stuck: boolean;
  /** 这一批变更往会话末尾添了东西(新回复,或最后一条还在逐字长)。 */
  tailAppended: boolean;
  previousMax: number;
  currentMax: number;
  distance: number;
}): boolean {
  if (!stuck) return false;
  /* 尾部来了新东西就跟,**不看总高度**。列表按最近 N 条截断时(群聊/侧聊/助手都是
     最近 500 条),追加一条的同时最老那条被删掉,总高可能纹丝不动甚至变短 —— 那恰恰
     是最该跟过去的一帧,拿「总高涨没涨」当唯一判据会把它整个漏掉。
     尾部没动时才退回看底边:容器被回复框挤矮、上方内容长高,也都该跟。 */
  if (!tailAppended && currentMax <= previousMax) return false;
  // 已经贴着底了,这一句 `scrollTo` 看着是空操作,其实会把浏览器手头那段滚轮平滑动画
  // 拦腰掐断 —— 滚到快见底时画面「啪」地一跳就是这么来的。
  return distance > BOTTOM_EPSILON;
}

export function useStickToBottom(
  scrollRef: RefObject<HTMLElement | null>,
  resetKey: string | number | null | undefined,
  threshold = STICK_TO_BOTTOM_THRESHOLD,
) {
  const stuckRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const userScrollIntentRef = useRef(false);
  const detachingUserIntentRef = useRef(false);
  const userIntentTimeoutRef = useRef(0);
  const scrollbarDragRef = useRef(false);
  const frameRef = useRef(0);
  const clearProgrammaticFrameRef = useRef(0);
  const lastMaxScrollRef = useRef(-1);
  const tailAppendedRef = useRef(false);

  const markProgrammaticScrollSettled = useCallback(() => {
    cancelFrameRef(clearProgrammaticFrameRef);
    let frames = 0;
    const tick = () => {
      frames += 1;
      if (frames >= 2) {
        clearProgrammaticFrameRef.current = 0;
        programmaticScrollRef.current = false;
        return;
      }
      clearProgrammaticFrameRef.current = requestAnimationFrame(tick);
    };
    clearProgrammaticFrameRef.current = requestAnimationFrame(tick);
  }, []);

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    lastMaxScrollRef.current = maxScrollTop(element);
    programmaticScrollRef.current = true;
    element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
    markProgrammaticScrollSettled();
  }, [markProgrammaticScrollSettled, scrollRef]);

  const scheduleStick = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const element = scrollRef.current;
      if (!element) return;
      const previousMax = lastMaxScrollRef.current;
      const currentMax = maxScrollTop(element);
      const tailAppended = tailAppendedRef.current;
      // 两个基准都在判 stuck 之前就先清,用户在上面读历史的那一段也照样跟着内容走 ——
      // 否则他滚回底部时积压的那一大截会被当成「刚长出来的」,又是平白一跳。
      lastMaxScrollRef.current = currentMax;
      tailAppendedRef.current = false;
      if (!shouldStickToBottom({
        stuck: stuckRef.current,
        tailAppended,
        previousMax,
        currentMax,
        distance: distanceFromBottom(element),
      })) return;
      scrollToBottom();
    });
  }, [scrollRef, scrollToBottom]);

  const clearUserIntent = useCallback(() => {
    userScrollIntentRef.current = false;
    detachingUserIntentRef.current = false;
    clearTimeoutRef(userIntentTimeoutRef);
  }, []);

  const noteUserScrollIntent = useCallback((detachFromBottom = true) => {
    userScrollIntentRef.current = true;
    detachingUserIntentRef.current = detachFromBottom;
    if (detachFromBottom) stuckRef.current = false;
    programmaticScrollRef.current = false;
    clearTimeoutRef(userIntentTimeoutRef);
    userIntentTimeoutRef.current = window.setTimeout(() => {
      if (!scrollbarDragRef.current) {
        userScrollIntentRef.current = false;
        detachingUserIntentRef.current = false;
      }
      userIntentTimeoutRef.current = 0;
    }, 800);
    cancelFrameRef(clearProgrammaticFrameRef);
  }, []);

  const resumeStickToBottom = useCallback(() => {
    stuckRef.current = true;
    detachingUserIntentRef.current = false;
    clearUserIntent();
    scrollbarDragRef.current = false;
  }, [clearUserIntent]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const nearBottom = isNearBottom(element, threshold);
    const userDriven = userScrollIntentRef.current || scrollbarDragRef.current;
    stuckRef.current = stickStateAfterScroll({
      stuck: stuckRef.current,
      nearBottom,
      programmatic: programmaticScrollRef.current,
      userDriven,
      detaching: detachingUserIntentRef.current,
    });
    /* 到此为止:这里**只**改「接下来跟不跟」,不碰 scrollTop,也不碰底边基准。
       —— 不碰 scrollTop,是因为滚轮和触控板在浏览器里是一段带惯性的平滑动画,它还没
          走完;此刻替用户把位置设到底,等于把那段动画掐掉再瞬移。
       —— 不碰基准,是因为 scroll 事件和 rAF 在同一帧里的次序是先 scroll 后 rAF:内容
          在视口上方长高时 Chrome 的 scroll anchoring 会先补一次 scrollTop,在这儿顺手
          把基准同步掉,`scheduleStick` 再醒来就看不出「底边往下跑过」,跟随会哑掉。
          基准统一由 `scheduleStick` 自己更新(它在判 stuck 之前就先记,不会漏)。 */
  }, [scrollRef, threshold]);

  useEffect(() => {
    stuckRef.current = true;
    // 换任务要的是「落在最新一条」,不是「跟随增长」—— 清掉基准让这一次无条件过闸。
    lastMaxScrollRef.current = -1;
    tailAppendedRef.current = false;
    scheduleStick();
  }, [resetKey, scheduleStick]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    let observedContent = new Set<Element>();
    const resizeObserver = new ResizeObserver(() => {
      updateObservedContent();
      scheduleStick();
    });
    const mutationObserver = new MutationObserver((records) => {
      if (mutationsAppendTail(element, records)) tailAppendedRef.current = true;
      updateObservedContent();
      scheduleStick();
    });
    const updateObservedContent = () => {
      const next = new Set<Element>(Array.from(element.children));
      for (const child of observedContent) {
        if (!next.has(child)) resizeObserver.unobserve(child);
      }
      for (const child of next) {
        if (!observedContent.has(child)) resizeObserver.observe(child);
      }
      observedContent = next;
    };

    resizeObserver.observe(element);
    updateObservedContent();

    const onWheel = (event: WheelEvent) => noteUserScrollIntent(event.deltaY < 0);
    const onTouchMove = () => noteUserScrollIntent(true);
    const onPointerDown = (event: PointerEvent) => {
      if (!isScrollbarPointerDown(event, element)) return;
      scrollbarDragRef.current = true;
      noteUserScrollIntent(true);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(event.key) || isEditableTarget(event.target)) return;
      if (event.key === "Home" || event.key === "PageUp" || event.key === "ArrowUp" || (event.key === " " && event.shiftKey)) {
        noteUserScrollIntent(true);
        return;
      }
      if (event.key === "End") {
        resumeStickToBottom();
        return;
      }
      noteUserScrollIntent(false);
    };
    const onPointerUp = () => {
      if (!scrollbarDragRef.current) return;
      scrollbarDragRef.current = false;
      clearUserIntent();
      // 松手落在哪儿就是哪儿:再补一次「吸」到底,同样是用户没要的那一跳。
      stuckRef.current = isNearBottom(element, threshold);
    };

    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("wheel", onWheel, { passive: true });
    element.addEventListener("touchmove", onTouchMove, { passive: true });
    element.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerup", onPointerUp);
    mutationObserver.observe(element, { childList: true, characterData: true, subtree: true });
    scheduleStick();

    return () => {
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerup", onPointerUp);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      observedContent = new Set();
    };
  }, [clearUserIntent, noteUserScrollIntent, onScroll, resetKey, resumeStickToBottom, scheduleStick, scrollRef, threshold]);

  useEffect(() => () => {
    clearTimeoutRef(userIntentTimeoutRef);
    cancelFrameRef(frameRef);
    cancelFrameRef(clearProgrammaticFrameRef);
    programmaticScrollRef.current = false;
    userScrollIntentRef.current = false;
    detachingUserIntentRef.current = false;
    scrollbarDragRef.current = false;
    tailAppendedRef.current = false;
  }, []);

  return {
    resume: resumeStickToBottom,
    noteUserScrollIntent,
    resumeStickToBottom,
  };
}

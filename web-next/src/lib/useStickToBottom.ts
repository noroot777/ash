import { useCallback, useEffect, useRef, type RefObject } from "react";

export const STICK_TO_BOTTOM_THRESHOLD = 80;
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
    programmaticScrollRef.current = true;
    element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
    markProgrammaticScrollSettled();
  }, [markProgrammaticScrollSettled, scrollRef]);

  const scheduleStick = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      if (stuckRef.current) scrollToBottom();
    });
  }, [scrollToBottom]);

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
    if (userDriven && stuckRef.current) scheduleStick();
  }, [scheduleStick, scrollRef, threshold]);

  useEffect(() => {
    stuckRef.current = true;
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
    const mutationObserver = new MutationObserver(() => {
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
      stuckRef.current = isNearBottom(element, threshold);
      if (stuckRef.current) scheduleStick();
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
  }, []);

  return {
    resume: resumeStickToBottom,
    noteUserScrollIntent,
    resumeStickToBottom,
  };
}

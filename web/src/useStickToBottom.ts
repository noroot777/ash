import { useCallback, useEffect, useRef, type RefObject } from "react";

export const STICK_TO_BOTTOM_THRESHOLD = 80;
const OVERLAY_SCROLLBAR_HITBOX = 18;

const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

const isEditableTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest("input, textarea, select, button, [contenteditable='true'], [contenteditable='']");
};

const distanceFromBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;

const isNearBottom = (el: HTMLElement, threshold: number) => distanceFromBottom(el) <= threshold;

const isScrollbarPointerDown = (event: PointerEvent, el: HTMLElement) => {
  const rect = el.getBoundingClientRect();
  const canScrollVertically = el.scrollHeight > el.clientHeight;
  const verticalScrollbarWidth = el.offsetWidth - el.clientWidth;
  if (verticalScrollbarWidth > 0 && event.clientX >= rect.right - verticalScrollbarWidth) return true;
  if (canScrollVertically && event.clientX >= rect.right - OVERLAY_SCROLLBAR_HITBOX) return true;

  const canScrollHorizontally = el.scrollWidth > el.clientWidth;
  const horizontalScrollbarHeight = el.offsetHeight - el.clientHeight;
  if (horizontalScrollbarHeight > 0 && event.clientY >= rect.bottom - horizontalScrollbarHeight) return true;
  if (canScrollHorizontally && event.clientY >= rect.bottom - OVERLAY_SCROLLBAR_HITBOX) return true;

  return false;
};

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
    if (clearProgrammaticFrameRef.current) cancelAnimationFrame(clearProgrammaticFrameRef.current);
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
    const el = scrollRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
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
    if (userIntentTimeoutRef.current) {
      window.clearTimeout(userIntentTimeoutRef.current);
      userIntentTimeoutRef.current = 0;
    }
  }, []);

  const noteUserScrollIntent = useCallback((detachFromBottom = true) => {
    userScrollIntentRef.current = true;
    detachingUserIntentRef.current = detachFromBottom;
    if (detachFromBottom) stuckRef.current = false;
    programmaticScrollRef.current = false;
    if (userIntentTimeoutRef.current) window.clearTimeout(userIntentTimeoutRef.current);
    userIntentTimeoutRef.current = window.setTimeout(() => {
      if (!scrollbarDragRef.current) {
        userScrollIntentRef.current = false;
        detachingUserIntentRef.current = false;
      }
      userIntentTimeoutRef.current = 0;
    }, 800);
    if (clearProgrammaticFrameRef.current) {
      cancelAnimationFrame(clearProgrammaticFrameRef.current);
      clearProgrammaticFrameRef.current = 0;
    }
  }, []);

  const resumeStickToBottom = useCallback(() => {
    stuckRef.current = true;
    detachingUserIntentRef.current = false;
    clearUserIntent();
    scrollbarDragRef.current = false;
  }, [clearUserIntent]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = isNearBottom(el, threshold);
    const userDriven = userScrollIntentRef.current || scrollbarDragRef.current;

    if (programmaticScrollRef.current && !userDriven) {
      if (nearBottom) stuckRef.current = true;
      return;
    }

    if (userDriven) {
      stuckRef.current = nearBottom && !detachingUserIntentRef.current;
      if (stuckRef.current) scheduleStick();
      return;
    }

    if (nearBottom) stuckRef.current = true;
  }, [scheduleStick, scrollRef, threshold]);

  useEffect(() => {
    stuckRef.current = true;
    scheduleStick();
  }, [resetKey, scheduleStick]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    let observedContent = new Set<Element>();
    const scheduleContentChange = () => {
      updateObservedContent();
      scheduleStick();
    };
    const resizeObserver = new ResizeObserver(scheduleContentChange);
    const mutationObserver = new MutationObserver(scheduleContentChange);
    const updateObservedContent = () => {
      const next = new Set<Element>(Array.from(el.children));
      for (const child of observedContent) {
        if (!next.has(child)) resizeObserver.unobserve(child);
      }
      for (const child of next) {
        if (!observedContent.has(child)) resizeObserver.observe(child);
      }
      observedContent = next;
    };

    resizeObserver.observe(el);
    updateObservedContent();

    const onWheel = (event: WheelEvent) => {
      noteUserScrollIntent(event.deltaY < 0);
    };
    const onTouchMove = () => {
      noteUserScrollIntent(true);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!isScrollbarPointerDown(event, el)) return;
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
      stuckRef.current = isNearBottom(el, threshold);
      if (stuckRef.current) scheduleStick();
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerup", onPointerUp);
    mutationObserver.observe(el, { childList: true, characterData: true, subtree: true });
    scheduleStick();

    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerup", onPointerUp);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      observedContent = new Set();
    };
  }, [clearUserIntent, noteUserScrollIntent, onScroll, resetKey, resumeStickToBottom, scheduleStick, scrollRef, threshold]);

  useEffect(() => () => {
    if (userIntentTimeoutRef.current) window.clearTimeout(userIntentTimeoutRef.current);
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    if (clearProgrammaticFrameRef.current) cancelAnimationFrame(clearProgrammaticFrameRef.current);
  }, []);

  return {
    noteUserScrollIntent,
    resumeStickToBottom,
  };
}

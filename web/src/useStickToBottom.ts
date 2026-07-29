import { useCallback, useEffect, useRef, type RefObject } from "react";

export const STICK_TO_BOTTOM_THRESHOLD = 80;

const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

const isEditableTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest("input, textarea, select, button, [contenteditable='true'], [contenteditable='']");
};

const distanceFromBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;

const isNearBottom = (el: HTMLElement, threshold: number) => distanceFromBottom(el) <= threshold;

const isScrollbarPointerDown = (event: PointerEvent, el: HTMLElement) => {
  const rect = el.getBoundingClientRect();
  const verticalScrollbarWidth = el.offsetWidth - el.clientWidth;
  if (verticalScrollbarWidth > 0 && event.clientX >= rect.right - verticalScrollbarWidth) return true;

  const horizontalScrollbarHeight = el.offsetHeight - el.clientHeight;
  return horizontalScrollbarHeight > 0 && event.clientY >= rect.bottom - horizontalScrollbarHeight;
};

export function useStickToBottom(
  scrollRef: RefObject<HTMLElement | null>,
  resetKey: string | number | null | undefined,
  threshold = STICK_TO_BOTTOM_THRESHOLD,
) {
  const stuckRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const userScrollIntentRef = useRef(false);
  const userIntentTimeoutRef = useRef(0);
  const scrollbarDragRef = useRef(false);
  const frameRef = useRef(0);
  const clearProgrammaticFrameRef = useRef(0);
  const cleanupRef = useRef<(() => void) | null>(null);
  const observedElRef = useRef<HTMLElement | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const observedContentRef = useRef<Set<Element>>(new Set());

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

  const noteUserScrollIntent = useCallback(() => {
    userScrollIntentRef.current = true;
    programmaticScrollRef.current = false;
    if (userIntentTimeoutRef.current) window.clearTimeout(userIntentTimeoutRef.current);
    userIntentTimeoutRef.current = window.setTimeout(() => {
      if (!scrollbarDragRef.current) userScrollIntentRef.current = false;
      userIntentTimeoutRef.current = 0;
    }, 800);
    if (clearProgrammaticFrameRef.current) {
      cancelAnimationFrame(clearProgrammaticFrameRef.current);
      clearProgrammaticFrameRef.current = 0;
    }
  }, []);

  const resumeStickToBottom = useCallback(() => {
    stuckRef.current = true;
    userScrollIntentRef.current = false;
    scrollbarDragRef.current = false;
    if (userIntentTimeoutRef.current) {
      window.clearTimeout(userIntentTimeoutRef.current);
      userIntentTimeoutRef.current = 0;
    }
  }, []);

  const updateObservedContent = useCallback((el: HTMLElement) => {
    const resizeObserver = resizeObserverRef.current;
    if (!resizeObserver) return;

    const next = new Set<Element>(Array.from(el.children));
    for (const child of observedContentRef.current) {
      if (!next.has(child)) resizeObserver.unobserve(child);
    }
    for (const child of next) {
      if (!observedContentRef.current.has(child)) resizeObserver.observe(child);
    }
    observedContentRef.current = next;
  }, []);

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
      stuckRef.current = nearBottom;
      if (!scrollbarDragRef.current) {
        userScrollIntentRef.current = false;
        if (userIntentTimeoutRef.current) {
          window.clearTimeout(userIntentTimeoutRef.current);
          userIntentTimeoutRef.current = 0;
        }
      }
      if (nearBottom) scheduleStick();
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
    if (observedElRef.current === el) return;

    cleanupRef.current?.();
    cleanupRef.current = null;
    observedElRef.current = el;
    observedContentRef.current = new Set();
    if (!el) return;

    const scheduleContentChange = () => {
      updateObservedContent(el);
      scheduleStick();
    };
    const resizeObserver = new ResizeObserver(scheduleContentChange);
    const mutationObserver = new MutationObserver(scheduleContentChange);
    resizeObserverRef.current = resizeObserver;
    resizeObserver.observe(el);
    updateObservedContent(el);

    const onPointerDown = (event: PointerEvent) => {
      if (!isScrollbarPointerDown(event, el)) return;
      scrollbarDragRef.current = true;
      noteUserScrollIntent();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(event.key) || isEditableTarget(event.target)) return;
      noteUserScrollIntent();
    };
    const onPointerUp = () => {
      if (!scrollbarDragRef.current) return;
      scrollbarDragRef.current = false;
      userScrollIntentRef.current = false;
      if (userIntentTimeoutRef.current) {
        window.clearTimeout(userIntentTimeoutRef.current);
        userIntentTimeoutRef.current = 0;
      }
      stuckRef.current = isNearBottom(el, threshold);
      if (stuckRef.current) scheduleStick();
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", noteUserScrollIntent, { passive: true });
    el.addEventListener("touchmove", noteUserScrollIntent, { passive: true });
    el.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerup", onPointerUp);
    mutationObserver.observe(el, { childList: true, characterData: true, subtree: true });
    scheduleStick();

    cleanupRef.current = () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", noteUserScrollIntent);
      el.removeEventListener("touchmove", noteUserScrollIntent);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerup", onPointerUp);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      resizeObserverRef.current = null;
      observedContentRef.current = new Set();
    };
  });

  useEffect(() => () => {
    cleanupRef.current?.();
    if (userIntentTimeoutRef.current) window.clearTimeout(userIntentTimeoutRef.current);
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    if (clearProgrammaticFrameRef.current) cancelAnimationFrame(clearProgrammaticFrameRef.current);
  }, []);

  return {
    noteUserScrollIntent,
    resumeStickToBottom,
  };
}

import { useCallback, useEffect, useRef, type RefObject } from "react";

const THRESHOLD = 80;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

function nearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= THRESHOLD;
}

function editable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest(
    "input, textarea, select, button, [contenteditable='true'], [contenteditable='']",
  );
}

export function useStickToBottom(
  scrollRef: RefObject<HTMLElement | null>,
  resetKey: string | number | null | undefined,
) {
  const stuck = useRef(true);
  const frame = useRef(0);
  const userIntent = useRef(false);

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
  }, [scrollRef]);

  const schedule = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (stuck.current) scrollToBottom();
    });
  }, [scrollToBottom]);

  const resume = useCallback(() => {
    stuck.current = true;
    userIntent.current = false;
    schedule();
  }, [schedule]);

  useEffect(() => {
    resume();
  }, [resetKey, resume]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observeChildren = () => {
      for (const child of element.children) resize.observe(child);
    };
    const changed = () => {
      observeChildren();
      schedule();
    };
    const resize = new ResizeObserver(changed);
    const mutation = new MutationObserver(changed);
    const onScroll = () => {
      if (userIntent.current) stuck.current = nearBottom(element);
      else if (nearBottom(element)) stuck.current = true;
    };
    const onWheel = (event: WheelEvent) => {
      userIntent.current = true;
      if (event.deltaY < 0) stuck.current = false;
    };
    const onTouch = () => {
      userIntent.current = true;
      stuck.current = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(event.key) || editable(event.target)) return;
      userIntent.current = true;
      if (event.key === "End") resume();
      else if (["Home", "PageUp", "ArrowUp"].includes(event.key) || (event.key === " " && event.shiftKey)) {
        stuck.current = false;
      }
    };
    resize.observe(element);
    observeChildren();
    mutation.observe(element, { childList: true, characterData: true, subtree: true });
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("wheel", onWheel, { passive: true });
    element.addEventListener("touchmove", onTouch, { passive: true });
    window.addEventListener("keydown", onKey);
    schedule();
    return () => {
      resize.disconnect();
      mutation.disconnect();
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("touchmove", onTouch);
      window.removeEventListener("keydown", onKey);
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [resetKey, resume, schedule, scrollRef]);

  return { resume };
}

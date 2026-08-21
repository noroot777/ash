import { useCallback, useEffect, useState, type RefObject } from "react";

export const SCROLL_EDGE_THRESHOLD = 80;

type ScrollEdges = {
  atTop: boolean;
  atBottom: boolean;
};

export function useScrollEdges(
  scrollRef: RefObject<HTMLElement | null>,
  resetKey: string | number | null | undefined,
  threshold = SCROLL_EDGE_THRESHOLD,
) {
  const [edges, setEdges] = useState<ScrollEdges>({ atTop: true, atBottom: true });

  const updateEdges = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const next = {
      atTop: element.scrollTop <= threshold,
      atBottom: element.scrollHeight - element.scrollTop - element.clientHeight <= threshold,
    };
    setEdges((current) => (
      current.atTop === next.atTop && current.atBottom === next.atBottom ? current : next
    ));
  }, [scrollRef, threshold]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    let frame = 0;
    let observedContent = new Set<Element>();
    const scheduleUpdate = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateEdges();
      });
    };
    const resizeObserver = new ResizeObserver(scheduleUpdate);
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
    const mutationObserver = new MutationObserver(() => {
      updateObservedContent();
      scheduleUpdate();
    });

    element.addEventListener("scroll", scheduleUpdate, { passive: true });
    resizeObserver.observe(element);
    updateObservedContent();
    mutationObserver.observe(element, { childList: true, characterData: true, subtree: true });
    scheduleUpdate();

    return () => {
      element.removeEventListener("scroll", scheduleUpdate);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [resetKey, scrollRef, updateEdges]);

  return edges;
}

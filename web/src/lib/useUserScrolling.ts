import { useEffect, useState, type RefObject } from "react";
import { isEditableTarget, isScrollbarPointerDown, SCROLL_KEYS } from "./useStickToBottom.ts";

/**
 * 「你自己在滚」：滚轮、触摸、拖滚动条、翻页键之后 800ms 内发生的滚动才算，停下 1 秒落回 false。
 * 贴底、跳转导航这些程序滚动不带这几种输入，就不会被当成你在滚（会话的回顶钮靠它，feed-4）。
 * `keep` 指着的元素还被指针停着时不收，免得刚要点它就没了。
 */
export function useUserScrolling(
  scrollRef: RefObject<HTMLElement | null>,
  resetKey: unknown,
  keep?: RefObject<HTMLElement | null>,
) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const element = scrollRef.current;
    setActive(false);
    if (!element) return;
    let intentUntil = 0;
    let idle: number | undefined;
    const intent = () => { intentUntil = performance.now() + 800; };
    const onPointerDown = (event: PointerEvent) => { if (isScrollbarPointerDown(event, element)) intent(); };
    const onKey = (event: KeyboardEvent) => { if (SCROLL_KEYS.has(event.key) && !isEditableTarget(event.target)) intent(); };
    const rest = () => {
      if (keep?.current?.matches(":hover")) idle = window.setTimeout(rest, 400);
      else setActive(false);
    };
    const onScroll = () => {
      if (performance.now() >= intentUntil) return;
      setActive(true);
      window.clearTimeout(idle);
      idle = window.setTimeout(rest, 1000);
    };
    element.addEventListener("wheel", intent, { passive: true });
    element.addEventListener("touchmove", intent, { passive: true });
    element.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.clearTimeout(idle);
      element.removeEventListener("wheel", intent);
      element.removeEventListener("touchmove", intent);
      element.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
      element.removeEventListener("scroll", onScroll);
    };
  }, [scrollRef, resetKey, keep]);
  return active;
}

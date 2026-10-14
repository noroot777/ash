import type { RefObject } from "react";
import { ArrowDown, ArrowUp } from "@phosphor-icons/react";
import { useScrollEdges } from "../lib/useScrollEdges.ts";
import { useStickToBottom } from "../lib/useStickToBottom.ts";

type ResetKey = string | number | null | undefined;

export function ConversationScrollControls({
  scrollRef,
  resetKey,
  tailKey,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  resetKey: ResetKey;
  /** 会话尾部指纹(`tailKeyOf`),决定「来了新内容要不要跟过去」。 */
  tailKey: string | number;
}) {
  const { noteUserScrollIntent, resume } = useStickToBottom(scrollRef, resetKey, tailKey);
  const { atTop, atBottom } = useScrollEdges(scrollRef, resetKey);

  const scrollToEdge = (target: "top" | "bottom") => {
    const element = scrollRef.current;
    if (!element) return;
    if (target === "top") noteUserScrollIntent(true);
    else resume();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollTo({
      top: target === "top" ? 0 : element.scrollHeight,
      behavior: reducedMotion ? "auto" : "smooth",
    });
  };

  return (
    <>
      <button
        className={`conversation-scroll-button conversation-scroll-button--top${atTop ? " is-hidden" : ""}`}
        type="button"
        onClick={() => scrollToEdge("top")}
        tabIndex={atTop ? -1 : 0}
        aria-hidden={atTop}
        aria-label="滚动到会话顶部"
      >
        <ArrowUp size={15} weight="bold" aria-hidden="true" />
      </button>
      <button
        className={`conversation-scroll-button conversation-scroll-button--bottom${atBottom ? " is-hidden" : ""}`}
        type="button"
        onClick={() => scrollToEdge("bottom")}
        tabIndex={atBottom ? -1 : 0}
        aria-hidden={atBottom}
        aria-label="滚动到会话底部"
      >
        <ArrowDown size={15} weight="bold" aria-hidden="true" />
      </button>
    </>
  );
}

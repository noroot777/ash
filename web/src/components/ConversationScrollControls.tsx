import { useRef, type RefObject } from "react";
import { ArrowDown, ArrowUp } from "@phosphor-icons/react";
import { useScrollEdges } from "../lib/useScrollEdges.ts";
import { motionReduced } from "../lib/useSwapText.ts";
import { useStickToBottom } from "../lib/useStickToBottom.ts";
import { useUserScrolling } from "../lib/useUserScrolling.ts";
import type { ConversationInput } from "../task-detail/conversationInputs.ts";
import { ConversationInputRail } from "./ConversationInputRail.tsx";

type ResetKey = string | number | null | undefined;

export function ConversationScrollControls({
  scrollRef,
  resetKey,
  tailKey,
  inputs,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  resetKey: ResetKey;
  /** 会话内容版本(`contentVersion`),决定「多出要看的东西了要不要跟过去」。 */
  tailKey: string | number;
  /**
   * 我说过的话(`conversationInputs`):给了且不止一条,左侧就挂输入导航。跟上下两颗按钮
   * 放在一起,是因为它也是「把视口挪到别处」的控件 —— 每一跳都得先跟贴底逻辑打招呼,
   * 否则跳过去读着读着,下一条新消息就把人拽回了底部。
   */
  inputs?: readonly ConversationInput[];
}) {
  const { noteUserScrollIntent, resume, hold } = useStickToBottom(scrollRef, resetKey, tailKey);
  const { atTop, atBottom } = useScrollEdges(scrollRef, resetKey);
  const top = useRef<HTMLButtonElement>(null);
  const scrolling = useUserScrolling(scrollRef, resetKey, top);

  const scrollToEdge = (target: "top" | "bottom") => {
    const element = scrollRef.current;
    if (!element) return;
    if (target === "top") noteUserScrollIntent(true);
    else resume();
    const reducedMotion = motionReduced();
    element.scrollTo({
      top: target === "top" ? 0 : element.scrollHeight,
      behavior: reducedMotion ? "auto" : "smooth",
    });
  };

  return (
    <>
      {inputs && inputs.length > 1 && (
        <ConversationInputRail
          // 换任务即换一条导航：悬停、摊开、读到哪一条都不该带过去。
          key={resetKey ?? undefined}
          inputs={inputs}
          scrollRef={scrollRef}
          onReaderScroll={noteUserScrollIntent}
          onCover={hold}
        />
      )}
      {/* 回到顶部只在你自己滚的时候出来，停下约一秒淡出；智能体输出带着页面走不算（feed-4）。
          它不在 Tab 的路上——键盘回顶用 Home。 */}
      <button
        ref={top}
        className={`conversation-scroll-button conversation-scroll-button--top${atTop || !scrolling ? " is-hidden" : ""}`}
        type="button"
        onClick={() => scrollToEdge("top")}
        tabIndex={-1}
        aria-hidden={atTop || !scrolling}
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

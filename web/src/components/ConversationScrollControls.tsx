import { useCallback, useRef, type RefObject } from "react";
import { ArrowDown, ArrowUp } from "@phosphor-icons/react";
import { useScrollEdges } from "../lib/useScrollEdges.ts";
import { motionReduced } from "../lib/useSwapText.ts";
import { useStickToBottom } from "../lib/useStickToBottom.ts";
import { useUserScrolling } from "../lib/useUserScrolling.ts";
import { abandonSearchReveal } from "../search/searchReveal.ts";
import { useSearchReveal } from "../search/useSearchReveal.ts";
import type { ConversationInput } from "../task-detail/conversationInputs.ts";
import { ConversationInputRail } from "./ConversationInputRail.tsx";

type ResetKey = string | number | null | undefined;

export function ConversationScrollControls({
  scrollRef,
  resetKey,
  tailKey,
  inputs,
  revealReady,
  revealRoots,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  resetKey: ResetKey;
  /** 会话内容版本(`contentVersion`),决定「多出要看的东西了要不要跟过去」。 */
  tailKey: string | number;
  /**
   * 我说过的话(`conversationInputs`):有一条就挂左侧输入导航(只有原始需求也挂)。跟上下两颗按钮
   * 放在一起,是因为它也是「把视口挪到别处」的控件 —— 每一跳都得先跟贴底逻辑打招呼,
   * 否则跳过去读着读着,下一条新消息就把人拽回了底部。
   */
  inputs?: readonly ConversationInput[];
  /**
   * 给了就表示这是一个任务的会话（resetKey 即任务 id），接 ⌘K「打开命中、落到命中处」的待办；
   * 值是正文读完了没有，见 useSearchReveal。群聊、侧聊这类不是任务会话的表面不给。
   */
  revealReady?: boolean;
  /** 滚动容器之外、同样属于这个任务正文的区域（duet 顶上的议题）：⌘K 落点在这些里面一起找。 */
  revealRoots?: readonly RefObject<HTMLElement | null>[];
}) {
  const revealTaskId = revealReady === undefined || typeof resetKey !== "string" ? null : resetKey;
  // 读者自己挪了视口（滚轮、触控、按键、滚动条、导航条、回顶回底）就作废 ⌘K 的待办 —— 正文还没
  // 读完、还没开始找的时候同样作数。落点自己让贴底别跟（revealDetach）走的是同一个入口，那一下
  // 不是读者接手，不能把自己正在落的那张待办作废。
  const placing = useRef(false);
  const { noteUserScrollIntent, resume, hold } = useStickToBottom(
    scrollRef, resetKey, tailKey, undefined,
    revealTaskId ? () => { if (!placing.current) abandonSearchReveal(revealTaskId); } : undefined,
  );
  const revealDetach = useCallback((detachFromBottom: boolean) => {
    placing.current = true;
    try {
      noteUserScrollIntent(detachFromBottom);
    } finally {
      placing.current = false;
    }
  }, [noteUserScrollIntent]);
  useSearchReveal(scrollRef, revealTaskId, !!revealReady, revealDetach, revealRoots);
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
      {inputs && inputs.length > 0 && (
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

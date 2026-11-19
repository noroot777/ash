import { useEffect, useRef, useState, type RefObject } from "react";
import { REQUIREMENT_INPUT_ID, conversationInputSelector, type ConversationInput } from "../task-detail/conversationInputs.ts";
import { pendingMessageReveal, pickRevealInput, settleMessageReveal, subscribeMessageReveal } from "./messageReveal.ts";

/** 落点那颗气泡的顶边离视口顶边留多少（同输入导航那一跳）。 */
const JUMP_OFFSET = 16;
/** 落下去之后布局还在动（图片读完、上面的折叠块撑开），最多再对准几次。 */
const MAX_CORRECTIONS = 3;
/** 已经落下去、闪过的待办：落地之前输入列表又变了会重挂一次，那一次只管对准，不再闪。 */
const flashed = new WeakSet<object>();

/**
 * 会话这一侧：R 键那张表给这个任务挂了待办（requestMessageReveal），就在正文读完、那颗气泡画出来
 * 之后把视口直接放到它上面，闪一下。
 *
 * - `ready`：正文读完过一轮。之前落下去，正文一到又被挤走。
 * - `detach`：让贴底逻辑别再跟随（首屏那次落到最新一条、下一条新消息都会把人拽回底部）。它不能被当成
 *   读者接手 —— 那会把自己这张待办作废，见 ConversationScrollControls。
 * - 读者自己接手了不在这里听：贴底逻辑的统一入口直接作废待办（abandonMessageReveal）。
 * - 直接跳过去、不平滑滚：从最底下滚一整条长会话上来要好几秒，人是来看那一句的，不是来看滚动的。
 */
export function useMessageReveal(
  scrollRef: RefObject<HTMLElement | null>,
  taskId: string | null,
  ready: boolean,
  inputs: readonly ConversationInput[] | undefined,
  detach: (detachFromBottom: boolean) => void,
) {
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  // 同一个任务已经开着时再从 R 打开它：没有换任务、也没有新内容，靠这个叫醒。
  const [requested, setRequested] = useState(0);
  useEffect(() => subscribeMessageReveal(() => setRequested((value) => value + 1)), []);
  // 输入列表变了（正文读完、新的一句到了）才值得再认一次；按「有几条」叫醒就够，不必每次渲染都重挂。
  const inputCount = inputs?.length ?? 0;

  useEffect(() => {
    const container = scrollRef.current;
    if (!taskId || !ready || !container) return;
    const request = pendingMessageReveal(taskId);
    if (!request) return;
    let frame = 0;
    let corrections = 0;
    let landed = flashed.has(request);
    let done = false;

    const bubbleOf = (input: ConversationInput) => container.querySelector<HTMLElement>(conversationInputSelector(input.id));
    // 原始需求就在最顶上，落点总是顶端（duet 的议题画在会话流外面，没有那颗气泡也照样回顶）。
    const targetTop = (input: ConversationInput, bubble: HTMLElement | null) => {
      if (input.id === REQUIREMENT_INPUT_ID || !bubble) return 0;
      const top = bubble.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - JUMP_OFFSET;
      return Math.max(0, Math.min(top, container.scrollHeight - container.clientHeight));
    };

    const attempt = () => {
      frame = 0;
      if (done || !container.clientHeight) return;
      if (pendingMessageReveal(taskId) !== request) return stop();
      const input = pickRevealInput(inputsRef.current ?? [], request);
      const bubble = input ? bubbleOf(input) : null;
      if (!input || (!bubble && input.id !== REQUIREMENT_INPUT_ID)) return;
      const top = targetTop(input, bubble);
      if (!landed) {
        detach(true);
        container.scrollTo({ top, behavior: "auto" });
        landed = true;
        flashed.add(request);
        if (bubble) flash(bubble);
        schedule();
        return;
      }
      // 落下去之后再看一眼：布局又动了就再对准，稳住了（或者对准够了次数）就算落地。
      if (Math.abs(container.scrollTop - top) > 2 && corrections < MAX_CORRECTIONS) {
        corrections += 1;
        detach(true);
        container.scrollTo({ top, behavior: "auto" });
        schedule();
        return;
      }
      finish();
    };
    const schedule = () => {
      if (frame || done) return;
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(attempt);
      });
    };
    const observer = new MutationObserver(schedule);
    const resized = new ResizeObserver(schedule);
    const stop = () => {
      done = true;
      observer.disconnect();
      resized.disconnect();
      cancelAnimationFrame(frame);
      window.clearTimeout(expiry);
    };
    function finish() {
      settleMessageReveal(request!);
      stop();
    }
    const expiry = window.setTimeout(finish, Math.max(0, request.expires - Date.now()));
    observer.observe(container, { childList: true, subtree: true });
    resized.observe(container);
    schedule();
    return stop;
  }, [detach, inputCount, ready, requested, scrollRef, taskId]);
}

/** 闪一下那颗气泡（同输入导航那一跳的 is-jump-target）：一屏里常常不止一颗我的气泡。 */
function flash(bubble: HTMLElement) {
  bubble.classList.remove("is-jump-target");
  void bubble.offsetWidth;
  bubble.classList.add("is-jump-target");
  bubble.addEventListener("animationend", () => bubble.classList.remove("is-jump-target"), { once: true });
}

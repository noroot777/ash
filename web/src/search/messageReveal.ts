import type { ConversationInput } from "../task-detail/conversationInputs.ts";
import { REQUIREMENT_INPUT_ID } from "../task-detail/conversationInputs.ts";

/**
 * R 键那张「我说过的话」点开一条时，会话直接落到那一颗气泡上并闪一下。
 *
 * 跟 ⌘K 的正文落点（searchReveal）同一个形状：面板和会话之间隔着「切任务 → 读会话 → 渲染」，
 * 所以这里只挂一张**待办**，会话那边（useMessageReveal）等正文读完、认出那颗气泡再落地，用掉即清。
 *
 * 不同在认法：这边要的是**某一句话**，不是某个词 —— 服务端给的是这句话在会话里的出处
 * （哪条会话的第几段），页面上每颗用户气泡记着同一对（ConversationInput.source），直接对号入座。
 */
export type MessageRevealRequest = {
  taskId: string;
  /** null = 原始需求那颗气泡。 */
  sessionId: string | null;
  index: number | null;
  at: string;
  /** 展示正文（服务端可能截过）：出处和时刻都对不上时最后拿它认。 */
  text: string;
  truncated: boolean;
  expires: number;
};

/** 打开后多久还没落地就作罢：会话读不出来，或者那一句已经被删了。 */
const REQUEST_TTL_MS = 15_000;

let pending: MessageRevealRequest | null = null;
const listeners = new Set<() => void>();

export function requestMessageReveal(request: Omit<MessageRevealRequest, "expires">) {
  pending = { ...request, expires: Date.now() + REQUEST_TTL_MS };
  listeners.forEach((listener) => listener());
}

export function pendingMessageReveal(taskId: string): MessageRevealRequest | null {
  if (pending && pending.expires <= Date.now()) pending = null;
  return pending?.taskId === taskId ? pending : null;
}

export function settleMessageReveal(request: MessageRevealRequest) {
  if (pending === request) pending = null;
}

/** 读者自己挪了这条会话：待办作废，别等读完了再把人拽走（同 abandonSearchReveal）。 */
export function abandonMessageReveal(taskId: string) {
  if (pending?.taskId !== taskId) return;
  pending = null;
  listeners.forEach((listener) => listener());
}

export function subscribeMessageReveal(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * 会话里哪一颗是它。依次认：
 *   1. 原始需求；
 *   2. 落盘出处（会话 + 段号）—— 绝大多数走这一条；
 *   3. 同一条会话（或说不清是哪条会话）里同一时刻说的 —— 实时到达、还没有出处的那几句，duet 的插话；
 *   4. 正文一字不差（截过的就比开头）—— 老会话没写时刻，服务端那边的时刻是会话开始时刻，对不上。
 */
export function pickRevealInput(inputs: readonly ConversationInput[], request: MessageRevealRequest): ConversationInput | null {
  if (request.sessionId === null) return inputs.find((input) => input.id === REQUIREMENT_INPUT_ID) ?? null;
  const sourced = inputs.find((input) => input.source?.sessionId === request.sessionId && input.source.index === request.index);
  if (sourced) return sourced;
  const timed = inputs.filter((input) => input.at === request.at && (!input.sessionId || input.sessionId === request.sessionId));
  if (timed.length === 1) return timed[0]!;
  const text = request.truncated ? request.text.replace(/…$/, "") : request.text;
  const candidates = (timed.length ? timed : inputs).filter((input) => input.id !== REQUIREMENT_INPUT_ID
    && (!input.sessionId || input.sessionId === request.sessionId)
    && (request.truncated ? input.text.startsWith(text) : input.text === text));
  // 同一句话说过好几次（「继续」「好的」）：认最后一次 —— 这张表本来就是新的在前，点到的多半是最近那次。
  return candidates.at(-1) ?? null;
}

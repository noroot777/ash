import type { RetryTurnAction, ReviewRetryIdentity } from "@ash/shared";

// 「上一回合崩了、此刻能重来」的那颗键：普通回合是失败那句话后面的「重试这一回合」，审查档是审查格
// 结论行的主按钮和会话尾注后面的「继续本轮审查」。
//
// 能不能重来整份由服务端判（`server/src/task-retry-turn.ts` 的 `retryTurnRejection`），随任务的
// 「此刻能做什么」一起下发（lib/useTaskActions.ts 的 `retryTurn`）—— 前端不再自己按状态、会话、
// 气泡推一遍：两边说法不一样，键就成了「点了永远 409」。这里只把那份结论接成页面上的动作。

export type { ReviewRetryIdentity };
/**
 * 「继续本轮审查」这个动作本身：认的是哪一轮、点下去做什么、此刻点不点得了（`blocked` = 服务端给的
 * 原因）。审查格结论行的主按钮、会话里说这一轮为什么没结论的那句尾注，两处挂的是同一个。
 */
export type ReviewRetryAction = { review: ReviewRetryIdentity; run: () => Promise<void>; blocked?: string | null };
/** 「重试这一回合」这个动作本身：挂在会话里那一回合失败那句话后面（ConversationFeed）。 */
export type TurnRetryAction = { sessionId: string; run: () => Promise<void>; blocked?: string | null };
/** 点下去交给 `api.retryTurn` 的那一份：认哪条会话，或者认哪一轮审查。 */
export type TurnRetryTarget =
  | { kind: "turn"; sessionId: string }
  | { kind: "review"; review: ReviewRetryIdentity };

/** 把服务端的结论接成两档动作。`hidden` 的服务端已经给成 null，这里不会见到。 */
export function retryTurnActions(
  retry: RetryTurnAction | null | undefined,
  run: (target: TurnRetryTarget) => Promise<void>,
): { turn: TurnRetryAction | null; review: ReviewRetryAction | null } {
  if (!retry || (!retry.ok && retry.hidden)) return { turn: null, review: null };
  const blocked = retry.ok ? null : retry.reason;
  if (retry.kind === "turn") {
    const target = { kind: "turn" as const, sessionId: retry.sessionId };
    return { turn: { sessionId: retry.sessionId, run: () => run(target), blocked }, review: null };
  }
  const target = { kind: "review" as const, review: retry.review };
  return { turn: null, review: { review: retry.review, run: () => run(target), blocked } };
}

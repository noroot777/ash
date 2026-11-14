// 尾注里此刻挂着动作的那几句：「等你裁定」后面的「去裁定」、没出结论那一轮后面的「继续本轮审查」、
// 崩了的那一回合后面的「重试这一回合」。
//
// 尾注每件事只留最近一句、最多三句（composeFootnote）。这几句是现在就要你动手的事，一旦被后来的
// 话盖过或者被三句截掉，动作就跟着没了地方挂——而审查格那张卡、任务的重试入口都还在（R8M9Tsn2q0aj：
// 驳回落下 13 秒后同一回合又落了一句「本回合没有交卷」，「去裁定」就没了）。所以它们各占一个位置，
// 不跟别的句子争（`held`）；动作没了（裁定了、续过了、重试过了），那一句就回到普通规则。
import type { FreeReviewRun, TaskListItem } from "@ash/shared";
import { openDisputeIn, reviewLocked } from "../free-workflow/freeReviewCopy.ts";
import type { ConversationItem } from "./conversationModel.ts";
import { noVerdictPartId, type LaneNoVerdict } from "./reviewNoVerdictCause.ts";
import { noticeView } from "./timelineNoticeCopy.ts";
import type { CrashedTurn } from "./turnFailure.ts";
import type { ReviewRetryAction, TurnRetryAction } from "./turnRetry.ts";

export type FootnoteActions = {
  /**
   * 会话里最后一条驳回，且它此刻真的等你裁定：没裁、没被新的驳回取代，任务也还能裁（没验收、没合并、
   * 没归档，同审查格那张卡的 `locked`）。拿不到审查状态的视图不知道裁没裁，照位置判。
   * 这一句带颜色、占自己的位置；不在这里的驳回都是过去的事。
   */
  standingDisputeId: string | null;
  /** 挂「去裁定」的那一条：同上，且审查格那张卡确实在（`openDisputeIn`，与审查面板同一口径）。 */
  ruleEventId: string | null;
  /** 结论气泡下面说「这一轮为什么没结论」的那一句，此刻能续时挂「继续本轮审查」。 */
  retryCauseId: string | null;
  /** 会话里认不出那张卡时，退回最后一条说这一轮原因的旁注，挂同一个动作。 */
  retryEventId: string | null;
  /** 此刻能重试的那一回合（`footnote:<agent id>`）和说它没办成的那一句。 */
  retryTurnFootnoteId: string | null;
  retryFailureId: string | null;
  /** 尾注里各占一个位置、不被挤掉的那几句（FootnotePart.id）。 */
  held: ReadonlySet<string>;
};

export function footnoteActions(options: {
  items: readonly ConversationItem[];
  task: Pick<TaskListItem, "stage" | "archived" | "handoff">;
  reviews: readonly FreeReviewRun[] | null | undefined;
  /** 有没有审查格可去：没有就一颗「去裁定」都不给（只读会话、团队时间线）。 */
  canOpenReviews: boolean;
  causes: ReadonlyMap<string, LaneNoVerdict>;
  crashed: ReadonlyMap<string, CrashedTurn>;
  reviewRetry?: ReviewRetryAction | null;
  turnRetry?: TurnRetryAction | null;
}): FootnoteActions {
  const { items, reviews, reviewRetry, turnRetry } = options;
  const lastDisputeId = items.findLast((item) => item.kind === "event" && noticeView(item).dispute)?.id ?? null;
  const open = !!openDisputeIn(reviews);
  const standingDisputeId = !reviewLocked(options.task) && (reviews == null || open) ? lastDisputeId : null;
  const ruleEventId = options.canOpenReviews && open ? standingDisputeId : null;

  // 「继续本轮审查」只挂在此刻还能续的那一轮（同一场、同一轮）上。那一句平时是结论气泡下面按轮次
  // 身份取的那一句（reviewNoVerdictCause）；会话里认不出那张卡时（没有「开始」那一条、拿不到审查
  // 状态的视图），才退回最后一条说这一轮原因的旁注。
  const retryCause = reviewRetry ? noVerdictPartId(reviewRetry.review.runId, reviewRetry.review.round) : null;
  const causeHostsRetry = !!retryCause && [...options.causes.values()].some((entry) => noVerdictPartId(entry.runId, entry.round) === retryCause);
  const retryEventId = reviewRetry && !causeHostsRetry ? items.findLast((item) => item.kind === "event"
    && item.notice?.kind === "review.no_verdict"
    && item.notice.runId === reviewRetry.review.runId && item.notice.round === reviewRetry.review.round)?.id ?? null : null;

  // 「重试这一回合」挂在那一回合（会话里最后一条气泡，且就是要重跑的那条会话）说它没办成的那一句后面：
  // 刷新以后是从会话行补出来的那一句（turnFailure），直播那一路是紧跟着它的异常回合边界。
  const lastAgentIndex = items.findLastIndex((item) => item.kind === "agent");
  const lastAgent = items[lastAgentIndex];
  const retryTurn = turnRetry && lastAgent?.kind === "agent" && lastAgent.session?.id === turnRetry.sessionId ? lastAgent : null;
  const retryFailureId = !retryTurn ? null
    : options.crashed.has(retryTurn.id) ? `failure:${retryTurn.id}`
      : items.slice(lastAgentIndex + 1)
        .findLast((item) => item.kind === "event" && item.variant === "boundary" && item.tone === "error")?.id ?? null;

  const retryCauseId = causeHostsRetry ? retryCause : null;
  return {
    standingDisputeId,
    ruleEventId,
    retryCauseId,
    retryEventId,
    retryTurnFootnoteId: retryTurn ? `footnote:${retryTurn.id}` : null,
    retryFailureId,
    held: new Set([standingDisputeId, retryCauseId, retryEventId, retryFailureId].filter((id): id is string => !!id)),
  };
}

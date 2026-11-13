// 收了口的一轮审查点了去哪儿：右侧审查格的那一场那一轮，或者打开它的报告。
import { api } from "../lib/api.ts";
import { reviewPanelSources, reviewTargetLocatable, type ReviewTarget } from "../review/reviewTarget.ts";
import type { ConversationReviewLane } from "./conversationReviewLanes.ts";

/** 点这一轮去审查格时带的话：来源、那一场、第几轮（见 review/reviewTarget）。 */
export function laneReviewTarget(lane: ConversationReviewLane): ReviewTarget {
  return { source: lane.source, runId: lane.runId, round: lane.round };
}

/**
 * 这一轮点了去不去审查格：认得出是哪一条记录（老时间线配不上那一场、这个任务的审查格不装这一类
 * 都算认不出）才给 `open`，否则不给——那一句就在原处摊开这一轮的经过，不去审查格猜。
 */
export function laneRoundOpener(
  lane: ConversationReviewLane,
  workflowMode: string | null | undefined,
  open: ((target: ReviewTarget) => void) | undefined,
): ((target: ReviewTarget) => void) | undefined {
  return open && reviewTargetLocatable(laneReviewTarget(lane), reviewPanelSources(workflowMode)) ? open : undefined;
}

export function laneReportUrl(taskId: string, target: NonNullable<ConversationReviewLane["report"]>): string {
  return target.kind === "inline"
    ? api.taskReviewFileUrl(taskId, target.round, "report.md")
    : api.freeReviewFileUrl(taskId, target.runId, target.round, "report.md");
}

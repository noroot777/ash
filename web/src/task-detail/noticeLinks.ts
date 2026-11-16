// 会话里那几句旁注点过去去哪儿：「等你裁定」那一句去「审议」格的那一场那一轮，哨兵那几句去
// 「哨兵」格的那一张卡。尾注（FootnoteLine）和「N 条记录」（TurnReceipts）共用这一处，同一句话
// 在两处点出来去的是同一个地方。
//
// 认不出去哪儿就不给路（同 reviewTargetLocatable）：那一句照旧在原处摊开原文。
import type { FreeReviewRun } from "@ash/shared";
import type { ConversationEventItem } from "./conversationModel.ts";
import { reviewPanelSources, reviewTargetLocatable, type ReviewTarget } from "../review/reviewTarget.ts";

export type NoticeLink = { label: string; open: () => void };

export type NoticeLinkTargets = {
  workflowMode: string | null | undefined;
  reviews: readonly FreeReviewRun[] | null | undefined;
  onOpenReviewPanel?: (target: ReviewTarget) => void;
  /** null = 认不出是哪一个哨兵（老记录、确认被拦下那一句），只打开那一格。 */
  onOpenMonitorPanel?: (monitorId: string | null) => void;
};

/**
 * 驳回那一句是哪一场哪一轮。新记录自己带着那一场的 id；老记录只有轮号，在审查记录里找那一轮
 * 上写过驳回的、驳回时刻离这一句最近的那一场（重新派审从第 1 轮数起，同一轮号可能有好几场）。
 */
export function disputeReviewTarget(item: ConversationEventItem, reviews: readonly FreeReviewRun[] | null | undefined): ReviewTarget | null {
  const notice = item.notice;
  if (notice?.kind !== "review.dispute") return null;
  if (notice.runId) return { source: "free", runId: notice.runId, round: notice.round };
  const at = item.at ? Date.parse(item.at) : NaN;
  const candidates = (reviews ?? [])
    .filter((run) => run.target?.kind !== "accepted_merge")
    .flatMap((run) => run.rounds
      .filter((round) => round.round === notice.round && round.dispute)
      .map((round) => ({ runId: run.id, gap: Number.isFinite(at) ? Math.abs(Date.parse(round.dispute!.at) - at) : 0 })));
  const best = candidates.sort((a, b) => a.gap - b.gap)[0];
  return best ? { source: "free", runId: best.runId, round: notice.round } : null;
}

/** 哨兵那几句说的是哪一个哨兵：undefined = 不是哨兵的话；null = 是，但认不出是哪一个。 */
export function noticeMonitorId(item: ConversationEventItem): string | null | undefined {
  const notice = item.notice;
  switch (notice?.kind) {
    case "monitor.started":
    case "monitor.finished":
    case "monitor.released":
      return notice.monitorId ?? null;
    case "monitor.handed":
      return notice.monitorWake.events.at(-1)?.monitorId ?? null;
    case "complete.held":
      return null;
    default:
      return undefined;
  }
}

export function noticeLink(item: ConversationEventItem | undefined, targets: NoticeLinkTargets): NoticeLink | null {
  if (!item) return null;
  const review = targets.onOpenReviewPanel;
  const target = review ? disputeReviewTarget(item, targets.reviews) : null;
  if (review && target && reviewTargetLocatable(target, reviewPanelSources(targets.workflowMode))) {
    return { label: "在右侧审议格里打开这一轮", open: () => review(target) };
  }
  const monitor = targets.onOpenMonitorPanel;
  const monitorId = monitor ? noticeMonitorId(item) : undefined;
  if (monitor && monitorId !== undefined) {
    return { label: "在右侧哨兵格里看", open: () => monitor(monitorId) };
  }
  return null;
}

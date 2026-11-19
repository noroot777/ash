import type { FreeReviewDispute, FreeReviewDisputeTarget, FreeReviewRound, FreeReviewRun, TaskListItem } from "@navi/shared";
import { openDisputeEntryIn, reviewLocked } from "./freeReviewCopy.ts";
import type { DisputeResolutionKind } from "./disputeCopy.ts";

/** 回复框顶上那一行的几种下一步：三档裁定 + 让双方辩论。 */
export type RulingChoice = DisputeResolutionKind | "debate";

/** 一次裁定 / 辩论针对的那一条驳回（哪一场审查的哪一轮）。 */
export const disputeTarget = (run: FreeReviewRun, round: FreeReviewRound): FreeReviewDisputeTarget => ({ runId: run.id, round: round.round });

export const sameDisputeTarget = (left: FreeReviewDisputeTarget | null | undefined, right: FreeReviewDisputeTarget | null | undefined) =>
  !!left && !!right && left.runId === right.runId && left.round === right.round;

/** 此刻等裁定的那一条（任务级，与审查格同一口径 `openDisputeEntryIn`）；没有就是 null。 */
export function openDisputeTarget(reviews: readonly FreeReviewRun[] | null | undefined): FreeReviewDisputeTarget | null {
  const entry = openDisputeEntryIn(reviews);
  return entry ? disputeTarget(entry.run, entry.round) : null;
}

export type RulingContext = {
  target: FreeReviewDisputeTarget;
  run: FreeReviewRun;
  round: FreeReviewRound;
  dispute: FreeReviewDispute;
  /** 出现哪几颗，按左到右的顺序。 */
  choices: RulingChoice[];
  /** 此刻按不动的原因（任务在跑、审查在进行）；null = 能按。 */
  blocked: string | null;
  /** 最近一场辩论好好说完了：「让它接着改」会把审查者收尾那段一并发给执行者。 */
  debated: boolean;
};

/**
 * 回复框顶上那一行此刻是什么样（null = 不出现）。
 *
 * 不出现的几种：没有等裁定的驳回；任务锁住了（验收、合并、归档、接力出去，同审查格 `reviewLocked`）；
 * 辩论正在进行（那时回复框就是平常的回复框，辩到哪了写在会话里那颗气泡上）。它在问你不在这里判：
 * 答题卡展开着占住回复框那一格时，回复框连同这一行一起不挂，收起就回来（ReplyBox 的 `covering`）——
 * 问题在不在是任务上的事实，卡展没展开是回复框那一格的事，不能拿前者顶后者。
 *
 * 出现哪几颗照原来那张卡的判据，服务端同样会拒，这里不是唯一防线：「转为独立任务」只在执行者逐条写了
 * 越界依据时给——凭空给它就成了谁都能按的免修开关；「让双方辩论」只在没辩过、或上一场中断时给——辩完的
 * 那条挡住再辩，同一份报告挂两条辩完的记录只会让「以哪条为准」变成新问题。
 */
export function rulingContext(
  reviews: readonly FreeReviewRun[] | null | undefined,
  task: Pick<TaskListItem, "status" | "stage" | "archived" | "handoff">,
): RulingContext | null {
  const entry = openDisputeEntryIn(reviews);
  const dispute = entry?.round.dispute;
  if (!entry || !dispute || reviewLocked(task)) return null;
  const latest = dispute.debates.at(-1) ?? null;
  if (latest?.status === "running") return null;
  const choices: RulingChoice[] = ["upheld", "withdrawn"];
  if (dispute.deferReason) choices.push("deferred");
  if (!latest || latest.status === "failed") choices.push("debate");
  const reviewing = (reviews ?? []).some((run) => run.target?.kind !== "accepted_merge" && run.status === "reviewing");
  const blocked = task.status === "running" || task.status === "queued"
    ? "任务正在跑，这一轮跑完再裁"
    : reviewing ? "一轮审查正在进行，审完再裁" : null;
  return {
    target: disputeTarget(entry.run, entry.round),
    run: entry.run,
    round: entry.round,
    dispute,
    choices,
    blocked,
    debated: latest?.status === "finished",
  };
}

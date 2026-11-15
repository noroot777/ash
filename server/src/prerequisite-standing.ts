// 「一条前置站稳了没有」—— **唯一的判定**。起跑的闸、等齐之后的放行、页面上那句「在等谁、它到哪一步了」
// 都问这里，不各自拼一套。
//
// 站稳 = 下游此刻从它那里拿到的代码，就是它最终要交出去的那一版：
//   ① 已经验收合入的，当然算（不再看审查，那一版已经盖过章）。
//   ② 执行者确认完成（done），而且此刻没有回合在跑 —— 续聊里又在改的不算（续聊时 status 是 running）。
//   ③ 没预约过审查、也没审过的：完成即站稳。
//   ④ 预约了、正在审、打回在修、没过停在等用户决定：都不算。
//   ⑤ 审过的：最近那条审查链通过了，或者被用户裁定收场（「这一轮不用改了」「转为独立任务」），
//      **并且审过的就是现在的代码**。新鲜度判据只认 shared 的 `reviewAnchorMatches` 那一份 —— 审查面板
//      判「结论过期」用的也是它，两边说法不会对不上。
//   ⑥ 工作区里有没提交的改动的不算：下游只能从提交拿代码，那些改动带不过去，等于没给全。
//
// 失败、取消、归档的也不算 —— 下游要的是它的代码，跳过它往下走就是拿着残缺的底子开工。
//
// 合并结果审查（`accepted_merge`）是验收之后的独立只读链，不参与：走到那一步的前置已经在 ① 里了。
import { and, desc, eq, inArray } from "drizzle-orm";
import { isAcceptedStage, type TaskStage } from "@ash/shared";
import type { PrerequisiteStep } from "@ash/shared/prerequisites";
import { reviewAnchorMatches } from "@ash/shared/free-workflow";
import { db } from "./db/index.js";
import { freeReviewRounds, freeReviewRuns, freeWorkflowStates, tasks } from "./db/schema.js";
import { workspaceStateOf } from "./free-workflow-state.js";

type TaskRow = typeof tasks.$inferSelect;

export type PrerequisiteStanding = { step: PrerequisiteStep; round: number | null };

const at = (step: PrerequisiteStep, round: number | null = null): PrerequisiteStanding => ({ step, round });

/** 最近那条工作区审查链与它的当前轮（run 已结束时就是最后出结论的那一轮）。 */
async function latestReview(taskId: string) {
  const run = (await db.select().from(freeReviewRuns)
    .where(and(eq(freeReviewRuns.taskId, taskId), eq(freeReviewRuns.targetKind, "workspace")))
    .orderBy(desc(freeReviewRuns.createdAt)).limit(1)).at(0);
  if (!run) return null;
  const round = (await db.select().from(freeReviewRounds)
    .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)))).at(0) ?? null;
  return { run, round };
}

export async function prerequisiteStanding(task: TaskRow): Promise<PrerequisiteStanding> {
  if (isAcceptedStage(task.stage as TaskStage | null)) return at("settled");
  if (task.archived) return at("archived");
  const [review, armed] = await Promise.all([
    latestReview(task.id),
    db.select({ armed: freeWorkflowStates.reviewArmed }).from(freeWorkflowStates)
      .where(eq(freeWorkflowStates.taskId, task.id)).then((rows) => !!rows.at(0)?.armed),
  ]);
  const round = review?.run.currentRound ?? null;
  const reviewing = review?.run.status === "reviewing";
  switch (task.status) {
    case "running":
    case "queued":
    case "awaiting_review":
      if (reviewing) return at("reviewing", round);
      // 上一轮没过、自动复审挂着：这一回合就是在按意见修。
      return review && review.run.status !== "passed" && review.round?.status !== "passed" && armed
        ? at("repairing", round) : at("running");
    case "paused": return task.question ? at("question") : reviewing ? at("reviewing", round) : at("paused");
    case "backlog": return at("not_started");
    case "failed": return at("failed");
    case "canceled": return at("canceled");
    case "done": break;
    default: return at("running");
  }
  if (reviewing) return at("reviewing", round);
  if (armed) return at("review_reserved");
  const { unresolvedDisputes } = await import("./free-review-dispute.js");
  if ((await unresolvedDisputes(task.id)).length) return at("review_disputed", round);
  const snapshot = task.useWorktree ? await workspaceStateOf(task) : null;
  const dirty = () => snapshot?.dirty === true ? at("dirty") : at("settled");
  if (!review?.round) return dirty();
  const closed = review.run.status === "passed"
    || review.round.disputeResolution === "withdrawn" || review.round.disputeResolution === "deferred";
  if (!closed) return at("review_failed", round);
  // 新鲜度只在有工作区可比时才判；工作区已经不在（被清理，代码只剩分支）就没有「审查后又改过」这回事。
  if (snapshot && (snapshot.head || snapshot.fingerprint)) {
    if (reviewAnchorMatches(review.round, snapshot) !== true) return at("review_stale", round);
  }
  return dirty();
}

/** 一批前置一次判完；查不到的（被删了）不在结果里。 */
export async function prerequisiteStandings(ids: string[]): Promise<Map<string, { task: TaskRow; standing: PrerequisiteStanding }>> {
  const out = new Map<string, { task: TaskRow; standing: PrerequisiteStanding }>();
  if (!ids.length) return out;
  const rows = await db.select().from(tasks).where(inArray(tasks.id, [...new Set(ids)]));
  await Promise.all(rows.map(async (task) => { out.set(task.id, { task, standing: await prerequisiteStanding(task) }); }));
  return out;
}

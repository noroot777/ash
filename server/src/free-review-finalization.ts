import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeReviewRuns, regressionEvidence, tasks } from "./db/schema.js";
import { bus } from "./bus.js";
import { cleanupAcceptedMergeRun, stopReviewRunMonitors } from "./free-review-round.js";
import { armFollowUpFreeReview } from "./free-review-reservations.js";
import { freeRepairPrompt } from "./free-review-prompts.js";
import { appendFinalizationTimeline, enqueueFinalizationRepair, finalizationStep } from "./regression-finalization.js";
import { reviewIdentityMatches, settlementAuthority } from "./review-ownership.js";

export async function finalizeFreeReview(state: typeof regressionEvidence.$inferSelect): Promise<void> {
  const { run, outcome, at } = JSON.parse(state.finalization!.payload) as {
    run: typeof freeReviewRuns.$inferSelect; outcome: "passed" | "failed" | "repair" | "exhausted";
    at: string;
  };
  const step = (name: string, action: () => Promise<unknown>) => finalizationStep(state.directory, state.generation, name, action);
  await step("monitors", () => stopReviewRunMonitors(run.id, "这次审查已结束，它挂的哨兵一并收回", true));
  await step("cleanup", () => cleanupAcceptedMergeRun(run, true));
  const task = (await db.select().from(tasks).where(eq(tasks.id, run.taskId)))[0];
  const authority = settlementAuthority(state);
  const repairCurrent = task && !task.archived && !["accepted", "merged"].includes(task.stage ?? "")
    && reviewIdentityMatches(task, authority.target);
  if (outcome === "repair" && run.targetKind !== "accepted_merge" && repairCurrent) {
    await enqueueFinalizationRepair(state.directory, state.generation, run.taskId, await freeRepairPrompt(run.taskId, run),
      authority.target!,
      async (transaction) => { await armFollowUpFreeReview(run.taskId, run, at, transaction); });
  }
  const text = outcome === "failed" && !authority.target
    ? `自由工作流第 ${run.currentRound} 轮审查已终止并完成轮次记账；历史记录缺少原目标方向身份，本轮结论未应用，未投递修复。请重新派发审查。`
    : outcome === "failed"
    ? run.targetKind === "accepted_merge" ? "合并结果审查未能正常给出结论；原任务保持已验收，可重新发起审查。"
      : `自由工作流第 ${run.currentRound} 轮审查未能正常给出结论，已停止自动链。`
    : outcome === "passed"
      ? run.targetKind === "accepted_merge" ? `合并结果审查通过（${run.reviewerName}）；原任务继续保持已验收。`
        : `自由工作流第 ${run.currentRound} 轮审查通过（${run.reviewerName}）。`
      : run.targetKind === "accepted_merge" ? "合并结果审查未通过；原任务保持已验收，可从审查记录创建独立修复任务。"
        : outcome === "repair" ? repairCurrent
          ? `自由工作流第 ${run.currentRound} 轮审查未通过，意见已放入待发送队列；修复正常结束后按最新预约复审。`
          : `自由工作流第 ${run.currentRound} 轮审查未通过；任务已进入更新的方向或归档，未自动投递旧修复指令。`
          : "自由工作流审查仍未通过，自动复审次数已用完；现在由你决定验收通过、按意见修复或再开一轮审查。";
  await step("timeline", () => appendFinalizationTimeline(run.taskId, text, `${state.generation}:timeline`));
  await step("publish", async () => { bus.publish({ type: "task.review", taskId: run.taskId }); });
}

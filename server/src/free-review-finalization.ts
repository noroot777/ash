import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeReviewRuns, regressionEvidence, tasks } from "./db/schema.js";
import { bus } from "./bus.js";
import { cleanupAcceptedMergeRun, stopReviewRunMonitors } from "./free-review-round.js";
import { armFollowUpFreeReview } from "./free-review-reservations.js";
import { reviewLifecycle } from "./review-lifecycle-lock.js";
import { freeRepairPrompt } from "./free-review-prompts.js";
import { appendFinalizationTimeline, enqueueFinalizationRepair, finalizationStep } from "./regression-finalization.js";
import { reviewIdentityMatches, settlementAuthority } from "./review-ownership.js";

export async function finalizeFreeReview(state: typeof regressionEvidence.$inferSelect): Promise<void> {
  const { run, outcome, at } = JSON.parse(state.finalization!.payload) as {
    run: typeof freeReviewRuns.$inferSelect; outcome: "passed" | "failed" | "repair" | "exhausted";
    at: string;
  };
  const step = (name: string, action: () => Promise<unknown>) => finalizationStep(state.directory, state.generation, name, action);
  // **资源处置那两步跟「下一次重跑换代次」互斥**(第 4 轮审查 F2 的同类位置)。收尾是异步排空的
  // (`drainRegressionFinalization` / 启动期对账),这两刀又都是 **run 级**的 —— 哪一轮、哪一次全
  // 不认。`finalizationStep` 里那道「代次还是不是我」是读完再动手,读到下刀之间隔着仓库锁和
  // `git worktree remove`,用户的重跑完全可以插在中间:于是上一次的收尾把新一代刚挂上的哨兵停掉、
  // 把它等的结果作废、把它正在读的工作区删掉。排进链里之后,那道代次判据到动手那一刻仍然成立。
  await reviewLifecycle(run.id, async () => {
    await step("monitors", () => stopReviewRunMonitors(run.id, "这次审查已结束，它挂的哨兵一并收回", true,
      { round: run.currentRound, generation: state.generation }));
    await step("cleanup", () => cleanupAcceptedMergeRun(run, true));
  });
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
  await step("timeline", () => appendFinalizationTimeline(run.taskId,
    `${text}${authority.target ? "" : "原提问随本轮终止失效。"}`, `${state.generation}:timeline`));
  await step("publish", async () => { bus.publish({ type: "task.review", taskId: run.taskId }); });
}

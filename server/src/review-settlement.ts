import { and, eq } from "drizzle-orm";
import { firstAnchor } from "@ash/shared/workflow-policy";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { reviewRoundDir } from "./review-evidence.js";
import { latestPresetConclusionRound } from "./regression-evidence-lifecycle.js";
import { assertConclusionTask } from "./regression-conclusion-commit.js";
import { completeRegressionSettlement, regressionSettlementConclusion } from "./regression-settlement.js";
import { drainRegressionFinalization, finalization } from "./regression-finalization.js";
import { verificationStepsAfterRound } from "./review-execution.js";
import { taskWorkflowDef } from "./workflows.js";
import type { Settlement } from "./review-policy.js";
import { now } from "./util.js";

type TaskRow = typeof tasks.$inferSelect;

export async function finishVerifyRound(target: TaskRow, turnOk: boolean | null): Promise<void> {
  if (turnOk && (target.question || target.resumePrompt)) return;
  await settleReview(target, target.verifyRound ?? 1, turnOk === null ? undefined : turnOk ? "done" : "failed", null, {
    station: target.reviewStep ?? firstAnchor(taskWorkflowDef(target.workflow), "verify")?.id ?? null,
    stationRound: (target.verifyStationRounds ?? 0) + 1,
  });
}

export async function finishReview(review: TaskRow, status: Settlement, recovering = false): Promise<void> {
  const target = review.reviewOf && (await db.select().from(tasks).where(eq(tasks.id, review.reviewOf)))[0];
  if (!target) return;
  const reviews = await db.select().from(tasks).where(eq(tasks.reviewOf, target.id));
  const stationRound = review.reviewStep ? reviews.filter((candidate) => candidate.reviewStep === review.reviewStep &&
    (candidate.reviewRound ?? 0) <= (review.reviewRound ?? 0)).length || 1 : review.reviewRound ?? 1;
  await settleReview(target, review.reviewRound ?? 1, recovering ? undefined : status === "paused" ? "failed" : status, review.id, {
    station: review.reviewStep ?? firstAnchor(taskWorkflowDef(target.workflow), "verify")?.id ?? null, stationRound,
  });
}

async function settleReview(target: TaskRow, round: number, outcome: "done" | "failed" | "canceled" | undefined,
  reviewTaskId: string | null, at: { station: string | null; stationRound: number }): Promise<void> {
  const directory = reviewRoundDir(target.id, round);
  const checked = await regressionSettlementConclusion(target.id, directory, { outcome, round, ownerTaskId: reviewTaskId ?? target.id });
  if (!checked) return;
  const frozen = target.archived || target.stage === "accepted" || target.stage === "merged";
  const stage = frozen ? target.archived && target.stage === "verifying" ? null : target.stage
    : checked.outcome !== "done" && ["verified", "verify_failed", "verifying"].includes(target.stage ?? "") ? null
    : checked.conclusion === "verify_failed" && target.stage === "verified" ? "verify_failed" : target.stage;
  const plan = finalization("preset", { target: { ...target, stage }, round, reviewTaskId, ...at,
    outcome: checked.outcome, conclusion: checked.conclusion, frozen, stageChanged: stage !== target.stage });
  await completeRegressionSettlement(directory, checked, async (transaction) => {
    await assertConclusionTask(transaction, target);
    if (reviewTaskId) {
      const scope = await latestPresetConclusionRound(target, transaction);
      if (scope?.round !== round || scope.reviewTaskId !== reviewTaskId) return false;
    } else if (target.verifyRound !== round) return false;
    const updated = await transaction.update(tasks).set({ stage, updatedAt: now(),
      ...(!reviewTaskId ? { verifyRound: null, verifyRounds: (target.verifyRounds ?? 0) + 1,
        verifyCompletedSteps: verificationStepsAfterRound(target), verifyStationRounds: at.stationRound } : {}),
    }).where(and(eq(tasks.id, target.id), ...(!reviewTaskId ? [eq(tasks.verifyRound, round)] : []))).returning({ id: tasks.id });
    return updated.length > 0;
  }, plan);
  await drainRegressionFinalization(directory);
}

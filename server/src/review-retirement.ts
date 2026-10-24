import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeReviewRounds, regressionEvidence, tasks } from "./db/schema.js";
import { activeReviewScope, type ReviewDelivery } from "./review-ownership.js";
import { assertConclusionTask } from "./regression-conclusion-commit.js";
import { RegressionConclusionRejected } from "./regression-conclusion-errors.js";
import { claimTurn, releaseTurn, type TurnSource } from "./runs.js";
import { announceResumePrompt, resumePromptVoidPatch } from "./task-resume-prompt.js";
import { taskStartStatus } from "./task-start-status.js";
import { now } from "./util.js";

type TaskRow = typeof tasks.$inferSelect;
type EvidenceRow = typeof regressionEvidence.$inferSelect;

function closedHistoricalReview(owner: TaskRow, state: EvidenceRow | undefined, free: boolean): boolean {
  return !free && state?.settlement?.pending === false && !owner.verifyRound && !owner.resumePrompt
    && ["done", "failed", "canceled"].includes(owner.status);
}

export async function retireHistoricalReview(expected: TaskRow, source: TurnSource = { role: "single" },
  delivery?: ReviewDelivery, turnHeld = false): Promise<boolean> {
  if (delivery?.kind === "repair") return false;
  if (!expected.verifyRound && !expected.reviewOf && source.role !== "reviewer") return false;
  const candidate = await db.transaction(async (transaction) => {
    const scope = await activeReviewScope(transaction, expected, source);
    if (!scope) return;
    const evidence = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, scope.directory)))[0];
    if (closedHistoricalReview(expected, evidence, !!scope.run)) return;
    return !evidence?.targetIdentity && !evidence?.settlement?.target
      ? { ...scope, generation: evidence?.generation ?? null } : undefined;
  }, { behavior: "immediate" });
  if (!candidate || (!turnHeld && !claimTurn(expected.id, source.role,
    source.role === "reviewer" && source.review !== "unbound" ? source.review : null))) return false;
  let retired = false;
  try {
    const owner = await db.transaction(async (transaction) => {
      await assertConclusionTask(transaction, expected);
      const current = (await transaction.select().from(tasks).where(eq(tasks.id, expected.id)))[0]!;
      const scope = await activeReviewScope(transaction, current, source);
      if (scope?.directory !== candidate.directory || current.resumePrompt !== expected.resumePrompt
        || current.resumePromptGeneration !== expected.resumePromptGeneration) return;
      const state = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, scope.directory)))[0];
      if (state?.targetIdentity || state?.settlement?.target || (state?.generation ?? null) !== candidate.generation) return;
      if (closedHistoricalReview(current, state, !!scope.run)) return;
      if (delivery && (delivery.generation !== (state?.generation ?? null)
        || (delivery.kind === "checkpoint" ? current.resumePrompt !== delivery.text
          || current.resumePromptGeneration !== delivery.promptGeneration
          : state?.continuation?.phase !== "delivery" || state.continuation.messageId !== delivery.messageId))) return;
      const freeRound = scope.run && (await transaction.select().from(freeReviewRounds)
        .where(and(eq(freeReviewRounds.runId, scope.run.id), eq(freeReviewRounds.round, scope.round))))[0];
      if (scope.run && freeRound?.status !== "reviewing") return;
      if (state?.settlement && (state.settlement.ownerTaskId !== current.id || state.settlement.round !== scope.round
        || state.settlement.freeRoundId !== freeRound?.id)) return;
      if (!state) await transaction.insert(regressionEvidence).values({ directory: scope.directory, taskId: scope.taskId,
        generation: randomUUID(), revoked: true, excludedMonitors: [], targetIdentity: null });
      const settlement = state?.settlement ?? { outcome: "failed" as const, conclusion: null,
        round: scope.round, ownerTaskId: current.id, pending: true, target: null,
        ...(freeRound ? { freeRoundId: freeRound.id } : {}),
      };
      await transaction.update(regressionEvidence).set({ settlement: { ...settlement, pending: true }, continuation: { phase: "exited" } })
        .where(eq(regressionEvidence.directory, scope.directory));
      const previous = taskStartStatus(current);
      const updated = await transaction.update(tasks).set({
        ...(current.resumePrompt ? resumePromptVoidPatch() : {}),
        ...(current.reviewOf ? { status: settlement.outcome }
          : current.status === "queued" ? { status: previous === "queued" || previous === "running" ? "paused" : previous } : {}),
        updatedAt: now(),
      }).where(eq(tasks.id, current.id)).returning();
      return { task: updated[0]!, outcome: settlement.outcome };
    }, { behavior: "immediate" });
    if (!owner) return false;
    retired = true;
    await announceResumePrompt(owner.task.id);
    if (candidate.run) await (await import("./free-workflow.js")).handleFreeWorkflowSettlement(owner.task.id,
      owner.outcome, false, owner.outcome === "done", "reviewer");
    else if (owner.task.reviewOf) await (await import("./review-settlement.js")).finishReview(owner.task, owner.outcome);
    else await (await import("./review-settlement.js")).finishVerifyRound(owner.task, owner.outcome === "done");
    return true;
  } catch (error) {
    if (error instanceof RegressionConclusionRejected) return retired;
    retired = true;
    throw error;
  } finally {
    if (!turnHeld || retired) releaseTurn(expected.id);
  }
}

import { and, eq, isNotNull } from "drizzle-orm";
import type { TaskStatus } from "@ash/shared";
import { db } from "./db/index.js";
import { freeReviewRounds, regressionEvidence, tasks } from "./db/schema.js";
import type { ReviewTargetIdentity } from "./db/schema-regression-evidence.js";
import { activeReviewScope, reviewIdentityMatches } from "./review-ownership.js";
import { clearReviewWait } from "./review-wait.js";
import { directionIdentityCleared } from "./task-direction-epoch.js";
import { announceResumePrompt } from "./task-resume-prompt.js";
import { recordTaskStatus } from "./task-start-status.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";
import { claimTurn, isTurnClaimed, releaseTurn } from "./runs.js";

export type ReviewStartReceipt = { directory: string; generation: string; identity: ReviewTargetIdentity };

export async function withdrawReviewStart(taskId: string, receipt: ReviewStartReceipt | undefined,
  priorStatus: TaskStatus | null): Promise<void> {
  if (!receipt) return;
  const withdrawn = await db.transaction(async (transaction) => {
    const owner = (await transaction.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    const state = (await transaction.select().from(regressionEvidence)
      .where(eq(regressionEvidence.directory, receipt.directory)))[0];
    const start = state?.continuation?.start;
    if (!owner || owner.activeTurnToken !== receipt.identity.turnToken
      || owner.activeDirectionToken !== receipt.identity.directionToken || owner.directionEpoch !== receipt.identity.directionEpoch
      || !state || state.generation !== receipt.generation || state.settlement
      || start?.ownerTaskId !== taskId || start.identity.turnToken !== receipt.identity.turnToken
      || start.identity.directionToken !== receipt.identity.directionToken || start.identity.directionEpoch !== receipt.identity.directionEpoch
      || !reviewIdentityMatches(owner, state.continuation?.wait?.owner)) return;
    const scope = await activeReviewScope(transaction, owner);
    if (scope?.directory !== receipt.directory) return;
    const freeRound = scope.run && (await transaction.select().from(freeReviewRounds)
      .where(and(eq(freeReviewRounds.runId, scope.run.id), eq(freeReviewRounds.round, scope.round))))[0];
    const status: TaskStatus = owner.reviewOf ? "failed"
      : (owner.followUpFrom as TaskStatus | null) ?? (priorStatus && !["running", "queued"].includes(priorStatus) ? priorStatus : "paused");
    await transaction.update(regressionEvidence).set({ settlement: {
      outcome: "failed", conclusion: null, ownerTaskId: owner.id, round: scope.round, pending: true,
      target: state.targetIdentity, ...(freeRound ? { freeRoundId: freeRound.id } : {}),
    }, continuation: { ...state.continuation, phase: "exited", start: undefined } }).where(eq(regressionEvidence.directory, receipt.directory));
    await clearReviewWait(transaction, owner, state);
    await transaction.update(tasks).set({ status, followUpFrom: null, nativeTurn: false, completeConfirmedAt: null,
      ...directionIdentityCleared(), updatedAt: now(), ...(["done", "failed", "canceled"].includes(status) ? { endedAt: now() } : {}),
    }).where(eq(tasks.id, taskId));
    return { owner, status, free: !!scope.run };
  }, { behavior: "immediate" });
  if (!withdrawn) return;
  recordTaskStatus(withdrawn.owner, withdrawn.status);
  await announceResumePrompt(taskId);
  await appendTaskTimeline(taskId, "审查在启动前撤回（原方向失效或起跑中断）；本轮没有启动，旧等待已作废，可重新派审。");
  if (withdrawn.free) await (await import("./free-workflow.js")).handleFreeWorkflowSettlement(taskId,
    withdrawn.status, false, false, "reviewer");
  else await (await import("./review.js")).handleTaskSettlement(taskId, withdrawn.status, false, false);
}

export async function reconcileReviewStarts(ownerTaskId?: string): Promise<void> {
  const states = await db.select().from(regressionEvidence).where(isNotNull(regressionEvidence.continuation));
  for (const state of states) {
    const start = state.continuation?.start;
    if (!start || state.settlement || (ownerTaskId && ownerTaskId !== start.ownerTaskId)
      || isTurnClaimed(start.ownerTaskId) || !claimTurn(start.ownerTaskId)) continue;
    try {
      await withdrawReviewStart(start.ownerTaskId, { directory: state.directory, generation: state.generation,
        identity: start.identity }, null);
    } finally { releaseTurn(start.ownerTaskId); }
  }
}

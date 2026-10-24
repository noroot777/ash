import type { ReviewConclusion } from "@ash/shared";
import { eq, isNotNull } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeReviewRounds, regressionEvidence, tasks } from "./db/schema.js";
import type { RegressionSettlement } from "./db/schema-regression-evidence.js";
import { checkRegressionConclusion, evidenceState } from "./regression-evidence-lifecycle.js";
import { RegressionConclusionRejected } from "./regression-conclusion-errors.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { isTurnClaimed } from "./runs.js";
import type { ConclusionTransaction } from "./regression-conclusion-commit.js";

export type CheckedSettlement = {
  conclusion: ReviewConclusion;
  outcome: RegressionSettlement["outcome"];
  generation: string;
  recoveryOwnerTaskId?: string;
};

async function recoveryOwnerActive(transaction: ConclusionTransaction, ownerTaskId: string): Promise<boolean> {
  const owner = (await transaction.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, ownerTaskId)))[0];
  return !owner || owner.status === "running" || owner.status === "queued" || isTurnClaimed(ownerTaskId);
}

export async function regressionSettlementConclusion(taskId: string, directory: string, input: {
  outcome?: RegressionSettlement["outcome"];
  round: number;
  ownerTaskId?: string;
  freeRoundId?: string;
  acceptedMerge?: boolean;
}): Promise<CheckedSettlement | null> {
  await evidenceState(taskId, directory, input.acceptedMerge ?? false);
  const stored = await db.transaction(async (transaction) => {
    if (input.outcome === undefined && await recoveryOwnerActive(transaction, input.ownerTaskId ?? taskId)) return null;
    const state = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, directory)))[0]!;
    if (state.taskId !== taskId) throw new Error("审查证据所属任务不匹配");
    const row = input.freeRoundId
      ? (await transaction.select({ conclusion: freeReviewRounds.conclusion }).from(freeReviewRounds)
        .where(eq(freeReviewRounds.id, input.freeRoundId)))[0]
      : (await transaction.select({ conclusion: tasks.stage }).from(tasks).where(eq(tasks.id, taskId)))[0];
    const currentConclusion = row?.conclusion === "verified" || row?.conclusion === "verify_failed" ? row.conclusion : null;
    let settlement: RegressionSettlement = state.settlement ?? {
      outcome: input.outcome ?? "failed", conclusion: currentConclusion, round: input.round, ownerTaskId: input.ownerTaskId ?? taskId,
      ...(input.freeRoundId ? { freeRoundId: input.freeRoundId } : {}), pending: true,
    };
    if (settlement.round !== input.round || settlement.ownerTaskId !== (input.ownerTaskId ?? taskId)
      || settlement.freeRoundId !== input.freeRoundId) throw new Error("审查结算身份不匹配");
    if (settlement.pending && settlement.outcome === "done" && input.outcome && input.outcome !== "done") {
      settlement = { ...settlement, outcome: input.outcome };
    }
    await transaction.update(regressionEvidence).set({ settlement }).where(eq(regressionEvidence.directory, directory));
    return { conclusion: settlement.conclusion, outcome: settlement.outcome, generation: state.generation,
      unknown: !state.settlement && input.outcome === undefined };
  }, { behavior: "immediate" });
  if (!stored) return null;
  const { conclusion, outcome } = stored;
  const checked: CheckedSettlement = { conclusion, outcome, generation: stored.generation,
    ...(input.outcome === undefined ? { recoveryOwnerTaskId: input.ownerTaskId ?? taskId } : {}),
  };
  if (stored.unknown) await appendTaskTimeline(taskId, "审查缺少持久保存的真实退出结果，不能因已有通过结论推定正常结束；本轮按异常结束处理。");
  if (outcome !== "done") return checked;
  try {
    await checkRegressionConclusion(taskId, directory, conclusion ?? "", input.acceptedMerge, undefined, true);
    return checked;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof RegressionConclusionRejected) {
      await appendTaskTimeline(taskId, `通过结论的依据已失效：${message}`);
      return { ...checked, conclusion: "verify_failed" };
    }
    await appendTaskTimeline(taskId, `验证依据暂不可核验，保留结论及审查轮次，恢复后可重试：${message}`);
    return null;
  }
}

export async function completeRegressionSettlement(directory: string, checked: CheckedSettlement,
  write: (transaction: ConclusionTransaction) => Promise<boolean> = async () => true): Promise<boolean> {
  return db.transaction(async (transaction) => {
    if (checked.recoveryOwnerTaskId && await recoveryOwnerActive(transaction, checked.recoveryOwnerTaskId)) return false;
    const state = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, directory)))[0];
    if (!state?.settlement?.pending || state.generation !== checked.generation || state.settlement.outcome !== checked.outcome) return false;
    if (checked.outcome === "done" && checked.conclusion === "verified" && state.revoked && !state.acceptedBasis) return false;
    if (!await write(transaction)) return false;
    await transaction.update(regressionEvidence).set({ settlement: { ...state.settlement, pending: false } })
      .where(eq(regressionEvidence.directory, directory));
    return true;
  }, { behavior: "immediate" });
}

export async function reconcileRegressionSettlements(): Promise<void> {
  const states = await db.select().from(regressionEvidence).where(isNotNull(regressionEvidence.settlement));
  for (const state of states) {
    const settlement = state.settlement;
    if (!settlement?.pending || settlement.freeRoundId) continue;
    const owner = (await db.select().from(tasks).where(eq(tasks.id, settlement.ownerTaskId)))[0];
    if (!owner || owner.status === "running" || owner.status === "queued" || isTurnClaimed(owner.id)) continue;
    if (owner.reviewOf ? owner.reviewOf !== state.taskId || owner.reviewRound !== settlement.round
      : owner.id !== state.taskId || owner.verifyRound !== settlement.round) continue;
    const { handleTaskSettlement } = await import("./review.js");
    await handleTaskSettlement(owner.id, settlement.outcome, false, null);
  }
}

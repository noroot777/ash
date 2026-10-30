import type { ReviewConclusion } from "@ash/shared";
import { eq, isNotNull, or } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeReviewRounds, regressionEvidence, tasks } from "./db/schema.js";
import type { RegressionFinalization, RegressionSettlement } from "./db/schema-regression-evidence.js";
import { checkRegressionConclusion, evidenceState } from "./regression-evidence-lifecycle.js";
import { RegressionConclusionRejected } from "./regression-conclusion-errors.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { isTurnClaimed, turnIdentity } from "./runs.js";
import type { ConclusionTransaction } from "./regression-conclusion-commit.js";
import { reviewRoundDir } from "./review-evidence.js";
import { reconcileRegressionFinalizations } from "./regression-finalization.js";
import { reviewContinuationPending } from "./review-continuation.js";
import { activeReviewScope, reviewIdentityMatches } from "./review-ownership.js";
import type { ReviewTargetIdentity } from "./db/schema-regression-evidence.js";
import { retireHistoricalReview } from "./review-retirement.js";
import { clearReviewWait, reviewWaitForExit } from "./review-wait.js";
import { announceResumePrompt } from "./task-resume-prompt.js";
import { now } from "./util.js";
import { expireClosedTaskWait } from "./task-wait-ownership.js";
import { reconcileReviewStarts } from "./review-start-withdrawal.js";

export type CheckedSettlement = {
  conclusion: ReviewConclusion;
  outcome: RegressionSettlement["outcome"];
  generation: string;
  recoveryOwnerTaskId?: string;
  target: ReviewTargetIdentity | null;
  /** 原样带到下半场：「活回合」那一问由调用方回答（见 `regressionSettlementConclusion` 的同名入参）。 */
  ignoreActive?: boolean;
};

export async function regressionSettlementConclusion(taskId: string, directory: string, input: {
  outcome?: RegressionSettlement["outcome"];
  round: number;
  ownerTaskId?: string;
  freeRoundId?: string;
  acceptedMerge?: boolean;
  /**
   * 「owner 还有回合在跑」这一问由调用方自己回答过了,这里不再按 `tasks.status` 拦一次。
   *
   * 自由工作流的审查是**同一个任务上的旁路回合**:结算这一拍 owner 常常就是 running,所以
   * 那条分支从来都是自己带着 `ignoreActive=true` 判完才进来的(free-workflow.ts 审查旁路
   * 分支)。恢复路径(outcome 省略)下面那道闸要是再按 status 拦一次,就会把「执行者正在跑
   * 实现回合、这一轮审查早已交卷死透」的任务永远挡在结算之外 —— round 挂 reviewing,验收
   * 409(D6)。
   */
  ignoreActive?: boolean;
}): Promise<CheckedSettlement | null> {
  await evidenceState(taskId, directory);
  const stored = await db.transaction(async (transaction) => {
    const state = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, directory)))[0]!;
    const owner = (await transaction.select().from(tasks).where(eq(tasks.id, input.ownerTaskId ?? taskId)))[0];
    if (input.outcome === "done" && owner && !state.settlement
      && await reviewContinuationPending(transaction, owner, state, !!input.freeRoundId, true)) return null;
    if (state.taskId !== taskId) throw new Error("审查证据所属任务不匹配");
    const target = (await transaction.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    const row = input.freeRoundId
      ? (await transaction.select({ conclusion: freeReviewRounds.conclusion }).from(freeReviewRounds)
        .where(eq(freeReviewRounds.id, input.freeRoundId)))[0]
      : (await transaction.select({ conclusion: tasks.stage }).from(tasks).where(eq(tasks.id, taskId)))[0];
    const currentConclusion = (input.freeRoundId || target && reviewIdentityMatches(target, state.targetIdentity))
      && (row?.conclusion === "verified" || row?.conclusion === "verify_failed") ? row.conclusion : null;
    if (input.outcome === undefined && (!owner || await reviewContinuationPending(transaction, owner, state,
      !!input.freeRoundId && currentConclusion !== null, input.ignoreActive))) return null;
    let settlement: RegressionSettlement = state.settlement ?? {
      outcome: input.outcome ?? "failed", conclusion: currentConclusion, round: input.round, ownerTaskId: input.ownerTaskId ?? taskId,
      ...(input.freeRoundId ? { freeRoundId: input.freeRoundId } : {}), pending: true, target: state.targetIdentity,
    };
    if (settlement.round !== input.round || settlement.ownerTaskId !== (input.ownerTaskId ?? taskId)
      || settlement.freeRoundId !== input.freeRoundId) throw new Error("审查结算身份不匹配");
    if (settlement.pending && settlement.outcome === "done" && input.outcome && input.outcome !== "done") {
      settlement = { ...settlement, outcome: input.outcome };
    }
    const wait = await reviewWaitForExit(transaction, owner, state);
    await transaction.update(regressionEvidence).set({ settlement, continuation: { ...state.continuation, phase: "exited", start: undefined, wait } })
      .where(eq(regressionEvidence.directory, directory));
    return { conclusion: settlement.conclusion, outcome: settlement.outcome, generation: state.generation,
      target: settlement.target ?? null, unknown: !state.settlement && input.outcome === undefined };
  }, { behavior: "immediate" });
  if (!stored) return null;
  const { conclusion, outcome } = stored;
  const checked: CheckedSettlement = { conclusion, outcome, generation: stored.generation, target: stored.target,
    ...(input.outcome === undefined ? { recoveryOwnerTaskId: input.ownerTaskId ?? taskId } : {}),
    ...(input.ignoreActive ? { ignoreActive: true } : {}),
  };
  if (stored.unknown) await appendTaskTimeline(taskId, "审查缺少持久保存的真实退出结果，不能因已有通过结论推定正常结束；本轮按异常结束处理。");
  if (outcome !== "done" || !checked.target) return checked;
  try {
    await checkRegressionConclusion(taskId, directory, conclusion ?? "", undefined, true);
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
  write: (transaction: ConclusionTransaction) => Promise<boolean> = async () => true,
  finalization?: RegressionFinalization): Promise<boolean> {
  let changedOwner: string | undefined;
  const completed = await db.transaction(async (transaction) => {
    const state = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, directory)))[0];
    if (checked.recoveryOwnerTaskId) {
      const owner = (await transaction.select().from(tasks).where(eq(tasks.id, checked.recoveryOwnerTaskId)))[0];
      // `checked.ignoreActive`:上半场判过「活回合」了,这里不许按 owner 的 status 再拦一次 ——
      // 否则自由工作流那条自愈走完上半场就停在「settlement 挂着 pending」上,round 照旧 reviewing。
      if (!owner || await reviewContinuationPending(transaction, owner, state, false, checked.ignoreActive)) return false;
    }
    if (!state?.settlement?.pending || state.generation !== checked.generation || state.settlement.outcome !== checked.outcome) return false;
    // 同上：存量 revoked=1 的旧轮次，没交依据就不许把通过结论落定（新轮次 revoked 恒为 0，这一支不触发）。
    if (checked.target && checked.outcome === "done" && checked.conclusion === "verified" && state.revoked && !state.acceptedBasis) return false;
    const owner = (await transaction.select().from(tasks).where(eq(tasks.id, state.settlement.ownerTaskId)))[0];
    const ownsRound = owner && (await activeReviewScope(transaction, owner))?.directory === directory;
    const wait = ownsRound ? await reviewWaitForExit(transaction, owner, state) : undefined;
    if (!await write(transaction)) return false;
    if (owner && await clearReviewWait(transaction, owner, state)) changedOwner = owner.id;
    const waitingTurn = owner?.waitOwnership?.turn;
    const ownsLegacyTurn = owner && (waitingTurn ? waitingTurn.origin.kind !== "ordinary"
      && waitingTurn.origin.directory === directory && reviewIdentityMatches(owner, waitingTurn.identity)
      : !wait?.owner || reviewIdentityMatches(owner, wait.owner));
    if (owner?.reviewOf && ownsRound && ["paused", "queued"].includes(owner.status) && ownsLegacyTurn) {
      await transaction.update(tasks).set({ status: state.settlement.outcome, updatedAt: now() }).where(eq(tasks.id, owner.id));
      changedOwner = owner.id;
    }
    await transaction.update(regressionEvidence).set({ settlement: { ...state.settlement, pending: false },
      ...(finalization ? { finalization } : {}),
    })
      .where(eq(regressionEvidence.directory, directory));
    return true;
  }, { behavior: "immediate" });
  if (completed && changedOwner) await announceResumePrompt(changedOwner);
  return completed;
}

export async function recordInterruptedRegressionReview(task: typeof tasks.$inferSelect): Promise<boolean> {
  if (task.waitOwnership?.start && await (await import("./review-start-retry.js"))
    .restoreUndeliveredReviewStart(task.id, task.waitOwnership.start)) return true;
  const taskId = task.reviewOf ?? task.id, round = task.reviewOf ? task.reviewRound : task.verifyRound;
  if (!round) return false;
  const directory = reviewRoundDir(taskId, round);
  const state = await evidenceState(taskId, directory);
  if (!state.settlement) await regressionSettlementConclusion(taskId, directory, { round, ownerTaskId: task.id, outcome: "failed" });
  return false;
}

export async function reconcileRegressionSettlements(ownerTaskId?: string): Promise<void> {
  await reconcileReviewStarts(ownerTaskId);
  await (await import("./free-workflow.js")).reconcileFreeReviews(ownerTaskId)
    .catch((error) => console.error("[ash] 自由审查发现待重试:", error));
  const candidates = await db.select().from(tasks).where(or(isNotNull(tasks.verifyRound), isNotNull(tasks.reviewOf)));
  for (const task of candidates) {
    if (ownerTaskId && task.id !== ownerTaskId) continue;
    if (["running", "queued"].includes(task.status) || isTurnClaimed(task.id)) continue;
    const taskId = task.reviewOf ?? task.id, round = task.reviewOf ? task.reviewRound : task.verifyRound;
    if (!round) continue;
    const state = (await db.select().from(regressionEvidence).where(eq(regressionEvidence.directory, reviewRoundDir(taskId, round))))[0];
    if (await retireHistoricalReview(task)) continue;
    if (state?.settlement || (!task.verifyRound && !state)) continue;
    if (await db.transaction((transaction) => reviewContinuationPending(transaction, task, state), { behavior: "immediate" })) continue;
    const { handleTaskSettlement } = await import("./review.js");
    await handleTaskSettlement(task.id, "failed", false, null).catch((error) => console.error(`[ash] 审查恢复待重试 ${task.id}:`, error));
  }
  const states = await db.select().from(regressionEvidence).where(isNotNull(regressionEvidence.settlement));
  for (const state of states) {
    const settlement = state.settlement;
    if (!settlement?.pending || (ownerTaskId && settlement.ownerTaskId !== ownerTaskId)) continue;
    const owner = (await db.select().from(tasks).where(eq(tasks.id, settlement.ownerTaskId)))[0];
    if (!owner) continue;
    if (settlement.freeRoundId) {
      // 自由工作流的审查是**同一个任务上的旁路回合**,所以这里不能问「owner 忙不忙」:执行者
      // 被哨兵结果叫醒去跑实现回合时它一直 running,而这一轮审查早就交卷死透了 —— 按状态跳过
      // 等于让挂着 pending 的结算永远补不上(D6,判据同 reconcileFreeReviews)。
      const held = turnIdentity(owner.id);
      if (held ? held.role === "reviewer" : owner.status === "running" || owner.status === "queued") continue;
      await (await import("./free-workflow.js")).handleFreeWorkflowSettlement(owner.id, "failed", false, null, "reviewer")
        .catch((error) => console.error(`[ash] 自由审查恢复待重试 ${owner.id}:`, error));
      continue;
    }
    if (owner.status === "running" || owner.status === "queued" || isTurnClaimed(owner.id)) continue;
    if (owner.reviewOf ? owner.reviewOf !== state.taskId || owner.reviewRound !== settlement.round
      : owner.id !== state.taskId || owner.verifyRound !== settlement.round) continue;
    const { handleTaskSettlement } = await import("./review.js");
    await handleTaskSettlement(owner.id, settlement.outcome, false, null)
      .catch((error) => console.error(`[ash] 审查结算待重试 ${owner.id}:`, error));
  }
  await reconcileRegressionFinalizations(ownerTaskId);
  const waiting = await db.select().from(tasks).where(ownerTaskId ? eq(tasks.id, ownerTaskId)
    : or(isNotNull(tasks.question), isNotNull(tasks.resumePrompt)));
  for (const owner of waiting) {
    const changed = await db.transaction(async (transaction) => {
      const current = (await transaction.select().from(tasks).where(eq(tasks.id, owner.id)))[0];
      return !!current && await expireClosedTaskWait(transaction, current);
    }, { behavior: "immediate" });
    if (changed) await announceResumePrompt(owner.id);
  }
}

let retrying = false;
export function startRegressionSettlementRecovery(): void {
  const timer = setInterval(async () => {
    if (retrying) return;
    retrying = true;
    try { await reconcileRegressionSettlements(); }
    catch (error) { console.error("[ash] 审查结算重试失败:", error); }
    finally { retrying = false; }
  }, 30_000);
  timer.unref();
}

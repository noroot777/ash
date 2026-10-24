import { and, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { regressionEvidence, scheduledMessages, tasks } from "./db/schema.js";
import type { ConclusionTransaction } from "./regression-conclusion-commit.js";
import type { WaitOrigin } from "./db/schema-task-wait.js";
import { freeReviewEvidenceDir } from "./free-review-files.js";
import { isTurnClaimed, type TurnSource } from "./runs.js";
import { activeReviewEvidence, assertReviewAuthority, reviewDeliveryAuthority, reviewIdentityMatches, ReviewSuperseded,
  reviewTargetIdentity, type ReviewDelivery } from "./review-ownership.js";
import { recordReviewWait, reviewWaitAuthorized, reviewWaitAtTurnStart, snapshotReviewWait } from "./review-wait.js";
import { questionWaitMatches, questionWaitOrigin, reviewWaitOrigin, startTaskWaitTurn } from "./task-wait-ownership.js";
import { rememberGuardedStart, clearGuardedStart } from "./guarded-turn-start.js";
import type { ReviewStartReceipt } from "./review-start-withdrawal.js";
import { now } from "./util.js";

export { activeReviewEvidence } from "./review-ownership.js";

type TaskRow = typeof tasks.$inferSelect;
type EvidenceRow = typeof regressionEvidence.$inferSelect;

export async function reviewContinuationPending(transaction: ConclusionTransaction, owner: TaskRow, state?: EvidenceRow,
  hasConclusion = false, ignoreActive = false): Promise<boolean> {
  if (!ignoreActive && (["running", "queued"].includes(owner.status) || isTurnClaimed(owner.id))) return true;
  if (!state || state.settlement) return false;
  if (!await reviewWaitAuthorized(transaction, state)) return false;
  if (state.continuation?.phase === "uncertain") return true;
  const ownsWait = (origin: WaitOrigin | undefined) =>
    origin?.kind === "review" && origin.directory === state.directory && origin.generation === state.generation;
  const question = owner.question && questionWaitMatches(owner) && ownsWait(owner.waitOwnership?.question?.origin);
  const checkpoint = owner.resumePrompt && owner.waitOwnership?.checkpoint?.generation === owner.resumePromptGeneration
    && ownsWait(owner.waitOwnership.checkpoint.origin);
  if ((question || checkpoint) && (!hasConclusion || state?.continuation?.phase === "waiting")) return true;
  const pending = await transaction.select().from(scheduledMessages)
    .where(and(eq(scheduledMessages.taskId, owner.id), eq(scheduledMessages.status, "pending")));
  return pending.some((message) => message.origin === `review-answer:${state?.generation}`
    || (!message.origin && message.mode === "queued" && (owner.verifyRound || owner.reviewOf
      ? message.sessionRole !== "reviewer"
      : message.sessionRole === "reviewer" && state?.directory === freeReviewEvidenceDir(owner.id, message.reviewRun ?? "", message.reviewRound ?? 0))));
}

export async function preserveReviewWait(owner: TaskRow): Promise<void> {
  await db.transaction(async (transaction) => {
    const current = (await transaction.select().from(tasks).where(eq(tasks.id, owner.id)))[0];
    if (!current || !reviewIdentityMatches(current, reviewTargetIdentity(owner)) || (!current.question && !current.resumePrompt)) return;
    await recordReviewWait(transaction, current);
  }, { behavior: "immediate" });
}

export async function assertReviewTurnStart(taskId: string, turnToken: string, directionToken: string,
  delivery?: ReviewDelivery, reviewTurn = false): Promise<void> {
  if (!delivery && !reviewTurn) return;
  const generation = delivery?.generation;
  if (delivery && !generation) throw new ReviewSuperseded();
  await db.transaction(async (transaction) => {
    const task = (await transaction.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    const evidence = generation ? (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.generation, generation)))[0]
      : task && await activeReviewEvidence(transaction, task);
    if (!task || !evidence || task.archived
      || task.activeTurnToken !== turnToken || task.activeDirectionToken !== directionToken) throw new ReviewSuperseded();
    if (delivery?.kind === "repair") await reviewDeliveryAuthority(transaction, delivery, taskId);
    if (delivery?.kind !== "repair") {
      const active = await activeReviewEvidence(transaction, task);
      if (active?.directory !== evidence.directory || evidence.settlement) throw new ReviewSuperseded();
      await assertReviewAuthority(transaction, { directory: evidence.directory, generation: evidence.generation, target: evidence.targetIdentity }, true);
      if (!task.waitOwnership?.start) await transaction.update(regressionEvidence)
        .set({ continuation: { ...evidence.continuation, phase: "running", start: undefined } })
        .where(eq(regressionEvidence.directory, evidence.directory));
    }
    if (task.waitOwnership?.start) await transaction.update(tasks).set({ waitOwnership: { ...task.waitOwnership,
      start: { ...task.waitOwnership.start, phase: "launching" } } }).where(eq(tasks.id, taskId));
  }, { behavior: "immediate" });
}

export async function queueReviewAnswer(transaction: ConclusionTransaction, task: TaskRow,
  message: typeof scheduledMessages.$inferInsert): Promise<boolean> {
  const origin = await questionWaitOrigin(transaction, task);
  if (origin.kind === "ordinary") return false;
  if (origin.kind === "unknown") throw new ReviewSuperseded();
  const state = await activeReviewEvidence(transaction, task);
  if (!state) throw new ReviewSuperseded();
  if (state.settlement || state.directory !== origin.directory || state.generation !== origin.generation) throw new ReviewSuperseded();
  await assertReviewAuthority(transaction, { directory: state.directory, generation: state.generation, target: state.targetIdentity }, true);
  await transaction.insert(scheduledMessages).values({ ...message, origin: `review-answer:${state.generation}` });
  await transaction.update(regressionEvidence).set({ continuation: { ...state.continuation, phase: "delivery", messageId: message.id } })
    .where(eq(regressionEvidence.directory, state.directory));
  return true;
}

export async function beginReviewContinuation(transaction: ConclusionTransaction, task: TaskRow, source: TurnSource,
  turnToken: string, directionToken: string, delivery?: ReviewDelivery): Promise<ReviewStartReceipt | undefined> {
  if (task.waitOwnership?.start?.phase === "uncertain") throw new Error("原审查输入是否执行尚不确定，已暂停自动重发；请核对执行记录后重新派审。");
  const deliveredState = delivery ? await reviewDeliveryAuthority(transaction, delivery, task.id) : undefined;
  const state = await activeReviewEvidence(transaction, task, source);
  if (delivery && delivery.kind !== "repair" && (!state || state.directory !== deliveredState?.directory)) throw new ReviewSuperseded();
  const identity = { turnToken, directionToken, directionEpoch: task.directionEpoch + 1 };
  if (!state || delivery?.kind === "repair") {
    await snapshotReviewWait(transaction, task, identity, { kind: "ordinary" });
    if (deliveredState && delivery?.kind === "repair") {
      if (deliveredState.finalization?.repair?.messageId === delivery.messageId) {
        await transaction.update(regressionEvidence).set({ finalization: { ...deliveredState.finalization,
          repair: { ...deliveredState.finalization.repair, identity } } })
          .where(eq(regressionEvidence.directory, deliveredState.directory));
      }
      const receipt: ReviewStartReceipt = { directory: deliveredState.directory, generation: deliveredState.generation,
        identity, repair: true, delivery,
        ...(deliveredState.finalization?.repair?.messageId === delivery.messageId ? { acceptedRepair: true } : {}) };
      await rememberGuardedStart(transaction, task, receipt, delivery.messageId);
      return receipt;
    }
    return;
  }
  const current = (await transaction.select().from(tasks).where(eq(tasks.id, task.id)))[0];
  await assertReviewAuthority(transaction, { directory: state.directory, generation: state.generation, target: state.targetIdentity }, true);
  if (!current || !reviewIdentityMatches(current, reviewTargetIdentity(task))
    || state.settlement || (state.taskId === task.id && !reviewIdentityMatches(current, state.targetIdentity))) throw new ReviewSuperseded();
  await startTaskWaitTurn(transaction, task, identity, reviewWaitOrigin(state));
  await transaction.update(regressionEvidence).set({
    ...(state.taskId === task.id ? { targetIdentity: { turnToken, directionToken, directionEpoch: task.directionEpoch + 1 } } : {}),
    continuation: { phase: delivery?.kind === "answer" ? "delivery" : delivery?.kind === "checkpoint" ? "waiting" : "running",
      start: { ownerTaskId: task.id, identity }, wait: reviewWaitAtTurnStart(task, turnToken, directionToken),
      ...(state.continuation?.messageId ? { messageId: state.continuation.messageId } : {}) },
  }).where(eq(regressionEvidence.directory, state.directory));
  const receipt = { directory: state.directory, generation: state.generation, identity, delivery };
  await rememberGuardedStart(transaction, task, receipt);
  return receipt;
}

export async function commitReviewTurnDelivery(taskId: string, receipt: ReviewStartReceipt | undefined,
  process?: { pid: number; unitToken?: string | null }): Promise<void> {
  if (!receipt) return;
  await db.transaction(async (transaction) => {
    const task = (await transaction.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    const start = task?.waitOwnership?.start;
    const state = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, receipt.directory)))[0];
    if (!task || !start || !state || state.generation !== receipt.generation
      || JSON.stringify(start.identity) !== JSON.stringify(receipt.identity) || !reviewIdentityMatches(task, receipt.identity)) return;
    if (!receipt.repair && !state.settlement) await transaction.update(regressionEvidence)
      .set({ continuation: { ...state.continuation, phase: "running", start: undefined } })
      .where(eq(regressionEvidence.directory, receipt.directory));
    await clearGuardedStart(transaction, task);
    const current = (await transaction.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
    await transaction.update(tasks).set({ waitOwnership: { ...current.waitOwnership,
      deliveredReview: { directory: receipt.directory, generation: receipt.generation, identity: receipt.identity,
        input: receipt.delivery, pid: process?.pid, unitToken: process?.unitToken, confirmedAt: now() } } })
      .where(eq(tasks.id, taskId));
  }, { behavior: "immediate" });
}

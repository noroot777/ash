import { and, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { regressionEvidence, scheduledMessages, tasks } from "./db/schema.js";
import type { ConclusionTransaction } from "./regression-conclusion-commit.js";
import { freeReviewEvidenceDir } from "./free-review-files.js";
import { isTurnClaimed, type TurnSource } from "./runs.js";
import { activeReviewEvidence, assertReviewAuthority, reviewDeliveryAuthority, reviewIdentityMatches, ReviewSuperseded,
  reviewTargetIdentity, type ReviewDelivery } from "./review-ownership.js";

export { activeReviewEvidence } from "./review-ownership.js";

type TaskRow = typeof tasks.$inferSelect;
type EvidenceRow = typeof regressionEvidence.$inferSelect;

export async function reviewContinuationPending(transaction: ConclusionTransaction, owner: TaskRow, state?: EvidenceRow,
  hasConclusion = false, ignoreActive = false): Promise<boolean> {
  if (!ignoreActive && (["running", "queued"].includes(owner.status) || isTurnClaimed(owner.id))) return true;
  if (state?.settlement) return false;
  if ((owner.question || owner.resumePrompt) && (!hasConclusion || state?.continuation?.phase === "waiting")) return true;
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
    const state = await activeReviewEvidence(transaction, current);
    if (state && !state.settlement && state.continuation?.phase !== "delivery") await transaction.update(regressionEvidence).set({ continuation: { phase: "waiting" } })
      .where(eq(regressionEvidence.directory, state.directory));
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
    if (!task || !evidence || task.archived || (delivery?.kind === "repair" && ["accepted", "merged"].includes(task.stage ?? ""))
      || task.activeTurnToken !== turnToken || task.activeDirectionToken !== directionToken) throw new ReviewSuperseded();
    if (delivery?.kind !== "repair") {
      const active = await activeReviewEvidence(transaction, task);
      if (active?.directory !== evidence.directory || evidence.settlement) throw new ReviewSuperseded();
      await assertReviewAuthority(transaction, { directory: evidence.directory, generation: evidence.generation, target: evidence.targetIdentity }, true);
    }
  }, { behavior: "immediate" });
}

export async function queueReviewAnswer(transaction: ConclusionTransaction, task: TaskRow,
  message: typeof scheduledMessages.$inferInsert): Promise<boolean> {
  const state = await activeReviewEvidence(transaction, task);
  if (!state) return false;
  if (state.settlement) throw new ReviewSuperseded();
  await assertReviewAuthority(transaction, { directory: state.directory, generation: state.generation, target: state.targetIdentity }, true);
  await transaction.insert(scheduledMessages).values({ ...message, origin: `review-answer:${state.generation}` });
  await transaction.update(regressionEvidence).set({ continuation: { phase: "delivery", messageId: message.id } })
    .where(eq(regressionEvidence.directory, state.directory));
  return true;
}

export async function beginReviewContinuation(transaction: ConclusionTransaction, task: TaskRow, source: TurnSource,
  turnToken: string, directionToken: string, delivery?: ReviewDelivery): Promise<void> {
  const deliveredState = delivery ? await reviewDeliveryAuthority(transaction, delivery, task.id) : undefined;
  const state = await activeReviewEvidence(transaction, task, source);
  if (delivery && delivery.kind !== "repair" && (!state || state.directory !== deliveredState?.directory)) throw new ReviewSuperseded();
  if (!state || delivery?.kind === "repair") return;
  const current = (await transaction.select().from(tasks).where(eq(tasks.id, task.id)))[0];
  await assertReviewAuthority(transaction, { directory: state.directory, generation: state.generation, target: state.targetIdentity }, true);
  if (!current || !reviewIdentityMatches(current, reviewTargetIdentity(task))
    || state.settlement || (state.taskId === task.id && !reviewIdentityMatches(current, state.targetIdentity))) throw new ReviewSuperseded();
  await transaction.update(regressionEvidence).set({
    ...(state.taskId === task.id ? { targetIdentity: { turnToken, directionToken, directionEpoch: task.directionEpoch + 1 } } : {}),
    continuation: { phase: "running", ...(state.continuation?.messageId ? { messageId: state.continuation.messageId } : {}) },
  }).where(eq(regressionEvidence.directory, state.directory));
}

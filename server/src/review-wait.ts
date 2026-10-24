import { eq } from "drizzle-orm";
import { regressionEvidence, tasks } from "./db/schema.js";
import type { ReviewContinuation, ReviewTargetIdentity } from "./db/schema-regression-evidence.js";
import type { WaitOrigin } from "./db/schema-task-wait.js";
import type { ConclusionTransaction } from "./regression-conclusion-commit.js";
import { activeReviewEvidence, activeReviewScope, assertReviewAuthority, reviewIdentityMatches, reviewTargetIdentity, ReviewSuperseded } from "./review-ownership.js";
import { captureTaskWait, expireTaskWait, recordTaskWait, reviewWaitOrigin, startTaskWaitTurn } from "./task-wait-ownership.js";

type TaskRow = typeof tasks.$inferSelect;
type EvidenceRow = typeof regressionEvidence.$inferSelect;
type ReviewWait = NonNullable<ReviewContinuation["wait"]>;

function snapshot(owner: TaskRow): ReviewWait {
  return {
    owner: reviewTargetIdentity(owner),
    question: owner.question ? { text: owner.question, options: owner.questionOptions, items: owner.questionItems } : null,
    checkpoint: owner.resumePrompt ? { text: owner.resumePrompt, generation: owner.resumePromptGeneration } : null,
  };
}

export async function reviewWaitAuthorized(transaction: ConclusionTransaction, state?: EvidenceRow): Promise<boolean> {
  if (!state) return false;
  try {
    await assertReviewAuthority(transaction, { directory: state.directory, generation: state.generation,
      target: state.targetIdentity ?? state.settlement?.target ?? null }, true);
    return true;
  } catch (error) {
    if (error instanceof ReviewSuperseded) return false;
    throw error;
  }
}

export async function recordReviewWait(transaction: ConclusionTransaction, owner: TaskRow,
  field?: "question" | "checkpoint", origin?: WaitOrigin): Promise<void> {
  if (field) await recordTaskWait(transaction, owner, field, origin);
  else await captureTaskWait(transaction, owner);
  const state = await activeReviewEvidence(transaction, owner);
  if (!state || state.settlement?.pending === false) return;
  const authorized = !state.settlement && await reviewWaitAuthorized(transaction, state);
  if (!authorized && !field) return;
  const historical = !state.settlement && !state.targetIdentity && !state.continuation?.wait;
  const sameOwner = reviewIdentityMatches(owner, state.continuation?.wait?.owner);
  const wait = authorized || historical || sameOwner ? snapshot(owner) : state.continuation?.wait ?? { question: null, checkpoint: null };
  if (!authorized && !historical && !sameOwner && field) wait[field] = null;
  await transaction.update(regressionEvidence).set({ continuation: {
    ...state.continuation, phase: authorized && state.continuation?.phase !== "delivery" ? "waiting" : state.continuation?.phase ?? "running", wait,
  } }).where(eq(regressionEvidence.directory, state.directory));
}

export function reviewWaitAtTurnStart(owner: TaskRow, turnToken: string, directionToken: string): ReviewWait {
  return { ...snapshot(owner), owner: { turnToken, directionToken, directionEpoch: owner.directionEpoch + 1 } };
}

export async function snapshotReviewWait(transaction: ConclusionTransaction, owner: TaskRow,
  nextOwner?: ReviewTargetIdentity, origin?: WaitOrigin): Promise<void> {
  const state = await activeReviewEvidence(transaction, owner);
  const reviewStart = !!nextOwner && !!(owner.reviewOf || owner.verifyRound);
  if (nextOwner) await startTaskWaitTurn(transaction, owner, nextOwner,
    origin ?? (reviewStart && state ? reviewWaitOrigin(state) : { kind: "ordinary" }));
  else await captureTaskWait(transaction, owner);
  if (!state || state.settlement || (state.continuation?.wait && !reviewStart)) return;
  await transaction.update(regressionEvidence).set({ continuation: {
    ...state.continuation, phase: state.continuation?.phase ?? "running",
    wait: { ...snapshot(owner), ...(reviewStart ? { owner: nextOwner } : {}) },
  } }).where(eq(regressionEvidence.directory, state.directory));
}

export async function reviewWaitForExit(transaction: ConclusionTransaction, owner: TaskRow | undefined,
  state: EvidenceRow): Promise<ReviewWait | undefined> {
  if (owner && (await activeReviewScope(transaction, owner))?.directory === state.directory) await captureTaskWait(transaction, owner);
  return state.continuation?.wait;
}

export async function clearReviewWait(transaction: ConclusionTransaction, owner: TaskRow,
  state: EvidenceRow): Promise<boolean> {
  return expireTaskWait(transaction, owner, state);
}

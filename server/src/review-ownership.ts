import { and, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeReviewRuns, regressionEvidence, tasks } from "./db/schema.js";
import type { ReviewTargetIdentity } from "./db/schema-regression-evidence.js";
import type { ConclusionTransaction } from "./regression-conclusion-commit.js";
import { reviewRoundDir } from "./review-evidence.js";
import { freeReviewEvidenceDir } from "./free-review-files.js";
import type { TurnSource } from "./runs.js";

type TaskRow = typeof tasks.$inferSelect;
export type ReviewAuthority = { directory: string; generation: string; target: ReviewTargetIdentity | null };

export async function activeReviewScope(transaction: ConclusionTransaction, task: TaskRow, source?: TurnSource) {
  if (task.reviewOf && task.reviewRound) return { directory: reviewRoundDir(task.reviewOf, task.reviewRound),
    taskId: task.reviewOf, round: task.reviewRound };
  if (task.verifyRound) return { directory: reviewRoundDir(task.id, task.verifyRound), taskId: task.id, round: task.verifyRound };
  else {
    const run = (await transaction.select().from(freeReviewRuns)
      .where(and(eq(freeReviewRuns.taskId, task.id), eq(freeReviewRuns.status, "reviewing"))))[0];
    if (run && (!source || (source.role === "reviewer" && source.review !== "unbound"
      && source.review.run === run.id && source.review.round === run.currentRound))) {
      return { directory: freeReviewEvidenceDir(task.id, run.id, run.currentRound), taskId: task.id, round: run.currentRound, run };
    }
  }
  return undefined;
}

export async function activeReviewEvidence(transaction: ConclusionTransaction, task: TaskRow, source?: TurnSource) {
  const scope = await activeReviewScope(transaction, task, source);
  return scope ? (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, scope.directory)))[0] : undefined;
}

export class ReviewSuperseded extends Error {
  constructor() { super("审查所属的原目标方向已失效，旧收尾不再修改目标"); }
}

export function reviewTargetIdentity(task: TaskRow): ReviewTargetIdentity {
  return { turnToken: task.activeTurnToken, directionToken: task.activeDirectionToken, directionEpoch: task.directionEpoch };
}

export function reviewIdentityMatches(task: TaskRow, identity: ReviewTargetIdentity | null | undefined): boolean {
  return !!identity && task.directionEpoch === identity.directionEpoch
    && ((task.activeTurnToken === identity.turnToken && task.activeDirectionToken === identity.directionToken)
      || (task.activeTurnToken === null && task.activeDirectionToken === null && task.activeDirectionVersion === 0));
}

export async function assertReviewAuthority(transaction: ConclusionTransaction, authority: ReviewAuthority,
  allowAccepted = false): Promise<TaskRow> {
  const state = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, authority.directory)))[0];
  const task = state && (await transaction.select().from(tasks).where(eq(tasks.id, state.taskId)))[0];
  if (!state || state.generation !== authority.generation || !task || task.archived
    || (!allowAccepted && ["accepted", "merged"].includes(task.stage ?? ""))
    || !reviewIdentityMatches(task, authority.target)) throw new ReviewSuperseded();
  return task;
}

export async function withReviewAuthority<Result>(authority: ReviewAuthority | undefined,
  action: (transaction: ConclusionTransaction) => Promise<Result>): Promise<Result> {
  return db.transaction(async (transaction) => {
    if (authority) await assertReviewAuthority(transaction, authority);
    return action(transaction);
  }, { behavior: "immediate" });
}

export function settlementAuthority(state: typeof regressionEvidence.$inferSelect): ReviewAuthority {
  return { directory: state.directory, generation: state.generation, target: state.settlement?.target ?? null };
}

export type ReviewDelivery = { generation: string; kind: "answer" | "repair"; messageId: string }
  | { generation: string | null; kind: "checkpoint"; text: string; promptGeneration: number };

export function reviewDeliveryFrom(message: { id: string; origin: string | null }): ReviewDelivery | undefined {
  const match = /^review-(answer|settlement):(.+)$/.exec(message.origin ?? "");
  return match ? { generation: match[2]!, kind: match[1] === "answer" ? "answer" : "repair", messageId: message.id } : undefined;
}

export async function reviewDeliveryAuthority(transaction: ConclusionTransaction, delivery: ReviewDelivery, taskId: string) {
  if (!delivery.generation) throw new ReviewSuperseded();
  const state = (await transaction.select().from(regressionEvidence)
    .where(eq(regressionEvidence.generation, delivery.generation)))[0];
  if (!state) throw new ReviewSuperseded();
  const owner = (await transaction.select().from(tasks).where(eq(tasks.id, taskId)))[0];
  if (!owner || (state.taskId !== taskId && (delivery.kind === "repair" || owner.reviewOf !== state.taskId
    || !owner.reviewRound || state.directory !== reviewRoundDir(state.taskId, owner.reviewRound)))) throw new ReviewSuperseded();
  const authority = delivery.kind === "repair" ? settlementAuthority(state)
    : { directory: state.directory, generation: state.generation, target: state.targetIdentity };
  await assertReviewAuthority(transaction, authority, delivery.kind !== "repair");
  if (delivery.kind !== "repair" && (await activeReviewEvidence(transaction, owner))?.directory !== state.directory) throw new ReviewSuperseded();
  if (delivery.kind === "answer" && (state.settlement || state.continuation?.phase !== "delivery"
    || state.continuation.messageId !== delivery.messageId)) throw new ReviewSuperseded();
  const checkpoint = owner.waitOwnership?.checkpoint;
  if (delivery.kind === "checkpoint" && (state.settlement || state.continuation?.phase === "delivery"
    || owner.resumePrompt !== delivery.text || owner.resumePromptGeneration !== delivery.promptGeneration
    || checkpoint?.generation !== delivery.promptGeneration || checkpoint.origin.kind !== "review"
    || checkpoint.origin.directory !== state.directory || checkpoint.origin.generation !== state.generation)) throw new ReviewSuperseded();
  return state;
}

export async function reviewDeliveryBlocked(delivery: ReviewDelivery | undefined, taskId: string): Promise<string | null> {
  if (!delivery) return null;
  try {
    await db.transaction((transaction) => reviewDeliveryAuthority(transaction, delivery, taskId), { behavior: "immediate" });
    return null;
  } catch (error) {
    if (error instanceof ReviewSuperseded) return error.message;
    throw error;
  }
}

import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { freeReviewRuns, regressionEvidence, tasks } from "./db/schema.js";
import type { ReviewTargetIdentity } from "./db/schema-regression-evidence.js";
import type { TaskWaitOwnership, WaitOrigin } from "./db/schema-task-wait.js";
import type { ConclusionTransaction } from "./regression-conclusion-commit.js";
import { activeReviewScope, reviewIdentityMatches, reviewTargetIdentity, ReviewSuperseded } from "./review-ownership.js";
import { resumePromptVoidPatch } from "./task-resume-prompt.js";
import { freeReviewEvidenceDir } from "./free-review-files.js";
import { isTurnClaimed } from "./runs.js";
import { now } from "./util.js";

type TaskRow = typeof tasks.$inferSelect;
type EvidenceRow = typeof regressionEvidence.$inferSelect;

export const reviewWaitOrigin = (state: EvidenceRow): WaitOrigin => ({
  kind: "review", directory: state.directory, generation: state.generation,
});

async function scopeOrigin(transaction: ConclusionTransaction, owner: TaskRow): Promise<WaitOrigin | undefined> {
  const scope = await activeReviewScope(transaction, owner);
  if (!scope) return;
  const state = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, scope.directory)))[0];
  return { kind: "unknown", directory: scope.directory, generation: state?.generation ?? null };
}

export async function captureTaskWait(transaction: ConclusionTransaction, owner: TaskRow): Promise<TaskWaitOwnership> {
  owner = (await transaction.select().from(tasks).where(eq(tasks.id, owner.id)))[0]!;
  const ownership = { ...owner.waitOwnership };
  const origin = await scopeOrigin(transaction, owner);
  if (!origin) return ownership;
  if (!ownership.question && owner.question) ownership.question = {
    occupancy: randomUUID(), origin, text: owner.question, options: owner.questionOptions, items: owner.questionItems,
  };
  if (!ownership.checkpoint) ownership.checkpoint = { generation: owner.resumePromptGeneration, origin };
  await transaction.update(tasks).set({ waitOwnership: ownership }).where(eq(tasks.id, owner.id));
  return ownership;
}

export async function startTaskWaitTurn(transaction: ConclusionTransaction, owner: TaskRow,
  identity: ReviewTargetIdentity, origin: WaitOrigin): Promise<void> {
  const ownership = await captureTaskWait(transaction, owner);
  await transaction.update(tasks).set({ waitOwnership: { ...ownership, turn: { identity, origin } } })
    .where(eq(tasks.id, owner.id));
}

async function writerOrigin(transaction: ConclusionTransaction, owner: TaskRow): Promise<WaitOrigin> {
  const turn = owner.waitOwnership?.turn;
  if (turn && reviewIdentityMatches(owner, turn.identity)) return turn.origin;
  const scope = await activeReviewScope(transaction, owner);
  if (!scope) return { kind: "ordinary" };
  const state = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, scope.directory)))[0];
  if (state?.settlement?.pending === false) return { kind: "ordinary" };
  if (state && (reviewIdentityMatches(owner, state.targetIdentity)
    || reviewIdentityMatches(owner, state.continuation?.wait?.owner) || owner.reviewOf)) return reviewWaitOrigin(state);
  if (!state || (!state.targetIdentity && !state.continuation?.wait)) return {
    kind: "unknown", directory: scope.directory, generation: state?.generation ?? null,
  };
  return { kind: "ordinary" };
}

export async function recordTaskWait(transaction: ConclusionTransaction, owner: TaskRow,
  field: "question" | "checkpoint", explicitOrigin?: WaitOrigin): Promise<void> {
  const ownership = { ...owner.waitOwnership };
  if (field === "checkpoint" && ownership.checkpoint?.generation === owner.resumePromptGeneration) return;
  const origin = explicitOrigin ?? await writerOrigin(transaction, owner);
  if (origin.kind === "review") {
    const state = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, origin.directory)))[0];
    if (state?.settlement?.pending === false) throw new ReviewSuperseded();
  }
  if (explicitOrigin || !reviewIdentityMatches(owner, ownership.turn?.identity)) {
    ownership.turn = { identity: reviewTargetIdentity(owner), origin };
  }
  if (field === "question" && owner.question) ownership.question = {
    occupancy: randomUUID(), origin, text: owner.question, options: owner.questionOptions, items: owner.questionItems,
  };
  if (field === "checkpoint") ownership.checkpoint = { generation: owner.resumePromptGeneration, origin };
  await transaction.update(tasks).set({ waitOwnership: ownership }).where(eq(tasks.id, owner.id));
}

const belongsTo = (origin: WaitOrigin | undefined, state: EvidenceRow) => origin && origin.kind !== "ordinary"
  && origin.directory === state.directory && (origin.generation === null || origin.generation === state.generation
    || (!state.targetIdentity && !state.settlement?.target));

export function questionWaitMatches(owner: TaskRow, question = owner.waitOwnership?.question): boolean {
  return !!question && owner.question === question.text && owner.questionOptions === question.options && owner.questionItems === question.items;
}

export async function expireTaskWait(transaction: ConclusionTransaction, owner: TaskRow, state: EvidenceRow): Promise<boolean> {
  const current = (await transaction.select().from(tasks).where(eq(tasks.id, owner.id)))[0]!;
  const question = current.waitOwnership?.question;
  const clearQuestion = belongsTo(question?.origin, state) && questionWaitMatches(current, question);
  const checkpoint = current.waitOwnership?.checkpoint;
  // 系统替任务自己写的那一格(resumePromptAuto:名下还有没了结的哨兵)**不是审查的遗留**,
  // 一轮审查结束不许把它作废 —— 作废了这个任务就再也不会被哨兵结果叫醒,而那条等待跟审查
  // 没有半点关系。审查自己挂的检查点走 pause_task(auto=false),照旧在这里收口。判据与
  // review-continuation.ts 的 ownsWait 那一侧同源。
  const clearCheckpoint = !current.resumePromptAuto && belongsTo(checkpoint?.origin, state)
    && checkpoint?.generation === current.resumePromptGeneration;
  return expireFields(transaction, current, !!clearQuestion, !!clearCheckpoint);
}

async function expireFields(transaction: ConclusionTransaction, current: TaskRow,
  clearQuestion: boolean, clearCheckpoint: boolean): Promise<boolean> {
  if (!clearQuestion && !clearCheckpoint) return false;
  await transaction.update(tasks).set({
    ...(clearQuestion ? { question: null, questionOptions: null, questionItems: null } : {}),
    ...(clearCheckpoint ? resumePromptVoidPatch() : {}), updatedAt: now(),
  }).where(eq(tasks.id, current.id));
  return true;
}

export async function questionWaitOrigin(transaction: ConclusionTransaction, owner: TaskRow): Promise<WaitOrigin> {
  if (questionWaitMatches(owner)) return owner.waitOwnership!.question!.origin;
  const scope = await scopeOrigin(transaction, owner);
  if (scope) return scope;
  const historical = (await transaction.select().from(regressionEvidence)
    .where(and(eq(regressionEvidence.taskId, owner.reviewOf ?? owner.id), isNotNull(regressionEvidence.settlement))).limit(1))[0];
  if (historical) return { kind: "unknown", directory: historical.directory, generation: historical.generation };
  const run = (await transaction.select().from(freeReviewRuns).where(eq(freeReviewRuns.taskId, owner.id))
    .orderBy(desc(freeReviewRuns.updatedAt)).limit(1))[0];
  return run ? { kind: "unknown", directory: freeReviewEvidenceDir(owner.id, run.id, run.currentRound), generation: null }
    : { kind: "ordinary" };
}

export async function checkpointWaitOrigin(transaction: ConclusionTransaction, owner: TaskRow): Promise<WaitOrigin> {
  const checkpoint = owner.waitOwnership?.checkpoint;
  return checkpoint?.generation === owner.resumePromptGeneration ? checkpoint.origin
    : questionWaitOrigin(transaction, { ...owner, waitOwnership: null });
}

export async function expireClosedTaskWait(transaction: ConclusionTransaction, owner: TaskRow): Promise<boolean> {
  if (owner.mode !== "single" || ["running", "queued"].includes(owner.status) || isTurnClaimed(owner.id)) return false;
  const scope = await activeReviewScope(transaction, owner);
  const ownership = { ...owner.waitOwnership };
  const unknown = (!ownership.question && owner.question) || (!ownership.checkpoint && owner.resumePrompt)
    ? await questionWaitOrigin(transaction, { ...owner, waitOwnership: null }) : undefined;
  if (unknown && unknown.kind !== "ordinary") {
    if (!ownership.question && owner.question) ownership.question = { occupancy: randomUUID(), origin: unknown,
      text: owner.question, options: owner.questionOptions, items: owner.questionItems };
    if (!ownership.checkpoint && owner.resumePrompt) ownership.checkpoint = { origin: unknown, generation: owner.resumePromptGeneration };
  }
  const expired = async (origin: WaitOrigin | undefined) => {
    if (!origin || origin.kind === "ordinary") return false;
    const state = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, origin.directory)))[0];
    return scope?.directory !== origin.directory || state?.settlement?.pending === false
      || (!!state && origin.generation !== null && state.generation !== origin.generation)
      || (!state && !!owner.reviewOf && ["done", "failed", "canceled"].includes(owner.status));
  };
  const clearQuestion = questionWaitMatches({ ...owner, waitOwnership: ownership }) && await expired(ownership.question?.origin);
  const clearCheckpoint = ownership.checkpoint?.generation === owner.resumePromptGeneration && await expired(ownership.checkpoint?.origin);
  if (!clearQuestion && !clearCheckpoint) return false;
  await transaction.update(tasks).set({ waitOwnership: ownership }).where(eq(tasks.id, owner.id));
  return expireFields(transaction, owner, clearQuestion, clearCheckpoint);
}

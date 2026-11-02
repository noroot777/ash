import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { freeReviewRuns, regressionEvidence, tasks } from "./db/schema.js";
import type { ReviewTargetIdentity } from "./db/schema-regression-evidence.js";
import type { TaskWaitOwnership, WaitOrigin } from "./db/schema-task-wait.js";
import type { ConclusionTransaction } from "./regression-conclusion-commit.js";
import { activeReviewScope, reviewIdentityMatches, reviewTargetIdentity, ReviewSuperseded } from "./review-ownership.js";
import { resumePromptVoidPatch } from "./task-resume-prompt.js";
import { freeReviewEvidenceDir } from "./free-review-files.js";
import { isTurnClaimed, turnIdentity } from "./runs.js";
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
  // 这里是**补记**一格早已挂着的等待(回合开始时照一张相),写它的那个回合早过去了 ——
  // 所以 `writer` 一律留空(= 不知道是谁写的),不许拿当下这个回合冒充。
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
  if (field === "checkpoint") ownership.checkpoint = {
    generation: owner.resumePromptGeneration, origin, writer: checkpointWriter(owner.id),
  };
  await transaction.update(tasks).set({ waitOwnership: ownership }).where(eq(tasks.id, owner.id));
}

/** 此刻占着这个任务回合的是谁。没人占着(不在回合里写的)= 不知道。 */
function checkpointWriter(taskId: string): NonNullable<TaskWaitOwnership["checkpoint"]>["writer"] {
  const identity = turnIdentity(taskId);
  return identity ? { role: identity.role, review: identity.review } : undefined;
}

/**
 * 系统代写的那一格(`resumePromptAuto`)归谁 —— **三态**。
 *
 *  · `review`  —— 写它的回合就是这一轮审查(role=reviewer,且绑的 run/round 对得上);
 *  · `other`   —— 写它的回合是别人(执行者,或者另一轮审查);
 *  · `unknown` —— **没记下是谁写的**:升级前那一代的存量行,或者补记时根本不在回合里。
 *
 * 三态不能折叠成两态。`unknown` 塌到 `other` 看着保守,其实只在「作废别人的等待」那一侧
 * 保守,在「提前结算一轮审查」那一侧恰好相反:升级那一刻库里那些旧等待全是 unknown,
 * 于是「还不知道谁写的」被读成「这不是审查自己的等待」,一轮还在等构建结果的审查被结成
 * `status:"error"`(第 2 轮自由审查 F3 跨版本实测)。两侧各自决定 unknown 怎么处理。
 */
export type AutoCheckpointOwner = "review" | "other" | "unknown";

export function autoCheckpointOwner(checkpoint: TaskWaitOwnership["checkpoint"],
  state: EvidenceRow): AutoCheckpointOwner {
  const writer = checkpoint?.writer;
  if (!writer) return "unknown";
  if (writer.role !== "reviewer") return "other";
  // 没绑轮次 = 就地验证那种旁路回合(一个任务同时只有一轮),绑了就得对上这一轮。
  return !writer.review
    || freeReviewEvidenceDir(state.taskId, writer.review.run, writer.review.round) === state.directory
    ? "review" : "other";
}

/**
 * 系统代写的那一格(`resumePromptAuto`)是**这一轮审查自己**挂下的吗。
 *
 * 为什么要这一问:`beginTerminalLanding` 名下还有没了结的哨兵时会替**当前这一轮**自动写一格
 * 检查点,而它对回合身份一视同仁 —— 执行者那一轮会写,审查旁路那一轮也会写。早先这里拿
 * 「是不是系统代写的」当「是不是执行者的」用,于是审查自己还在等构建结果、却被判成「没有人
 * 在等」:round 以 `status:"error"`、`conclusion:null` 提前结账(自由审查实测复现)。
 *
 * 真正分得开的是**哪个回合写的**:审查旁路回合的 role 是 `reviewer`,而且绑着它那一轮的
 * run/round。不知道是谁写的(旧行、或者写入时没占着回合)一律按「不是这一轮的」算 ——
 * 两处调用点上这都是保守方向:不挡审查交卷,也不作废别人的等待。
 */
export function reviewOwnsAutoCheckpoint(checkpoint: TaskWaitOwnership["checkpoint"],
  state: EvidenceRow): boolean {
  return autoCheckpointOwner(checkpoint, state) === "review";
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
  // 系统替任务自己写的那一格(resumePromptAuto:名下还有没了结的哨兵)**多半不是审查的遗留**,
  // 一轮审查结束不许把它作废 —— 作废了这个任务就再也不会被哨兵结果叫醒。但「是不是系统代写
  // 的」答不了「是不是这一轮审查的」:审查旁路回合自己也会被代写这么一格。所以这一档按
  // **哪个回合写的**判(reviewOwnsAutoCheckpoint),非 auto 的那种本来就没这层歧义,照旧只看
  // 归属。判据与 review-continuation.ts 那一侧同源。
  // 这一侧 unknown 按**不作废**处理(reviewOwnsAutoCheckpoint 只认 `review`):作废是破坏性的,
  // 不知道是谁的就别动它。另一侧(review-continuation 的提前结算)对 unknown 的处理相反,
  // 理由见 autoCheckpointOwner 的注释。
  const clearCheckpoint = (!current.resumePromptAuto || reviewOwnsAutoCheckpoint(checkpoint, state))
    && belongsTo(checkpoint?.origin, state)
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

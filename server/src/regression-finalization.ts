import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "./db/index.js";
import { regressionEvidence, scheduledMessages, sessions, tasks } from "./db/schema.js";
import type { RegressionFinalization } from "./db/schema-regression-evidence.js";
import type { ConclusionTransaction } from "./regression-conclusion-commit.js";
import { pendingMessageRow, publishPendingMessages } from "./pending-messages.js";
import { isTurnClaimed } from "./runs.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { assertReviewAuthority, finalizationAuthority, ReviewSuperseded, settlementAuthority } from "./review-ownership.js";

const draining = new Map<string, Promise<void>>();

export function isFinalizationDraining(directory: string): boolean { return draining.has(directory); }
export async function waitForFinalizationDrain(directory: string): Promise<void> { await draining.get(directory); }

export async function finalizationStep(directory: string, generation: string, name: string,
  action: () => Promise<unknown>): Promise<void> {
  const state = (await db.select().from(regressionEvidence).where(eq(regressionEvidence.directory, directory)))[0];
  if (!state?.finalization || state.generation !== generation || state.finalization.done.includes(name)) return;
  await action();
  await commitFinalizationStep(directory, generation, name);
}

export async function commitFinalizationStep(directory: string, generation: string, name: string,
  write: (transaction: ConclusionTransaction) => Promise<void> = async () => {}): Promise<boolean> {
  return db.transaction(async (transaction) => {
    const state = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, directory)))[0];
    if (!state?.finalization || state.generation !== generation || state.finalization.done.includes(name)) return false;
    await write(transaction);
    await transaction.update(regressionEvidence).set({ finalization: {
      ...state.finalization, done: [...state.finalization.done, name],
    } }).where(eq(regressionEvidence.directory, directory));
    return true;
  }, { behavior: "immediate" });
}

export async function checkpointFinalizationWorkflow(directory: string, generation: string, stepId: string,
  phase: "started" | "done" | "failed" = "done", halted = false): Promise<void> {
  await db.transaction(async (transaction) => {
    const state = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, directory)))[0];
    if (!state?.finalization || state.generation !== generation) throw new Error("审查收尾代次已变化");
    await assertReviewAuthority(transaction, finalizationAuthority(state));
    await transaction.update(regressionEvidence).set({ finalization: {
      ...state.finalization, runningStep: phase === "started" ? stepId : undefined,
      blockedStep: phase === "failed" && (state.finalization.acceptance || halted) ? stepId : undefined,
      steps: phase === "done" ? [...new Set([...state.finalization.steps, stepId])] : state.finalization.steps,
    } }).where(eq(regressionEvidence.directory, directory));
  }, { behavior: "immediate" });
}

export async function appendFinalizationTimeline(taskId: string, text: string, eventKey: string): Promise<void> {
  if (!await appendTaskTimeline(taskId, text, { eventKey }) && (await db.select({ id: sessions.id }).from(sessions)
    .where(eq(sessions.taskId, taskId)).limit(1)).length) throw new Error("审查收尾时间线暂不可写");
}

export async function enqueueFinalizationRepair(directory: string, generation: string, taskId: string, text: string,
  guard: { turnToken: string | null; directionToken: string | null; directionEpoch: number },
  write?: (transaction: ConclusionTransaction) => Promise<void>, inputKey?: string): Promise<void> {
  await db.transaction(async (transaction) => {
    const state = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, directory)))[0];
    if (!state?.finalization || state.generation !== generation) throw new ReviewSuperseded();
    const plan = state.finalization;
    const authority = plan.acceptance ? finalizationAuthority(state) : settlementAuthority(state);
    await assertReviewAuthority(transaction, authority);
    const task = (await transaction.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    if (!task || task.directionEpoch !== guard.directionEpoch) throw new ReviewSuperseded();
    const stepId = plan.runningStep ?? plan.blockedStep;
    const attempt = (plan.repair?.attempt ?? 0) + 1;
    const key = inputKey ? `repair:${inputKey}` : plan.acceptance ? `repair:${stepId}:${attempt}` : "repair";
    if (plan.done.includes(key)) return;
    if (plan.acceptance && !stepId) throw new ReviewSuperseded();
    const messageId = `review-repair-${generation}${inputKey ? `-${inputKey}` : plan.acceptance ? `-${attempt}` : ""}`;
    const message = pendingMessageRow({ taskId, text, origin: `review-settlement:${generation}` });
    await write?.(transaction);
    await transaction.insert(scheduledMessages).values({ ...message, id: messageId }).onConflictDoNothing();
    const current = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, directory)))[0]!;
    await transaction.update(regressionEvidence).set({ finalization: { ...current.finalization!,
      done: [...current.finalization!.done, key],
      ...(plan.acceptance ? { repair: { messageId, token: plan.acceptance.token, stepId: stepId!, attempt, identity: authority.target! } } : {}),
    } }).where(eq(regressionEvidence.directory, directory));
  }, { behavior: "immediate" });
  publishPendingMessages(taskId);
}

export async function drainRegressionFinalization(directory: string, retry = false): Promise<void> {
  if (draining.has(directory)) return;
  let finish = () => {};
  draining.set(directory, new Promise<void>((resolve) => { finish = resolve; }));
  try {
    if (retry) await db.transaction(async (transaction) => {
      const state = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, directory)))[0];
      if (!state?.finalization || state.finalization.completed) return;
      await assertReviewAuthority(transaction, finalizationAuthority(state));
      await transaction.update(regressionEvidence).set({ finalization: { ...state.finalization,
        runningStep: undefined, blockedStep: undefined } }).where(eq(regressionEvidence.directory, directory));
    }, { behavior: "immediate" });
    if (retry) await appendTaskTimeline((await db.select().from(regressionEvidence)
      .where(eq(regressionEvidence.directory, directory)))[0]!.taskId,
    "本次验收明确补跑原审查尚未完成的尾段；中断站可能已有外部副作用，请核对后按站内幂等约定处理。");
    const state = (await db.select().from(regressionEvidence).where(eq(regressionEvidence.directory, directory)))[0];
    if (!state?.finalization || state.finalization.completed) return;
    try {
      if (state.finalization.kind === "preset") {
        if (!await (await import("./review-finalization.js")).finalizePresetReview(state)) return;
      } else {
        await (await import("./free-review-finalization.js")).finalizeFreeReview(state);
      }
    } catch (error) {
      if (!(error instanceof ReviewSuperseded)) throw error;
      await db.transaction(async (transaction) => {
        const current = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, directory)))[0];
        if (current?.generation === state.generation && current.finalization) await transaction.update(regressionEvidence)
          .set({ finalization: { ...current.finalization, completed: true, superseded: true } })
          .where(eq(regressionEvidence.directory, directory));
      }, { behavior: "immediate" });
      return;
    }
    const current = (await db.select().from(regressionEvidence).where(eq(regressionEvidence.directory, directory)))[0];
    if (current?.generation === state.generation && current.finalization) await db.transaction(async (transaction) => {
      const latest = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, directory)))[0]!;
      if (latest.generation !== state.generation || !latest.finalization) return;
      if (latest.finalization.acceptance) {
        await assertReviewAuthority(transaction, finalizationAuthority(latest));
        await transaction.update(tasks).set({ acceptedTailPending: false, acceptedTailDone: "[]" })
          .where(eq(tasks.id, latest.taskId));
      }
      await transaction.update(regressionEvidence).set({ finalization: { ...latest.finalization, completed: true } })
        .where(and(eq(regressionEvidence.directory, directory), eq(regressionEvidence.generation, state.generation)));
    }, { behavior: "immediate" });
  } finally { draining.delete(directory); finish(); }
}

export async function reconcileRegressionFinalizations(ownerTaskId?: string): Promise<void> {
  const states = await db.select().from(regressionEvidence).where(isNotNull(regressionEvidence.finalization));
  for (const state of states) {
    if (state.finalization?.completed || (ownerTaskId && state.settlement?.ownerTaskId !== ownerTaskId)) continue;
    const task = (await db.select().from(tasks).where(eq(tasks.id, state.settlement?.ownerTaskId ?? state.taskId)))[0];
    if (!task || task.status === "running" || task.status === "queued" || isTurnClaimed(task.id)) continue;
    try { await drainRegressionFinalization(state.directory); }
    catch (error) { console.error(`[ash] 审查收尾待重试 ${state.directory}:`, error); }
  }
}

export function finalization(kind: RegressionFinalization["kind"], payload: unknown): RegressionFinalization {
  return { kind, payload: JSON.stringify(payload), done: [], steps: [] };
}

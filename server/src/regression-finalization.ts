import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "./db/index.js";
import { regressionEvidence, scheduledMessages, sessions, tasks } from "./db/schema.js";
import type { RegressionFinalization } from "./db/schema-regression-evidence.js";
import type { ConclusionTransaction } from "./regression-conclusion-commit.js";
import { pendingMessageRow, publishPendingMessages } from "./pending-messages.js";
import { isTurnClaimed } from "./runs.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { assertReviewAuthority, ReviewSuperseded, settlementAuthority } from "./review-ownership.js";

const draining = new Set<string>();

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
  phase: "started" | "done" | "failed" = "done"): Promise<void> {
  await db.transaction(async (transaction) => {
    const state = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, directory)))[0];
    if (!state?.finalization || state.generation !== generation) throw new Error("审查收尾代次已变化");
    await assertReviewAuthority(transaction, settlementAuthority(state), phase !== "started");
    await transaction.update(regressionEvidence).set({ finalization: {
      ...state.finalization, runningStep: phase === "started" ? stepId : undefined,
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
  write?: (transaction: ConclusionTransaction) => Promise<void>): Promise<void> {
  const message = pendingMessageRow({ taskId, text, origin: `review-settlement:${generation}` });
  await commitFinalizationStep(directory, generation, "repair", async (transaction) => {
    const state = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, directory)))[0]!;
    await assertReviewAuthority(transaction, settlementAuthority(state));
    const task = (await transaction.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    if (!task || task.directionEpoch !== guard.directionEpoch) throw new ReviewSuperseded();
    await write?.(transaction);
    await transaction.insert(scheduledMessages).values({ ...message, id: `review-repair-${generation}` }).onConflictDoNothing();
  });
  publishPendingMessages(taskId);
}

export async function drainRegressionFinalization(directory: string): Promise<void> {
  if (draining.has(directory)) return;
  draining.add(directory);
  try {
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
    if (current?.generation === state.generation && current.finalization) await db.update(regressionEvidence)
      .set({ finalization: { ...current.finalization, completed: true } })
      .where(and(eq(regressionEvidence.directory, directory), eq(regressionEvidence.generation, state.generation)));
  } finally { draining.delete(directory); }
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

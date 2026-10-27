import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { regressionEvidence, scheduledMessages, tasks } from "./db/schema.js";
import type { TaskWaitOwnership } from "./db/schema-task-wait.js";
import { assertReviewAuthority, finalizationAuthority, ReviewSuperseded, type ReviewAuthority } from "./review-ownership.js";
import { now } from "./util.js";
import type { AcceptTail } from "./task-accept-tail.js";

export async function commitAcceptanceStage(taskId: string, stage: "merged" | "accepted",
  patch: Partial<typeof tasks.$inferInsert> = {}, authority?: ReviewAuthority): Promise<void> {
  await db.transaction(async (transaction) => {
    const task = (await transaction.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    if (!task) throw new ReviewSuperseded();
    let ownership: TaskWaitOwnership = { ...task.waitOwnership, acceptedFinalization: undefined };
    if (authority) await assertReviewAuthority(transaction, authority);
    if (authority?.finalization) {
      const state = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, authority.directory)))[0]!;
      const plan = state.finalization;
      const stepId = plan?.runningStep ?? plan?.acceptance?.stepId ?? plan?.blockedStep;
      if (!plan || plan.completed || !stepId) throw new ReviewSuperseded();
      const token = plan.acceptance?.token ?? randomUUID();
      ownership = { ...task.waitOwnership, acceptedFinalization: { directory: state.directory, generation: state.generation, token } };
      await transaction.update(regressionEvidence).set({ finalization: { ...plan, acceptance: { token, stepId, stage },
        ...(stage === "accepted" ? { runningStep: undefined, steps: [...new Set([...plan.steps, stepId])] } : {}),
      } }).where(eq(regressionEvidence.directory, state.directory));
    }
    await transaction.update(tasks).set({ ...patch, stage, updatedAt: now(), waitOwnership: ownership,
      ...(authority?.finalization ? { acceptedTailPending: true, acceptedTailDone: "[]" } : {}),
    }).where(eq(tasks.id, taskId));
  }, { behavior: "immediate" });
}

export async function reviewAcceptanceAuthority(taskId: string): Promise<ReviewAuthority | undefined> {
  return db.transaction(async (transaction) => {
    const task = (await transaction.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    const receipt = task?.waitOwnership?.acceptedFinalization;
    if (!receipt) return;
    const state = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, receipt.directory)))[0];
    if (!state?.finalization || state.finalization.completed || state.generation !== receipt.generation) return;
    const authority = finalizationAuthority(state);
    try { await assertReviewAuthority(transaction, authority); }
    catch (error) { if (error instanceof ReviewSuperseded) return; throw error; }
    return authority;
  }, { behavior: "immediate" });
}

export async function resumeReviewAcceptedTail(taskId: string, originalCaller: boolean): Promise<AcceptTail | null | undefined> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0];
  if (!task?.waitOwnership?.acceptedFinalization) return undefined;
  const { drainRegressionFinalization, isFinalizationDraining, waitForFinalizationDrain } = await import("./regression-finalization.js");
  if (originalCaller && isFinalizationDraining(task.waitOwnership.acceptedFinalization.directory)) return null;
  await waitForFinalizationDrain(task.waitOwnership.acceptedFinalization.directory);
  const authority = await reviewAcceptanceAuthority(taskId);
  if (!authority) {
    const current = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    const state = (await db.select().from(regressionEvidence)
      .where(eq(regressionEvidence.directory, task.waitOwnership.acceptedFinalization.directory)))[0];
    const completed = state?.generation === task.waitOwnership.acceptedFinalization.generation
      && state.finalization?.completed && !state.finalization.superseded && !current?.acceptedTailPending;
    return { ok: !!completed, ...(!completed ? { reason: "原审查验收尾段未完成或权限已撤回，不能视为补跑成功。" } : {}) };
  }
  const current = (await db.select().from(regressionEvidence).where(eq(regressionEvidence.directory, authority.directory)))[0]!;
  const repair = current.finalization?.repair;
  const message = repair && (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, repair.messageId)))[0];
  if (message?.status === "pending") return { ok: false, reason: "验收尾段的修复输入仍待投递，请先完成修复再补跑。" };
  await drainRegressionFinalization(authority.directory, true);
  const state = (await db.select().from(regressionEvidence).where(eq(regressionEvidence.directory, authority.directory)))[0]!;
  return { ok: !!state.finalization?.completed && !state.finalization.superseded,
    ...(!state.finalization?.completed || state.finalization.superseded
      ? { reason: "原审查验收尾段仍待处理或权限已撤回，可核对时间线后再次验收补跑。" } : {}) };
}

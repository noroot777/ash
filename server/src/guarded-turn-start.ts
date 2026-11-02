import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import type { ConclusionTransaction } from "./regression-conclusion-commit.js";
import type { ReviewStartReceipt } from "./review-start-withdrawal.js";
import { directionIdentityCleared } from "./task-direction-epoch.js";
import { taskStartStatus, recordTaskStatus } from "./task-start-status.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";

export async function rememberGuardedStart(transaction: ConclusionTransaction, task: typeof tasks.$inferSelect,
  receipt: ReviewStartReceipt, messageId?: string): Promise<void> {
  const owner = (await transaction.select().from(tasks).where(eq(tasks.id, task.id)))[0]!;
  await transaction.update(tasks).set({ waitOwnership: { ...owner.waitOwnership,
    ...(receipt.repair && messageId ? { repairDelivery: { messageId, generation: receipt.generation, identity: receipt.identity } } : {}),
    start: { ...receipt, priorStatus: taskStartStatus(task), phase: "prepared" } } }).where(eq(tasks.id, task.id));
}

export async function clearGuardedStart(transaction: ConclusionTransaction, task: typeof tasks.$inferSelect): Promise<void> {
  if (task.waitOwnership?.start) await transaction.update(tasks).set({ waitOwnership: { ...task.waitOwnership, start: undefined } })
    .where(eq(tasks.id, task.id));
}

export async function recordReviewStartNotLaunched(taskId: string, receipt: ReviewStartReceipt | undefined): Promise<void> {
  if (!receipt) return;
  await db.transaction(async (transaction) => {
    const task = (await transaction.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    const start = task?.waitOwnership?.start;
    if (!task || !start || start.directory !== receipt.directory || start.generation !== receipt.generation
      || JSON.stringify(start.identity) !== JSON.stringify(receipt.identity)
      || task.activeTurnToken !== receipt.identity.turnToken || task.activeDirectionToken !== receipt.identity.directionToken
      || task.directionEpoch !== receipt.identity.directionEpoch || start.phase === "uncertain") return;
    await transaction.update(tasks).set({ waitOwnership: { ...task.waitOwnership, start: { ...start, phase: "prepared" } } })
      .where(eq(tasks.id, taskId));
  }, { behavior: "immediate" });
}

export async function forgetGuardedStart(taskId: string, receipt: ReviewStartReceipt | undefined): Promise<void> {
  if (!receipt) return;
  await db.transaction(async (transaction) => {
    const task = (await transaction.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    const start = task?.waitOwnership?.start;
    if (!task || !start || start.directory !== receipt.directory || start.generation !== receipt.generation
      || start.identity.turnToken !== receipt.identity.turnToken || start.identity.directionToken !== receipt.identity.directionToken
      || start.identity.directionEpoch !== receipt.identity.directionEpoch) return;
    await clearGuardedStart(transaction, task);
  }, { behavior: "immediate" });
}

export async function withdrawRepairStart(taskId: string, receipt: ReviewStartReceipt): Promise<void> {
  const withdrawn = await db.transaction(async (transaction) => {
    const task = (await transaction.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    const start = task?.waitOwnership?.start;
    if (!task || !start?.repair || start.directory !== receipt.directory || start.generation !== receipt.generation
      || start.identity.turnToken !== receipt.identity.turnToken || start.identity.directionToken !== receipt.identity.directionToken
      || start.identity.directionEpoch !== receipt.identity.directionEpoch || task.activeTurnToken !== receipt.identity.turnToken
      || task.activeDirectionToken !== receipt.identity.directionToken || task.directionEpoch !== receipt.identity.directionEpoch) return;
    const status = ["running", "queued"].includes(start.priorStatus) ? "paused" as const : start.priorStatus;
    await transaction.update(tasks).set({ status, ...directionIdentityCleared(), followUpFrom: null, nativeTurn: false,
      completeConfirmedAt: null, updatedAt: now(), waitOwnership: { ...task.waitOwnership, start: undefined, repairDelivery: undefined },
      ...(["done", "failed", "canceled"].includes(status) ? { endedAt: now() } : {}),
    }).where(eq(tasks.id, taskId));
    return { task, status };
  }, { behavior: "immediate" });
  if (!withdrawn) return;
  recordTaskStatus(withdrawn.task, withdrawn.status);
  await appendTaskTimeline(taskId, "自动修复在启动前撤回（原方向失效或起跑中断），本轮没有启动，已释放运行状态；原审查结论保持不变。");
}

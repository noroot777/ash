import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { regressionEvidence, tasks } from "./db/schema.js";
import type { ReviewStartReceipt } from "./review-start-withdrawal.js";
import { activeReviewEvidence, assertReviewAuthority, reviewDeliveryAuthority, reviewIdentityMatches, ReviewSuperseded } from "./review-ownership.js";
import { directionIdentityCleared } from "./task-direction-epoch.js";
import { recordTaskStatus } from "./task-start-status.js";
import { publishTaskUpdated } from "./task-store.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";

export async function restoreUndeliveredReviewStart(taskId: string, receipt: ReviewStartReceipt | undefined): Promise<boolean> {
  if (!receipt) return false;
  const restored = await db.transaction(async (transaction) => {
    const task = (await transaction.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    const start = task?.waitOwnership?.start;
    if (!task || !start || start.directory !== receipt.directory || start.generation !== receipt.generation
      || JSON.stringify(start.identity) !== JSON.stringify(receipt.identity) || !reviewIdentityMatches(task, receipt.identity)) return;
    const state = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, receipt.directory)))[0];
    if (!state || state.generation !== receipt.generation) return;
    try {
      if (receipt.delivery) await reviewDeliveryAuthority(transaction, receipt.delivery, taskId);
      else {
        if (state.settlement || (await activeReviewEvidence(transaction, task))?.directory !== state.directory) return;
        await assertReviewAuthority(transaction, { directory: state.directory, generation: state.generation, target: state.targetIdentity }, true);
      }
    }
    catch (error) { if (error instanceof ReviewSuperseded) return; throw error; }
    if (!receipt.repair) {
      await transaction.update(regressionEvidence).set({ continuation: { ...state.continuation,
        phase: receipt.delivery?.kind === "answer" ? "delivery" : "waiting", start: undefined } })
        .where(eq(regressionEvidence.directory, receipt.directory));
    }
    const status = ["running", "queued"].includes(start.priorStatus) ? "paused" as const : start.priorStatus;
    await transaction.update(tasks).set({ status, ...directionIdentityCleared(), followUpFrom: null, nativeTurn: false,
      completeConfirmedAt: null, updatedAt: now(), waitOwnership: { ...task.waitOwnership, start: undefined },
    }).where(eq(tasks.id, taskId));
    return { task, status };
  }, { behavior: "immediate" });
  if (!restored) return false;
  recordTaskStatus(restored.task, restored.status);
  await publishTaskUpdated(taskId);
  await appendTaskTimeline(taskId, "这一轮尚未送达审查输入，启动已撤回；原答复或检查点仍保留，恢复后可继续投递。");
  return true;
}

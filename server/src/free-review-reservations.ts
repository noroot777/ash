import { eq } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { freeWorkflowStates } from "./db/schema.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";

export type ReservedFreeReview = {
  armed: boolean | null;
  reviewerId: string | null;
  checkMode: unknown;
  retryLimit: unknown;
} | null | undefined;

export async function startReservedFreeReview(
  taskId: string,
  reservation: ReservedFreeReview,
  start: (input: { reviewerId: string; checkMode: unknown; retryLimit: unknown }) => Promise<unknown>,
): Promise<void> {
  if (!reservation?.armed) return;
  if (!reservation.reviewerId) {
    await db.update(freeWorkflowStates).set({ reviewArmed: false, updatedAt: now() })
      .where(eq(freeWorkflowStates.taskId, taskId));
    await appendTaskTimeline(taskId, "完成后审查预约已取消：预约的审查者已不可用。");
    bus.publish({ type: "task.review", taskId });
    return;
  }
  try {
    await start({
      reviewerId: reservation.reviewerId,
      checkMode: reservation.checkMode,
      retryLimit: reservation.retryLimit,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendTaskTimeline(taskId, `完成后审查启动失败：${message}`);
    bus.publish({ type: "task.review", taskId });
  }
}

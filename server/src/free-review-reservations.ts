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
  note: unknown;
  /** 非空 = 自动复审链的续轮预约：在该 run 上续下一轮，而不是开新 run。 */
  runId?: string | null;
} | null | undefined;

// 「下次确认完成时派一轮审查」的唯一消费点。两种形态共用这一个槽位：
// - runId 非空：自动复审链的续轮（round 未通过、还有轮数时由结算自动挂上）
// - runId 为空：用户手动预约的新一条审查链
export async function startReservedFreeReview(
  taskId: string,
  reservation: ReservedFreeReview,
  handlers: {
    continueRun: (runId: string) => Promise<unknown>;
    startNew: (input: { reviewerId: string; checkMode: unknown; retryLimit: unknown; note: unknown }) => Promise<unknown>;
  },
): Promise<void> {
  if (!reservation?.armed) return;
  if (!reservation.runId && !reservation.reviewerId) {
    await db.update(freeWorkflowStates)
      .set({ reviewArmed: false, reviewNote: null, reviewRunId: null, updatedAt: now() })
      .where(eq(freeWorkflowStates.taskId, taskId));
    await appendTaskTimeline(taskId, "完成后审查预约已取消：预约的审查者已不可用。");
    bus.publish({ type: "task.review", taskId });
    return;
  }
  try {
    if (reservation.runId) {
      await handlers.continueRun(reservation.runId);
    } else {
      await handlers.startNew({
        reviewerId: reservation.reviewerId!,
        checkMode: reservation.checkMode,
        retryLimit: reservation.retryLimit,
        note: reservation.note,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendTaskTimeline(taskId, `完成后审查启动失败：${message}`);
    bus.publish({ type: "task.review", taskId });
  }
}

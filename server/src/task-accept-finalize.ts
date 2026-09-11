import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { disarmFreeReviewReservation } from "./free-review-reservations.js";
import { stopPreviewAtAccept } from "./preview.js";
import { setTaskStage } from "./task-stage.js";
import { hasAcceptedTail } from "./task-accept-tail.js";
import { acceptSharedTeamWorkers, sharedWorkerAcceptanceMessage, type SharedWorkerAcceptance } from "./task-accept-shared-workers.js";
import type { AcceptFailure } from "./task-accept-guard.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { publishTaskUpdated } from "./task-store.js";
import { now } from "./util.js";

type Finalization = { sharedWorkers: SharedWorkerAcceptance | null; failure?: never }
  | { failure: AcceptFailure; sharedWorkers?: never };

export async function finalizeAcceptance(
  task: typeof tasks.$inferSelect,
  message: string,
  completed: Pick<AcceptFailure, "completedMerge" | "completedTag"> = {},
): Promise<Finalization> {
  // 预览回收可能因记录权限失败，放在 accepted 落章前使重试仍能到达收尾。
  // 这时尾段还没执行，其中刻意开启的新预览不会被旧预览回收误伤。
  const preview = await stopPreviewAtAccept(task.id);
  if (!preview.stopped) {
    const error = `${completed.completedMerge ? "合并已完成，结果已保留。" : completed.completedTag ? "标签已保留。" : ""}${preview.message}验收收尾暂缓，处理后可再次验收。`;
    await appendTaskTimeline(task.id, error);
    return { failure: { accepted: false, httpStatus: 409, taskId: task.id,
      reason: "preview_cleanup_pending", error, status: task.status, phase: "before_accept", ...completed } };
  }
  await setTaskStage(task.id, "accepted");
  // 尾段 durable 进度：stage=accepted 先落、尾段后跑，进程死在中间的话重试会走
  // already_accepted 快路——不留痕迹，发布步骤就被静默永久漏掉。置位在这里、清零在
  // 尾段真正跑完之后，重试发现它还挂着就补跑。
  if (hasAcceptedTail(task)) {
    await db.update(tasks).set({ acceptedTailPending: true, acceptedTailDone: "[]", updatedAt: now() }).where(eq(tasks.id, task.id));
  }
  // 自由工作流：验收即终局，挂着的复审预约一并注销 —— 否则它会在任务日后被唤醒的
  // 某个回合里突然触发一场语境全变的审查（幽灵预约）。
  if (task.workflowMode === "free" && await disarmFreeReviewReservation(task.id)) {
    await appendTaskTimeline(task.id, "验收已完成，未消费的复审预约已一并取消。");
  }
  const sharedWorkers = task.mode === "team" ? await acceptSharedTeamWorkers(task.id) : null;
  await appendTaskTimeline(task.id, `${message}${sharedWorkers ? ` ${sharedWorkerAcceptanceMessage(sharedWorkers)}` : ""}`);
  await publishTaskUpdated(task.id);
  return { sharedWorkers };
}

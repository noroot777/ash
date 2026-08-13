import { and, eq, isNull } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
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
  /** 读到这条预约时的版本令牌（updatedAt）；消费用它做 CAS。 */
  updatedAt?: string | null;
} | null | undefined;

/**
 * 注销一个自由任务的复审预约（幂等）。验收成功、重复验收快路和启动迁移都调它——
 * 验收即终局，预约留着会在任务日后被唤醒的某个回合里触发语境全变的幽灵审查。
 * 返回是否真的清掉了（调用方决定要不要写时间线）。
 */
export async function disarmFreeReviewReservation(taskId: string): Promise<boolean> {
  const state = (await db.select({ reviewArmed: freeWorkflowStates.reviewArmed })
    .from(freeWorkflowStates).where(eq(freeWorkflowStates.taskId, taskId))).at(0);
  if (!state?.reviewArmed) return false;
  await db.update(freeWorkflowStates)
    .set({ reviewArmed: false, reviewNote: null, reviewRunId: null, updatedAt: now() })
    .where(eq(freeWorkflowStates.taskId, taskId));
  bus.publish({ type: "task.review", taskId });
  return true;
}

/** 读一条预约槽的完整快照（含版本令牌）。 */
export async function readFreeReviewReservation(taskId: string): Promise<ReservedFreeReview> {
  return (await db.select({
    armed: freeWorkflowStates.reviewArmed,
    reviewerId: freeWorkflowStates.selectedReviewerId,
    checkMode: freeWorkflowStates.reviewCheckMode,
    retryLimit: freeWorkflowStates.reviewRetryLimit,
    note: freeWorkflowStates.reviewNote,
    runId: freeWorkflowStates.reviewRunId,
    updatedAt: freeWorkflowStates.updatedAt,
  }).from(freeWorkflowStates).where(eq(freeWorkflowStates.taskId, taskId))).at(0);
}

// null/undefined 要走 IS NULL：eq(col, null) 在 SQL 里恒为假，会让 CAS 永远失败。
const sameAs = (col: SQLiteColumn, value: unknown): SQL =>
  value === null || value === undefined ? isNull(col) : eq(col, value as never);

/**
 * CAS 消费预约槽：只有「槽还是我读到的那一条」时才清空，并返回是否由本次消费。
 *
 * 产品明确允许用户在回合运行期间改预约。老写法是「结算读 A → 跑完无条件 armed=false」，
 * 于是用户中途保存的新预约 B 被这条迟到的清槽静默删掉（审查实测：B 的配置还在、预约位
 * 没了，下次确认完成什么都不会发生）。令牌就是 updatedAt：任何一次保存都会推进它。
 */
export async function consumeFreeReviewReservation(
  taskId: string,
  snapshot: ReservedFreeReview,
): Promise<boolean> {
  if (!snapshot?.armed) return false;
  const consumed = await db.update(freeWorkflowStates)
    .set({ reviewArmed: false, reviewRunId: null, updatedAt: now() })
    .where(and(
      eq(freeWorkflowStates.taskId, taskId),
      eq(freeWorkflowStates.reviewArmed, true),
      sameAs(freeWorkflowStates.reviewRunId, snapshot.runId ?? null),
      sameAs(freeWorkflowStates.selectedReviewerId, snapshot.reviewerId),
      sameAs(freeWorkflowStates.updatedAt, snapshot.updatedAt ?? null),
    ))
    .returning({ taskId: freeWorkflowStates.taskId });
  if (!consumed.length) return false;
  bus.publish({ type: "task.review", taskId });
  return true;
}

// 「下次确认完成时派一轮审查」的唯一消费点。两种形态共用这一个槽位：
// - runId 非空：自动复审链的续轮（round 未通过、还有轮数时由结算自动挂上）
// - runId 为空：用户手动预约的新一条审查链
//
// **先 CAS 消费、消费成功才启动**：反过来（先启动、后清槽）无法保证清掉的就是自己读到
// 的那一条。CAS 失败 = 槽在这中间被改过（用户保存了新预约 / 别处已消费）：重读一次按
// 最新那条再来，两次都抢不到就放手（此时槽里的预约仍然 armed，下次确认完成照常触发），
// 绝不把用户的新配置当成自己的那条清掉。
export async function startReservedFreeReview(
  taskId: string,
  reservation: ReservedFreeReview,
  handlers: {
    continueRun: (runId: string) => Promise<unknown>;
    startNew: (input: { reviewerId: string; checkMode: unknown; retryLimit: unknown; note: unknown }) => Promise<unknown>;
  },
): Promise<void> {
  let snapshot = reservation;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!snapshot?.armed) return;
    // 预约的审查者已被删除：这条预约永远执行不了，同样按 CAS 消费掉（消费不到就是
    // 被改过了，那条新预约自己会在下次完成时处理）。
    if (!snapshot.runId && !snapshot.reviewerId) {
      if (!(await consumeFreeReviewReservation(taskId, snapshot))) {
        snapshot = await readFreeReviewReservation(taskId);
        continue;
      }
      await appendTaskTimeline(taskId, "完成后审查预约已取消：预约的审查者已不可用。");
      return;
    }
    if (!(await consumeFreeReviewReservation(taskId, snapshot))) {
      snapshot = await readFreeReviewReservation(taskId);
      continue;
    }
    const consumed = snapshot;
    try {
      if (consumed.runId) {
        await handlers.continueRun(consumed.runId);
      } else {
        await handlers.startNew({
          reviewerId: consumed.reviewerId!,
          checkMode: consumed.checkMode,
          retryLimit: consumed.retryLimit,
          note: consumed.note,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendTaskTimeline(taskId, `完成后审查启动失败：${message}`);
      bus.publish({ type: "task.review", taskId });
    }
    return;
  }
  console.error(`[harness] free review reservation for ${taskId} kept being rewritten; left armed`);
}

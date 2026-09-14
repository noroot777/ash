// 「这个任务现在能不能进验收流程」——动 git 之前的四道前置拒绝。
//
// 从 task-accept.ts 拆出来的：它们都只读任务本身、一条都不碰仓库，和后面那套「合并 →
// 清理 → 盖章」的分阶段守卫（acceptanceGuard）不是一回事——那套要在仓库锁里反复重读，
// 这四道读一次就够。放一起只会让 acceptTaskUnlocked 的主线被开头一屏的拒绝淹掉。
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { hasActiveFreeReview } from "./free-workflow.js";
import type { AcceptFailure } from "./task-accept-guard.js";

/** 返回 null = 可以继续往下走；返回失败对象 = 直接回给调用方。 */
export async function acceptancePreflight(taskId: string): Promise<AcceptFailure | null> {
  const requestedTask = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!requestedTask) {
    return { accepted: false, httpStatus: 404, taskId, reason: "not_found", error: "not found", phase: "initial" };
  }
  // Archived = frozen/read-only（task-routes 的约定）：验收会合并、清理、改 stage，
  // 全是写操作，归档任务一律拒——run/reply/review/repair/preview 的门禁都这么做。
  if (requestedTask.archived) {
    return {
      accepted: false,
      httpStatus: 409,
      taskId,
      reason: "task_archived",
      error: "任务已归档（只读）；先取消归档再验收",
      status: requestedTask.status,
      phase: "initial",
    };
  }
  // 自由任务在任何**终态**都可验收：done 是正常路径；failed/canceled 是「修复失败/被
  // 手停后我接受上一版直接合并」——轮数用尽的时间线明确承诺过「由你决定验收」，只放行
  // done 会让那句话在修复失败分支变成假承诺（验收页按钮可见却 409）。
  if (
    requestedTask.workflowMode === "free"
    && requestedTask.stage !== "accepted"
    && requestedTask.stage !== "merged"
    && !["done", "failed", "canceled"].includes(requestedTask.status)
  ) {
    return {
      accepted: false,
      httpStatus: 409,
      taskId,
      reason: "free_workflow_not_ready_for_acceptance",
      error: "自由工作流尚未到可验收的状态；任务结束后再进入验收页处理",
      status: requestedTask.status,
      phase: "initial",
    };
  }
  if (
    requestedTask.workflowMode === "free"
    && requestedTask.stage !== "accepted"
    && await hasActiveFreeReview(taskId)
  ) {
    return {
      accepted: false,
      httpStatus: 409,
      taskId,
      reason: "free_review_in_progress",
      error: "自由工作流审查回合正在进行，结束后再验收",
      status: requestedTask.status,
      phase: "initial",
    };
  }
  const requestedParent = requestedTask.parentId
    ? (await db.select().from(tasks).where(eq(tasks.id, requestedTask.parentId))).at(0)
    : null;
  if (requestedTask.parentId && requestedParent?.mode === "team" && !requestedTask.useWorktree) {
    return {
      accepted: false,
      httpStatus: 409,
      taskId,
      reason: "shared_worker_acceptance_not_applicable",
      error: "执行者不需人工验收，请对团队整体验收",
      status: requestedTask.status,
      phase: "initial",
    };
  }
  return null;
}

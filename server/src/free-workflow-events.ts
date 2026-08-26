import type { FreeWorkflowExecutionStatus } from "@ash/shared";
import { and, eq } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { freeWorkflowEvents, tasks } from "./db/schema.js";
import { id, now } from "./util.js";

function executionDetail(status: FreeWorkflowExecutionStatus, endedAt: string | null): string {
  return JSON.stringify({ status, endedAt });
}

async function isFreeTask(taskId: string): Promise<boolean> {
  const task = (await db.select({ workflowMode: tasks.workflowMode, mode: tasks.mode, parentId: tasks.parentId, reviewOf: tasks.reviewOf })
    .from(tasks).where(eq(tasks.id, taskId))).at(0);
  return !!task && task.workflowMode === "free" && task.mode === "single" && !task.parentId && !task.reviewOf;
}

export async function recordFreeTaskExecutionStartIfFree(
  taskId: string,
  startedAt = now(),
): Promise<string | null> {
  if (!(await isFreeTask(taskId))) return null;
  const existing = (await db.select({ id: freeWorkflowEvents.id }).from(freeWorkflowEvents).where(and(
    eq(freeWorkflowEvents.taskId, taskId),
    eq(freeWorkflowEvents.kind, "task_execution"),
    eq(freeWorkflowEvents.occurredAt, startedAt),
  ))).at(0);
  if (existing) return existing.id;
  const eventId = id();
  await db.insert(freeWorkflowEvents).values({
    id: eventId,
    taskId,
    kind: "task_execution",
    source: "agent",
    detail: executionDetail("running", null),
    occurredAt: startedAt,
  });
  bus.publish({ type: "task.review", taskId });
  return eventId;
}

export async function finishFreeTaskExecution(
  eventId: string,
  status: Exclude<FreeWorkflowExecutionStatus, "running">,
  endedAt = now(),
): Promise<void> {
  const event = (await db.select({ taskId: freeWorkflowEvents.taskId, kind: freeWorkflowEvents.kind })
    .from(freeWorkflowEvents).where(eq(freeWorkflowEvents.id, eventId))).at(0);
  if (!event || event.kind !== "task_execution") return;
  await db.update(freeWorkflowEvents).set({ detail: executionDetail(status, endedAt) })
    .where(eq(freeWorkflowEvents.id, eventId));
  bus.publish({ type: "task.review", taskId: event.taskId });
}

/**
 * 一轮执行的「结账人」:**终态只认第一次请求的那个**,之后每次调用都只是重试它。
 *
 * 调用方(single-run)的 finally 上挂着一次固定传 "failed" 的兜底,那是给「异常路径没人
 * 结账」准备的。可正常路径要是第一次写库瞬时失败,这一笔就还没记成,兜底便会拿 "failed"
 * 再写一次并写成功 —— 一个 exit 0 的成功回合被永久记进活动时间线里当失败
 * (2026-08-25 第 5 轮审查)。结束时间同理:重试补的是**当时**那一笔账,不是重试那一刻。
 *
 * 写失败只警告不外抛:活动时间线是诊断用的账,记不上不该改变这一轮的真实结局。
 */
export function createExecutionCloser(
  executionEventId: string | null,
  taskId: string,
): (status: Exclude<FreeWorkflowExecutionStatus, "running">, endedAt: string) => Promise<void> {
  let finished = false;
  let intended: { status: Exclude<FreeWorkflowExecutionStatus, "running">; endedAt: string } | null = null;
  return async (status, endedAt) => {
    if (!executionEventId || finished) return;
    intended ??= { status, endedAt };
    try {
      await finishFreeTaskExecution(executionEventId, intended.status, intended.endedAt);
      finished = true;
    } catch (error) {
      console.warn(`[ash] failed to record free workflow execution end for ${taskId}:`, error);
    }
  };
}

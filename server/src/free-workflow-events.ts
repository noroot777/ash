import type {
  FreeWorkflowExecutionStatus,
  FreeWorkflowPreviewEventKind,
  FreeWorkflowPreviewEventSource,
} from "@ash/shared";
import { and, eq } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { freeWorkflowEvents, tasks } from "./db/schema.js";
import { id, now } from "./util.js";

export interface RecordFreePreviewEventInput {
  kind: FreeWorkflowPreviewEventKind;
  source: FreeWorkflowPreviewEventSource;
  detail: string | null;
  occurredAt?: string;
}

function executionDetail(status: FreeWorkflowExecutionStatus, endedAt: string | null): string {
  return JSON.stringify({ status, endedAt });
}

async function isFreeTask(taskId: string): Promise<boolean> {
  const task = (await db.select({ workflowMode: tasks.workflowMode, mode: tasks.mode, parentId: tasks.parentId, reviewOf: tasks.reviewOf })
    .from(tasks).where(eq(tasks.id, taskId))).at(0);
  return !!task && task.workflowMode === "free" && task.mode === "single" && !task.parentId && !task.reviewOf;
}

export async function recordFreePreviewEvent(
  taskId: string,
  input: RecordFreePreviewEventInput,
): Promise<void> {
  await db.insert(freeWorkflowEvents).values({
    id: id(),
    taskId,
    kind: input.kind,
    source: input.source,
    detail: input.detail,
    occurredAt: input.occurredAt ?? now(),
  });
  bus.publish({ type: "task.review", taskId });
}

export async function recordFreePreviewEventIfFree(
  taskId: string,
  input: RecordFreePreviewEventInput,
): Promise<boolean> {
  if (!(await isFreeTask(taskId))) return false;
  await recordFreePreviewEvent(taskId, input);
  return true;
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

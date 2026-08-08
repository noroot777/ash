import type {
  FreeWorkflowPreviewEventKind,
  FreeWorkflowPreviewEventSource,
} from "@harness/shared";
import { eq } from "drizzle-orm";
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
  const task = (await db.select({ workflowMode: tasks.workflowMode, mode: tasks.mode, parentId: tasks.parentId, reviewOf: tasks.reviewOf })
    .from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task || task.workflowMode !== "free" || task.mode !== "single" || task.parentId || task.reviewOf) return false;
  await recordFreePreviewEvent(taskId, input);
  return true;
}

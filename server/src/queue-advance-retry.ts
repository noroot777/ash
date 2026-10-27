import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, dbClient } from "./db/index.js";
import { groups, tasks } from "./db/schema.js";
import { id } from "./util.js";
import { freezeStartingTurn, stopTask } from "./runs.js";
import { writeGuardedTaskStatus } from "./status.js";

type Task = typeof tasks.$inferSelect;
export type QueueAdvanceRequest = NonNullable<Task["queueAdvanceRequest"]> & { taskId: string };
const deferred = new Map<string, ReturnType<typeof setTimeout>>();
const canceling = new Map<string, number>();

export const isQueueAdvanceCanceling = (taskId: string): boolean => canceling.has(taskId);

export async function cancelQueueAdvance(taskId: string): Promise<boolean> {
  canceling.set(taskId, (canceling.get(taskId) ?? 0) + 1);
  try {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    const request = task?.queueAdvanceRequest;
    if (!task || !request || request.resumePromptGeneration !== task.resumePromptGeneration
      || !["paused", "backlog", "queued", "running"].includes(task.status)) return false;
    freezeStartingTurn(taskId, "canceled");
    if (stopTask(taskId)) {
      await clearQueueAdvance({ ...request, taskId });
      return true;
    }
    return await writeGuardedTaskStatus(taskId, "canceled", and(
      sql`json_extract(${tasks.queueAdvanceRequest}, '$.id') = ${request.id}`,
      eq(tasks.resumePromptGeneration, request.resumePromptGeneration),
      inArray(tasks.status, ["paused", "backlog", "queued", "running"]),
    )!);
  } finally {
    const count = canceling.get(taskId)! - 1;
    if (count) canceling.set(taskId, count);
    else canceling.delete(taskId);
  }
}

export async function requestQueueAdvance(queueId: string, candidate: Task): Promise<QueueAdvanceRequest | null> {
  if (isQueueAdvanceCanceling(candidate.id)) return null;
  return db.transaction(async (transaction) => {
    const [task] = await transaction.select().from(tasks).where(eq(tasks.id, candidate.id));
    if (!task || task.archived || ["done", "failed", "canceled"].includes(task.status)
      || task.resumePromptGeneration !== candidate.resumePromptGeneration) return null;
    if (task.groupId) {
      const [group] = await transaction.select().from(groups).where(eq(groups.id, task.groupId));
      if (group?.paused) return null;
    }
    const previous = task.queueAdvanceRequest;
    const request = previous?.queueId === queueId && previous.resumePromptGeneration === task.resumePromptGeneration
      ? previous : { id: id(), queueId, resumePromptGeneration: task.resumePromptGeneration, prevStatus: candidate.status };
    if (isQueueAdvanceCanceling(task.id)) return null;
    await transaction.update(tasks).set({ queueAdvanceRequest: request }).where(eq(tasks.id, task.id));
    return { ...request, taskId: task.id };
  }, { behavior: "immediate" });
}

export async function clearQueueAdvance(request: QueueAdvanceRequest): Promise<void> {
  await db.update(tasks).set({ queueAdvanceRequest: null }).where(and(
    eq(tasks.id, request.taskId), sql`json_extract(${tasks.queueAdvanceRequest}, '$.id') = ${request.id}`,
  ));
}

export async function replayQueueAdvances(queueId?: string): Promise<void> {
  if (dbClient.closed) return;
  const pending = await db.select().from(tasks).where(isNotNull(tasks.queueAdvanceRequest));
  for (const task of pending) {
    const request = task.queueAdvanceRequest!;
    if (queueId && queueId !== request.queueId) continue;
    try {
      await (await import("./scheduler.js")).advanceQueue(request.queueId, { ...request, taskId: task.id });
    } catch (error) {
      console.error(`[ash] 续跑交接补推失败 queue=${request.queueId}:`, error);
      deferQueueAdvance(request.queueId);
    }
  }
}

export function deferQueueAdvance(queueId: string): void {
  if (dbClient.closed || deferred.has(queueId)) return;
  const timer = setTimeout(() => {
    deferred.delete(queueId);
    void replayQueueAdvances(queueId).catch((error) => {
      console.error(`[ash] 续跑交接请求读取失败 queue=${queueId}:`, error);
      deferQueueAdvance(queueId);
    });
  }, 1_000);
  timer.unref?.();
  deferred.set(queueId, timer);
}

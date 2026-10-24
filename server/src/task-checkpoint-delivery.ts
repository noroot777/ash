import { and, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { scheduledMessages, tasks } from "./db/schema.js";
import { restoreMonitorCheckpoint } from "./monitor-checkpoint-handoff.js";
import { recoverPendingDelivery } from "./pending-delivery-recovery.js";
import { CHECKPOINT_RUN_ORIGIN } from "./pending-checkpoint-recovery.js";
import { markSent } from "./pending-messages.js";
import {
  announceResumePrompt, resumePromptHeldBy, resumePromptTakePatch,
} from "./task-resume-prompt.js";
import { id, now } from "./util.js";

type Row = typeof scheduledMessages.$inferSelect;

export async function claimCheckpointForRun(taskId: string, expected: string): Promise<Row | null> {
  const receipt = await db.transaction(async (transaction) => {
    const task = (await transaction.select().from(tasks).where(and(
      eq(tasks.id, taskId), eq(tasks.resumePrompt, expected),
    ))).at(0);
    if (!task) return null;
    const taken = await transaction.update(tasks).set(resumePromptTakePatch()).where(and(
      eq(tasks.id, taskId), ...resumePromptHeldBy({
        text: expected, generation: task.resumePromptGeneration,
      }),
    )).returning({ id: tasks.id });
    if (!taken.length) return null;
    const stamp = now();
    const logged = await transaction.insert(scheduledMessages).values({
      id: id(), taskId, text: expected, mode: "queued", status: "canceled",
      origin: CHECKPOINT_RUN_ORIGIN, sendAt: stamp, createdAt: stamp, deliveringSince: stamp,
      checkpointTaken: expected, checkpointAuto: task.resumePromptAuto,
      checkpointGeneration: task.resumePromptGeneration,
    }).returning();
    return logged[0]!;
  });
  if (receipt) await announceResumePrompt(taskId);
  return receipt;
}

export async function acknowledgeCheckpointRun(receipt: Row): Promise<void> {
  await markSent(receipt);
}

export async function returnCheckpointRun(receipt: Row): Promise<void> {
  await recoverPendingDelivery(
    [receipt], new Map([[receipt.id, "检查点续跑尚未送达，续跑交代归还任务"]]),
    [{ restore: () => restoreMonitorCheckpoint(receipt) }], "检查点续跑尚未送达",
  );
}

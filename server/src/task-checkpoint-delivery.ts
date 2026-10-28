import { and, eq } from "drizzle-orm";
import { db, dbClient } from "./db/index.js";
import { scheduledMessages, tasks } from "./db/schema.js";
import { restoreMonitorCheckpoint } from "./monitor-checkpoint-handoff.js";
import { recoverPendingDelivery } from "./pending-delivery-recovery.js";
import {
  CHECKPOINT_RUN_ORIGIN, forgetCheckpointDelivering, noteCheckpointDelivering,
} from "./pending-checkpoint-recovery.js";
import { markSent } from "./pending-messages.js";
import {
  announceResumePrompt, resumePromptHeldBy, resumePromptTakePatch,
} from "./task-resume-prompt.js";
import { id, now } from "./util.js";

type Row = typeof scheduledMessages.$inferSelect;

export async function claimCheckpointForRun(taskId: string, expected: string, generation?: number): Promise<Row | null> {
  const receipt = await db.transaction(async (transaction) => {
    const task = (await transaction.select().from(tasks).where(and(
      eq(tasks.id, taskId), eq(tasks.resumePrompt, expected),
      generation === undefined ? undefined : eq(tasks.resumePromptGeneration, generation),
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
  if (receipt) {
    // 登记「本进程有一条路正在送它」—— 在途租约能不能被别人接管,第一道闸就是这张登记
    // (判据写在 pending-checkpoint-recovery.ts 的 deliveringNow 上)。登记放在落库成功
    // **之后**:没拿到凭证就没有在途投递。
    noteCheckpointDelivering(receipt.id);
    await announceResumePrompt(taskId);
  }
  return receipt;
}

/**
 * 送达之后的那一笔确认。
 *
 * **绝不抛、也绝不归还**:走到这里 = 那段话已经喂给 agent 了(orchestrator 在 spawn、落会话
 * 行、原文落盘之后才回调)。这一笔只是记账,写不成就**原地补办** —— 归还等于把已经在执行的
 * 输入重新变成待执行输入,下一次启动再送一遍(第 1 轮审查必须修 3 明确点了这条约束)。
 *
 * 补办期间租约**留着**:它是「有一次投递在途」的唯一凭据,清掉就会被 recoverPendingCheckpoints
 * 当成「没送出去」回填给任务。这段时间启动被拒,拒绝理由由 pendingCheckpointBlockReason 按
 * 「已送达、正在补记」那一档说;进程要是在补办中被换掉,开机那一拍的 reconcileCheckpointDeliveries
 * 会按同一个判据接管下去。
 */
export async function acknowledgeCheckpointRun(receipt: Row, attempts = 0): Promise<void> {
  try {
    await markSent(receipt);
    forgetCheckpointDelivering(receipt.id);
    if (attempts) console.log(`[ash] 续跑交代确认已补记 task=${receipt.taskId} message=${receipt.id}（第 ${attempts + 1} 次尝试）`);
  } catch (error) {
    if (dbClient.closed) return;
    const delay = Math.min(200 * 2 ** Math.min(attempts, 8), 30_000);
    console.warn(`[ash] 续跑交代确认写入失败 task=${receipt.taskId} message=${receipt.id}`
      + `（原文已送达，${delay}ms 后补记第 ${attempts + 2} 次）:`, error);
    const timer = setTimeout(() => void acknowledgeCheckpointRun(receipt, attempts + 1), delay);
    timer.unref?.();
  }
}

export async function returnCheckpointRun(receipt: Row): Promise<void> {
  forgetCheckpointDelivering(receipt.id);
  await recoverPendingDelivery(
    [receipt], new Map([[receipt.id, "检查点续跑尚未送达，续跑交代归还任务"]]),
    [{ restore: () => restoreMonitorCheckpoint(receipt) }], "检查点续跑尚未送达",
  );
}

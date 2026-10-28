import { and, eq } from "drizzle-orm";
import { db, dbClient } from "./db/index.js";
import { scheduledMessages, tasks } from "./db/schema.js";
import { restoreMonitorCheckpoint } from "./monitor-checkpoint-handoff.js";
import { recoverPendingDelivery } from "./pending-delivery-recovery.js";
import {
  CHECKPOINT_RUN_ORIGIN, checkpointDeliveryVerdict, forgetCheckpointDelivering, noteCheckpointDelivering,
} from "./pending-checkpoint-recovery.js";
import { forgetDeliveryCrossing } from "./delivery-crossing.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { freshRunFailureTarget } from "./turn-failure.js";
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
    forgetDeliveryCrossing(receipt.taskId, [receipt.id]);
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

/**
 * 归还。**只走「证明了还没越线」那一档** —— 判定在 `settleStrandedCheckpointRun`,别从别处直接
 * 调它:交付不明的那一档归还一次就是重放一次(第 1 轮审查 F1)。
 */
export async function returnCheckpointRun(receipt: Row): Promise<void> {
  forgetCheckpointDelivering(receipt.id);
  forgetDeliveryCrossing(receipt.taskId, [receipt.id]);
  await recoverPendingDelivery(
    [receipt], new Map([[receipt.id, "检查点续跑尚未送达，续跑交代归还任务"]]),
    [{ restore: () => restoreMonitorCheckpoint(receipt) }], "检查点续跑尚未送达",
  );
}

/**
 * **交付不明**的那一档:原文已经交给 agent 进程了,但这一轮的记账没做完,系统分不清它到底
 * 执行了没有。
 *
 * 两件事都不能做:
 *  · **不归还、不重投** —— 可能已经执行过,再送一遍就是同一段交代执行两遍(F1 实测的那个后果);
 *  · **不永久挂着** —— 租约留着就等于这个任务此后一律起不来,而补记的退避重试活在已经死掉的
 *    那个进程里,新进程没有任何人在推它(D5 的「不永久阻塞」)。
 *
 * 所以就地了结:标 sent(凭证从此不再参与投递与准入),同时留下一条**带原文**的可见交代 ——
 * 「保留可见的交付不明状态等待裁定」。要不要再送一遍是用户的判断,不是系统的猜测;原文在
 * 时间线上,他复制一遍就能再送。
 *
 * `eventKey` 按消息 id 定死:对账在开机那一拍和每次启动前都会跑,这条交代只该出现一次。
 */
export async function settleUncertainCheckpointRun(receipt: Row): Promise<void> {
  const text = receipt.checkpointTaken ?? receipt.text;
  const note = "〔系统〕这一轮的续跑交代已经交给 agent 进程，但「已送达」那一笔没来得及记下"
    + "（进程在交出输入和落账之间被换掉了）。系统分不清它到底执行了没有，所以**不会自动再送"
    + "一遍** —— 同一段交代执行两遍的代价比晚一点更大。原文留在下面，要不要再送由你决定：\n\n"
    + `> ${text.split("\n").join("\n> ")}`;
  const target = { eventKey: `checkpoint-uncertain:${receipt.id}` };
  // 原文**必须落到用户看得见的地方**,这是这一档的全部出路。一条会话都没有(交代是在任务
  // 从没跑过时被写上去的)就先开一行诊断会话再写 —— 否则 markSent 之后这段话就真没了。
  if (!await appendTaskTimeline(receipt.taskId, note, target)) {
    const task = (await db.select().from(tasks).where(eq(tasks.id, receipt.taskId))).at(0);
    if (task) {
      await appendTaskTimeline(receipt.taskId, note,
        { ...await freshRunFailureTarget(task, null), ...target });
    } else {
      console.error(`[ash] 续跑交代交付不明、又无处落账 task=${receipt.taskId}，原文:`, text);
    }
  }
  await markSent(receipt);
  forgetCheckpointDelivering(receipt.id);
  forgetDeliveryCrossing(receipt.taskId, [receipt.id]);
  console.warn(`[ash] 续跑交代交付不明 task=${receipt.taskId} message=${receipt.id}：`
    + "越过 spawn 但没落下会话行，已就地结成可见记录，不自动重投");
}

/**
 * 一张**带着在途租约、却没人在送**的凭证该怎么收场 —— 三态判定与三条出路收在这一个函数里。
 *
 * 所有入口都必须经过它:进程内的 `finally`(task-resume.ts)、开机那一拍与每次启动前的对账
 * (pending-checkpoint-recovery.ts)。早先各处自己写「送到了吗」的布尔判断,于是同一条缝在
 * 四个地方各错一遍(第 1 轮审查 F1 点名的同类入口)。
 */
export async function settleStrandedCheckpointRun(receipt: Row, why: string): Promise<void> {
  const verdict = await checkpointDeliveryVerdict(receipt);
  const head = `[ash] ${why} task=${receipt.taskId} message=${receipt.id}：`;
  if (verdict === "delivered") {
    console.warn(`${head}原文已送达（租约之后有回合开起来过），补记这一笔确认`);
    await acknowledgeCheckpointRun(receipt);
    return;
  }
  if (verdict === "uncertain") {
    console.warn(`${head}原文已越过 spawn、这一轮却没落下会话行 —— 交付不明，就地结成可见记录`);
    await settleUncertainCheckpointRun(receipt);
    return;
  }
  console.warn(`${head}越线记号与回合行都没有（证明没送出去），归还给任务`);
  await returnCheckpointRun(receipt);
}

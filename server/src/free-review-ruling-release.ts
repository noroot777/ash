// 裁定落地后，把被裁定闸扣住的那条预约**当场兑现**。
//
// 预约的语义是「执行回合正常结束时开审」。执行者驳回 / 提出转出的那个回合本身就是一个
// 正常结束的执行回合：没有驳回的话，预约在它结算时就开审了，只是被裁定闸
// （startReservedFreeReview）按住，等用户拍板。所以闸一放开，该触发的那一刻其实早就过去了。
//
// 原先的做法是「裁定后等下一个执行回合正常结束再开」——可「这一轮不用改了」「转独立任务」
// 这两档本身都不起执行回合，用户拍完板任务就停着：预约亮着、审查不来，派审按钮又因为槽里
// 挂着预约只剩「调整预约」，执行者在驳回前改掉的那几条（`disputeOption` 要求先改完成立的
// 再驳剩下的）一轮都审不上（用户 2026-11-10，任务 yosdiYlV_dD8）。
//
// 「让它接着改」那一档不走这里：它会起一个修复回合，预约本来就该等那一轮修完再审。
//
// **兑现的依据是持久的「触发时刻到过」这件事本身**（槽上的 `reviewHeldToken`，由裁定闸在
// 正常结算时记下），不是任务状态：执行者正常结束却没确认完成、和中途报错退出，落下的都是
// failed，单看状态会把后者也补成一次触发，审查一份还没收尾的代码（第 1 轮审查实测）。
// 异常结束的回合根本走不到闸上，记不下这件事，于是预约照旧等下一个正常结束的回合；之后
// 再起任何执行回合、或者维持意见，都会把它作废（作废点见 forgetHeldTrigger）。
//
// 有这件事也只在「此刻确实没有执行回合会来」时兑现，判据与回合结算消费预约的那一段同口径
// （free-workflow.ts `handleFreeWorkflowSettlement`）：等答复 / 停在检查点、托盘里还有
// 消息、回合正在跑，都照旧留给那一轮结束时处理，并说清在等什么。回合锁被占着时不能当作
// 「之后还有一次结算」，登记到放锁后重判（见 retryAfterTurn）。
import { and, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeWorkflowStates, tasks } from "./db/schema.js";
import {
  heldByRuling,
  noteReservationStillWaiting,
  readFreeReviewReservation,
  reservationWaitReason,
} from "./free-review-reservations.js";
import { reviewingRun } from "./free-review-round.js";
import { handoffBlockReason } from "./handoff-guard.js";
import { claimOwnTurn, releaseTurn, whenTurnIdle } from "./runs.js";
import { appendTaskTimeline } from "./task-timeline.js";

const AFTER_CURRENT_TURN = "当前执行回合正常结束后开始";

/** 已经登记了「回合放锁后再判一次」的任务：同一轮锁上只挂一个，别每次裁定 / 重试各挂一份。 */
const retryPending = new Set<string>();

/**
 * `retry` = 回合放锁之后的那次重判：不再往时间线里写「仍在等待」——第一次已经说过了，而
 * 重判落空时多半是那一轮自己的结算已经交代过结局（正常结束会自己消费预约，异常结束会写明）。
 */
export async function releaseReservationAfterRuling(taskId: string, opts: { retry?: boolean } = {}): Promise<void> {
  const note = opts.retry
    ? async () => false
    : (reason: string, resumes?: string) => noteReservationStillWaiting(taskId, reason, resumes);
  if (!(await readFreeReviewReservation(taskId))?.armed) return;
  // **先占回合，再在锁里读全部判据**：资格只会在执行回合开跑时作废（forgetHeldTrigger ①），
  // 占住回合就没有执行回合能在「判完 → 开审」之间开跑；锁外读到的判据到消费那一刻可能已经
  // 不成立（第 2 轮审查）。消费那一侧（trigger=ruling）每次实际消费前还会重验资格，CAS 也
  // 比对资格列，几道互为兜底。
  const turn = claimOwnTurn(taskId, "dispatch");
  if (!turn) {
    // 占不到 ≠ 之后还会有一次结算：占着锁的可能正是已经结算完、只差放锁的那一轮，它的消费点
    // 早过了（第 2 轮审查实测：只写一句「等当前回合结束」，放锁后什么都不会发生）。登记到
    // 它放锁之后再判一次；若接着开跑的是新的执行回合，它会作废资格，预约交给它自己的结算。
    retryAfterTurn(taskId);
    await note("任务此刻有回合在进行", AFTER_CURRENT_TURN);
    return;
  }
  try {
    const reservation = await readFreeReviewReservation(taskId);
    if (!reservation?.armed) return;
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task) return;
    if (task.question || task.resumePrompt) {
      await note(await reservationWaitReason(task));
      return;
    }
    // running/queued 由那一轮自己结算时消费。
    if (task.status === "running" || task.status === "queued") {
      await note("任务此刻有回合在进行", AFTER_CURRENT_TURN);
      return;
    }
    if (!heldByRuling(reservation)) {
      await note("上一个执行回合没有正常结束");
      return;
    }
    const { hasDeliverablePendingMessages } = await import("./pending-messages.js");
    if (await hasDeliverablePendingMessages(taskId)) {
      await note("还有排队消息没送进会话，先把它们发完");
      return;
    }
    if (await reviewingRun(taskId)) return;
    const { launchReservedFreeReview } = await import("./free-workflow.js");
    await launchReservedFreeReview(task, reservation, () =>
      appendTaskTimeline(taskId, "裁定之后没有要等的执行回合，按预约开始审查。"), "ruling");
  } finally {
    releaseTurn(taskId, turn);
  }
}

function retryAfterTurn(taskId: string): void {
  if (retryPending.has(taskId)) return;
  retryPending.add(taskId);
  whenTurnIdle(taskId, () => {
    retryPending.delete(taskId);
    void releaseReservationAfterRuling(taskId, { retry: true })
      .catch((error) => console.error(`[ash] 回合放锁后兑现预约审查失败 task=${taskId}:`, error));
  });
}

/**
 * 启动补发：裁定已经落账、而当场兑现没来得及做完（进程死在两者之间）的那几条预约。
 *
 * 裁定是一笔 CAS、兑现是之后的另一段，中间断开时库里留下的正是「驳回已裁定 + 触发时刻到过 +
 * 槽还挂着」——重提同一个裁定会被「已经裁定过了」拒掉，没有别的入口会再碰它。这三件事都是
 * 持久的，所以启动时照同一个判据再走一遍兑现即可。
 *
 * 只挑此刻真能开审的：驳回还在等裁定的照旧等；任务在跑或在等待的，交给那一轮自己结算，
 * 这里不重复往时间线里写「仍在等待」（每次重启都写一遍只是噪音）。
 */
export async function releaseHeldReservations(): Promise<void> {
  const rows = await db.select({ taskId: freeWorkflowStates.taskId }).from(freeWorkflowStates)
    .where(and(eq(freeWorkflowStates.reviewArmed, true), eq(freeWorkflowStates.reviewHeldToken, freeWorkflowStates.updatedAt)));
  if (!rows.length) return;
  const { openDisputeOf } = await import("./free-review-dispute.js");
  for (const { taskId } of rows) {
    try {
      const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
      if (!task || task.archived || task.workflowMode !== "free" || handoffBlockReason(task.handoff)) continue;
      if (task.status === "running" || task.status === "queued" || task.question || task.resumePrompt) continue;
      if (await openDisputeOf(taskId)) continue;
      await releaseReservationAfterRuling(taskId);
    } catch (error) {
      console.error(`[ash] 启动补发裁定后的预约审查失败 task=${taskId}:`, error);
    }
  }
}

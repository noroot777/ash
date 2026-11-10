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
// 只在「此刻确实没有执行回合会来」时兑现，判据与回合结算消费预约的那一段同口径
// （free-workflow.ts `handleFreeWorkflowSettlement`）：等答复 / 停在检查点、托盘里还有
// 消息、回合正在跑，都照旧留给那一轮结束时处理，并说清在等什么。
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import {
  noteReservationStillWaiting,
  readFreeReviewReservation,
  reservationWaitReason,
} from "./free-review-reservations.js";
import { reviewingRun } from "./free-review-round.js";
import { claimOwnTurn, releaseTurn } from "./runs.js";
import { appendTaskTimeline } from "./task-timeline.js";

const AFTER_CURRENT_TURN = "当前执行回合正常结束后开始";

export async function releaseReservationAfterRuling(taskId: string): Promise<void> {
  const reservation = await readFreeReviewReservation(taskId);
  if (!reservation?.armed) return;
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return;
  if (task.question || task.resumePrompt) {
    await noteReservationStillWaiting(taskId, await reservationWaitReason(task));
    return;
  }
  // running/queued 由那一轮自己结算时消费。
  if (task.status === "running" || task.status === "queued") {
    await noteReservationStillWaiting(taskId, "任务此刻有回合在进行", AFTER_CURRENT_TURN);
    return;
  }
  // 只认「上一个执行回合已经收尾」的两种终态。canceled 是用户亲手停的，代码可能改到一半，
  // 照旧等下一个正常结束的回合。
  if (task.status !== "done" && task.status !== "failed") {
    await noteReservationStillWaiting(taskId, "上一个执行回合没有正常结束");
    return;
  }
  const { hasDeliverablePendingMessages } = await import("./pending-messages.js");
  if (await hasDeliverablePendingMessages(taskId)) {
    await noteReservationStillWaiting(taskId, "还有排队消息没送进会话，先把它们发完");
    return;
  }
  // 占住回合再开审：从这里到审查链切进 reviewing 之间，用户的一条消息就能起一个执行回合，
  // 两边同时动工作区。占不到 = 已经有回合在飞，预约留给它结束时消费。
  const turn = claimOwnTurn(taskId, "dispatch");
  if (!turn) {
    await noteReservationStillWaiting(taskId, "任务此刻有回合在进行", AFTER_CURRENT_TURN);
    return;
  }
  try {
    if (await reviewingRun(taskId)) return;
    const { launchReservedFreeReview } = await import("./free-workflow.js");
    await launchReservedFreeReview(task, reservation, () =>
      appendTaskTimeline(taskId, "裁定之后没有要等的执行回合，按预约开始审查。"));
  } finally {
    releaseTurn(taskId, turn);
  }
}

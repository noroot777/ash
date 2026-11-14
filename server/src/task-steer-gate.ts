// 「引导会话」此刻能不能成 —— 不碰任何状态的那几条前置条件。`steerQueuedMessage`(task-steer.ts)
// 按它拒,排队消息接口(pending-wait.ts)按它决定托盘上出不出那颗键:两边一份判据,托盘才不会
// 给出一颗点了必然 409 的键(任务早停了,托盘还亮着「引导会话」,点下去是「当前回合已经结束」)。
//
// 判据外只剩撞车那一类:原生引导正在启动、回合恰好在提交前结束、租约被别的投递抢走 —— 那些
// 只有真去做才知道,照旧由 steerQueuedMessage 当场拒并说明。
import type { scheduledMessages, tasks } from "./db/schema.js";
import { isCanceling, turnRole } from "./runs.js";
import { isAcceptingTask } from "./acceptance-lock.js";
import { isUserAuthoredMessage } from "@ash/shared/scheduled-message-author";

type MessageRow = typeof scheduledMessages.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

export type SteerRefusal = {
  status: 404 | 409;
  error: string;
  /** 这一条拒绝要记进任务时间线(停止/暂停与引导撞上,用户事后要看得到)。 */
  record?: true;
};

function sideTurnReason(task: TaskRow): string | null {
  if (task.verifyRound != null) return "当前正在进行验证回合，消息继续排队";
  if (task.reviewOf) return "当前是审查任务回合，消息继续排队";
  if (task.nativeTurn) return "当前正在执行 CLI 命令，消息继续排队";
  const role = turnRole(task.id);
  if (role && role !== "single") return "当前是审查或系统旁路回合，消息继续排队";
  return null;
}

/**
 * `firstUserQueuedId` = 这个任务上排得最早的那条用户自己写的 queued 消息(排序同托盘:
 * sendAt、createdAt、id)。由调用方查好传进来:路由查一次,托盘那边整张表手上就有。
 */
export function steerRefusal(message: MessageRow, task: TaskRow | null, firstUserQueuedId: string | undefined): SteerRefusal | null {
  if (message.status !== "pending" || message.mode !== "queued") {
    return { status: 409, error: "只有仍在排队的消息可以引导会话" };
  }
  if (!task) return { status: 404, error: "任务不存在" };
  if (task.mode !== "single") return { status: 409, error: "只有单飞任务支持引导会话" };
  if (task.archived) return { status: 409, error: "任务已归档，消息继续保留在排队中" };
  if (task.status !== "running" && task.status !== "queued") {
    return { status: 409, error: "当前回合已经结束，消息会按排队顺序自动发送" };
  }
  const blocked = sideTurnReason(task);
  if (blocked) return { status: 409, error: blocked };
  if (isCanceling(task.id)) return { status: 409, error: "任务正在停止或所在分组正在暂停，消息继续排队", record: true };
  if (isAcceptingTask(task.id)) return { status: 409, error: "任务正在验收，引导未执行，消息继续排队" };
  // 队首只在用户自己写的消息里排：排在前面的哨兵唤醒、审查交接不拦用户插话，它们等引导
  // 出来的那一轮结束后照常投递；用户自己的几句话之间仍不许反序。
  if (!isUserAuthoredMessage(message)) {
    return { status: 409, error: "只有你自己发的消息可以引导会话，这条会按排队顺序自动发送" };
  }
  if (firstUserQueuedId !== message.id) return { status: 409, error: "只能按排队顺序引导你最早的一条消息" };
  if (message.deliveringSince) return { status: 409, error: "消息正在投递或已被处理，请稍后查看" };
  return null;
}

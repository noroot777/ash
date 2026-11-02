import { and, eq, isNull, sql } from "drizzle-orm";
import type { TaskStatus } from "@ash/shared";
import { tasks } from "./db/schema.js";
import { SEAT_ROLLBACK_ROLE, isTurnClaimed, turnRole } from "./runs.js";
import { writeGuardedTaskStatus } from "./status.js";
import { id } from "./util.js";

export type TaskQueueReservation = {
  taskId: string;
  prevStatus: TaskStatus;
  token: string | null;
  epoch: number;
  advanceRequest?: { id: string; resumePromptGeneration: number };
};

export function taskQueueReservation(task: typeof tasks.$inferSelect,
  advanceRequest?: TaskQueueReservation["advanceRequest"]): TaskQueueReservation {
  return { taskId: task.id, prevStatus: task.status as TaskStatus, token: id(), epoch: task.directionEpoch, advanceRequest };
}

export async function reserveQueuedTask(reservation: TaskQueueReservation): Promise<void> {
  const claimed = await writeGuardedTaskStatus(reservation.taskId, "queued", and(
    eq(tasks.status, reservation.prevStatus), eq(tasks.directionEpoch, reservation.epoch),
    reservation.advanceRequest && sql`json_extract(${tasks.queueAdvanceRequest}, '$.id') = ${reservation.advanceRequest.id}`,
    reservation.advanceRequest && eq(tasks.resumePromptGeneration, reservation.advanceRequest.resumePromptGeneration),
  )!, reservation.token);
  if (!claimed) throw new Error("任务状态已改变，本次启动占位已撤销");
}

export async function restoreQueuedTask(reservation: TaskQueueReservation): Promise<boolean> {
  // 回合锁被**别人**占着 = 有人正拿着这个占位真正起跑,它的结算会覆盖状态,这里不动。
  //
  // `SEAT_ROLLBACK_ROLE` 是例外,而且必须是例外:回滚方自己就要占着这把锁提交,好把
  // 「SELECT 归属 → UPDATE 状态」那段窗口关掉(理由写在 turn-lock.ts 那个常量上)。把
  // 自己占的锁读成「有人在跑」,这一笔就永远提交不了,遗留永久停在「排队中」。
  if (isTurnClaimed(reservation.taskId) && turnRole(reservation.taskId) !== SEAT_ROLLBACK_ROLE) return false;
  return writeGuardedTaskStatus(reservation.taskId, reservation.prevStatus, and(
    eq(tasks.status, "queued"), eq(tasks.directionEpoch, reservation.epoch),
    reservation.token === null ? isNull(tasks.queueSeatToken) : eq(tasks.queueSeatToken, reservation.token),
  )!);
}

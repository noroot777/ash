import { and, eq, isNull } from "drizzle-orm";
import type { TaskStatus } from "@ash/shared";
import { tasks } from "./db/schema.js";
import { isTurnClaimed } from "./runs.js";
import { writeGuardedTaskStatus } from "./status.js";
import { id } from "./util.js";

export type TaskQueueReservation = {
  taskId: string;
  prevStatus: TaskStatus;
  token: string | null;
  epoch: number;
};

export function taskQueueReservation(task: typeof tasks.$inferSelect): TaskQueueReservation {
  return { taskId: task.id, prevStatus: task.status as TaskStatus, token: id(), epoch: task.directionEpoch };
}

export async function reserveQueuedTask(reservation: TaskQueueReservation): Promise<void> {
  const claimed = await writeGuardedTaskStatus(reservation.taskId, "queued", and(
    eq(tasks.status, reservation.prevStatus), eq(tasks.directionEpoch, reservation.epoch),
  )!, reservation.token);
  if (!claimed) throw new Error("任务状态已改变，本次启动占位已撤销");
}

export async function restoreQueuedTask(reservation: TaskQueueReservation): Promise<boolean> {
  if (isTurnClaimed(reservation.taskId)) return false;
  return writeGuardedTaskStatus(reservation.taskId, reservation.prevStatus, and(
    eq(tasks.status, "queued"), eq(tasks.directionEpoch, reservation.epoch),
    reservation.token === null ? isNull(tasks.queueSeatToken) : eq(tasks.queueSeatToken, reservation.token),
  )!);
}

// 「这次队列推进开始之后，有没有人按过停」。
//
// 队列推进从挑人到真正拉起隔着好几段 await，挑人那一刻读到的「没停」可能已经过期。每按一次停
// （分组暂停、名下全部停下）领一个新代次，记在被停的那几样上；推进开始时记下当时的代次，挑出来
// 的候选身上的代次比它新 = 这一趟开始之后被停过，这一趟作废（scheduler.ts advanceQueueAttempt）。
// 只在内存里：它补的是同一个进程里的交错窗口，持久事实（groups.paused、tasks.dispatch_hold_at）
// 另有各处的闸在读。
let generation = 0;
const groupPauses = new Map<string, number>();
// 任务那一份还记着是谁按的（名下全部停下才有）：推进因它作废时，要把这次起跑交给那一条的欠账（scheduler.ts）。
const taskPauses = new Map<string, { at: number; by: string | null }>();

export const currentPauseGeneration = (): number => generation;

export function notePauseOfGroup(groupId: string): void {
  groupPauses.set(groupId, ++generation);
}

export function notePauseOfTasks(taskIds: readonly string[], by: string | null = null): void {
  const at = ++generation;
  for (const taskId of taskIds) taskPauses.set(taskId, { at, by });
}

/** 这一位（按任务本身、或按它所在的分组）在 `since` 那一代之后被停过吗。 */
export function pausedSince(task: { id: string; groupId: string | null }, since: number): boolean {
  if (task.groupId && (groupPauses.get(task.groupId) ?? 0) > since) return true;
  return (taskPauses.get(task.id)?.at ?? 0) > since;
}

/** `since` 那一代之后，按停这一位的是哪条派活的任务（不是被名下全部停下停的就是 null）。 */
export function dispatchPauseSince(taskId: string, since: number): string | null {
  const pause = taskPauses.get(taskId);
  return pause && pause.at > since ? pause.by : null;
}

/** 任务删了就不再记（task-delete-routes.ts）。 */
export function forgetTaskPause(taskId: string): void {
  taskPauses.delete(taskId);
}

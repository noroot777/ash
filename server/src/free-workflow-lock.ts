const lockedTaskIds = new Set<string>();

export function tryAcquireFreeWorkflowAction(taskId: string): boolean {
  if (lockedTaskIds.has(taskId)) return false;
  lockedTaskIds.add(taskId);
  return true;
}

export function releaseFreeWorkflowAction(taskId: string): void {
  lockedTaskIds.delete(taskId);
}

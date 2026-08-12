// 任务级验收互斥的**独立小模块**：orchestrator（reply/run 的 reopen 路径）、DELETE 路由、
// 归档路由和 task-accept 自己都要读它——放在 task-accept 里会造成 import 环。
// 覆盖范围包括验收尾段（发布/命令步骤）：尾段期间删除任务、续聊摘牌、再次验收、归档，
// 都会与仍在执行的外部副作用竞争同一工作区（审查实测复现过删除与摘牌两种穿透）。
const acceptingTaskIds = new Set<string>();

export function beginAccepting(taskId: string): boolean {
  if (acceptingTaskIds.has(taskId)) return false;
  acceptingTaskIds.add(taskId);
  return true;
}

export function endAccepting(taskId: string): void {
  acceptingTaskIds.delete(taskId);
}

/** 验收（含尾段）是否正在进行。 */
export function isAcceptingTask(taskId: string): boolean {
  return acceptingTaskIds.has(taskId);
}

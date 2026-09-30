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
  if (!acceptingTaskIds.delete(taskId)) return;
  // 验收期间被挡回的排队消息现在可以送了。投递那边只有「有界重试 + 30 秒兜底扫描」,
  // 一次验收(尤其带发布/命令的尾段)轻易就超过重试窗口,消息于是要多躺一整个 tick
  // 才被捡走 —— 而这一刻我们**确知**挡回的原因没了,直接推一把最省事。
  // 动态 import:pending-messages 那条链路会回头读任务/回合状态,静态引会绕回来成环。
  void import("./pending-messages.js")
    .then(({ flushPendingForTask }) => flushPendingForTask(taskId))
    .catch((error) => console.error(`[ash] 验收结束后补送排队消息失败 task=${taskId}:`, error));
}

/** 验收（含尾段）是否正在进行。 */
export function isAcceptingTask(taskId: string): boolean {
  return acceptingTaskIds.has(taskId);
}

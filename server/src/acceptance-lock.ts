// 任务级验收互斥的**独立小模块**：orchestrator（reply/run 的 reopen 路径）、DELETE 路由、
// 归档路由和 task-accept 自己都要读它——放在 task-accept 里会造成 import 环。
// 覆盖范围包括验收尾段（发布/命令步骤）：尾段期间删除任务、续聊摘牌、再次验收、归档，
// 都会与仍在执行的外部副作用竞争同一工作区（审查实测复现过删除与摘牌两种穿透）。
//
// 往团队里加成员（建执行者、派活）也挂在这里：团队验收占住的是开始那一刻的那一批（team-acceptance-hold.ts），
// 验收期间成员一多，多出来的那位不在占位里、照样起跑、改共享目录（审查实测：团队验收落章时新执行者正在跑）。
// 所以加成员占一个位，跟验收互斥：加着的时候验收开不了，验收着的时候加不进来。加成员之间可以并发，按计数记。
const acceptingTaskIds = new Set<string>();
const admitting = new Map<string, number>();

export function beginAccepting(taskId: string): boolean {
  if (acceptingTaskIds.has(taskId) || admitting.has(taskId)) return false;
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

/**
 * 开始往这个任务名下加成员。它正在验收（或在更新工作区、基线，同一把互斥）就返回 null；否则返回释放函数（可重复调用），
 * 新任务落库之后调。
 */
export function beginAdmitting(taskId: string): (() => void) | null {
  if (acceptingTaskIds.has(taskId)) return null;
  admitting.set(taskId, (admitting.get(taskId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (admitting.get(taskId) ?? 1) - 1;
    if (left > 0) admitting.set(taskId, left);
    else admitting.delete(taskId);
  };
}

/**
 * 有成员正在往这个任务名下加（建执行者 / 审查、派活）。处置整条任务（删除、归档）也要等它落完：不然新来的那位落在
 * 已经删掉 / 归档了的团队名下（对抗复核实测：派活原来整趟占着 beginAccepting，顺带挡住了这两样，换成这个位之后没挡）。
 */
export function isAdmitting(taskId: string): boolean {
  return admitting.has(taskId);
}

/** beginAccepting 没占到时对人怎么说：是有成员正在加进来，就说这个（几百毫秒的事），否则用调用方那一句。 */
export function acceptingBusyText(taskId: string, otherwise: string): string {
  return admitting.has(taskId) ? "团队正在加入新的执行者，稍后再试" : otherwise;
}

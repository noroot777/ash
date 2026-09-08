// 一个自由工作流任务同时只做一件事（派审、修复、开预览、验收…）。
//
// 锁**可以被持有者之外的人提前放掉**：起预览那一路是同步等到就绪才返回的，最长八分钟，
// 而用户点了取消之后那把锁再攥着就纯属误伤 —— 验收、派审会被一个已经作废的启动挡满
// 八分钟（取消那一路没法打断正卡在建 worktree 上的那次调用）。所以放锁时可以带一张
// 号码牌：**只放自己那一次**。不带号码牌地删，删掉的可能是后来者的锁。
const holders = new Map<string, number>();
let seq = 0;

/** 拿锁。返回 false = 这个任务上已经有别的操作在跑。 */
export function tryAcquireFreeWorkflowAction(taskId: string): boolean {
  return acquireFreeWorkflowAction(taskId) !== null;
}

/** 拿锁并要一张号码牌 —— 需要「只放自己那一次」的调用方用它。 */
export function acquireFreeWorkflowAction(taskId: string): number | null {
  if (holders.has(taskId)) return null;
  seq += 1;
  holders.set(taskId, seq);
  return seq;
}

/** 放锁。给了号码牌就只放自己那一次（见文件头）；不给就是无条件放。 */
export function releaseFreeWorkflowAction(taskId: string, holder?: number): void {
  if (holder !== undefined && holders.get(taskId) !== holder) return;
  holders.delete(taskId);
}

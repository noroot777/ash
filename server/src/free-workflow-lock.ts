// 一个自由工作流任务同时只做一件事（派审、修复、开预览、验收…）。
//
// 锁**可以被持有者之外的人提前放掉**：起预览那一路是同步等到就绪才返回的，最长八分钟，
// 而用户点了取消之后那把锁再攥着就纯属误伤 —— 验收、派审会被一个已经作废的启动挡满
// 八分钟（取消那一路没法打断正卡在建 worktree 上的那次调用）。所以放锁时可以带一张
// 号码牌：**只放自己那一次**。不带号码牌地删，删掉的可能是后来者的锁。
//
// 提前放锁带来的第二个问题在这里一并收口：**任务正在切进 running 的那一段谁也别想拿到
// 锁**。重跑回收会取消在途的预览、顺手把锁放了，而那时 `status` 还没落库 —— 空出来的锁
// 加上一行过期的 `done`，正好够验收挤进来，把一个下一秒就要开跑的任务点成 accepted
// （accepted + running：界面按已验收锁死操作，执行器却还在改它）。门本身在 rerun-gate.ts。
import { rerunGateClosed } from "./rerun-gate.js";

const holders = new Map<string, number>();
let seq = 0;

/** 拿锁。返回 false = 这个任务上已经有别的操作在跑，或者它正在切进 running。 */
export function tryAcquireFreeWorkflowAction(taskId: string): boolean {
  return acquireFreeWorkflowAction(taskId) !== null;
}

/** 拿锁并要一张号码牌 —— 需要「只放自己那一次」的调用方用它。 */
export function acquireFreeWorkflowAction(taskId: string): number | null {
  if (rerunGateClosed(taskId)) return null;
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

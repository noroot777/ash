// 分组的并发名额:同一组里由系统拉起的成员 —— 分组运行(runParallel)、「接着跑」兑现欠账
// (dispatch-hold.ts) —— 跟等齐就起(prerequisite-launch.ts)共用 launch-slots.ts 那**一份**计数,
// 合起来同时至多 MAX_PARALLEL 个在跑。名额等整轮跑完才还,同 runParallel。
// 早先限流只活在 runParallel 那一趟的局部变量里:组里六条被按住、记成欠账,接着跑逐条直起,
// 六条同时开跑(第 1 轮复审 F3);两份计数各数各的,叠起来就是两倍(合入前置那一版时并成一份)。
//
// 这里只是「满了就排着等」的那层:占和还都落在 launch-slots.ts。那边的占是同步的(查和占之间没有
// await),叫醒的人自己再去抢,所以不会出现「先减、再叫醒」中间计数归零、建出第二份计数的缝
// (第 2 轮复审 F2)。名额按任务认:同一条已经被另一路占着(正由那一路起跑)就等它还。
import { slotsTaken, takeSlot, freeSlot, whenSlotFrees } from "./launch-slots.js";

export const MAX_PARALLEL = 4;

const waiting = new Map<string, number>();

/** 占一个名额（满了就排着等）。成员起跑别直接用它，走 member-start.ts startMember：那里有轮到之后的重新准入。 */
export async function acquireGroupSlot(groupId: string, taskId: string): Promise<void> {
  while (!takeSlot(groupId, taskId)) {
    waiting.set(groupId, (waiting.get(groupId) ?? 0) + 1);
    try {
      await whenSlotFrees();
    } finally {
      const left = (waiting.get(groupId) ?? 1) - 1;
      if (left) waiting.set(groupId, left);
      else waiting.delete(groupId);
    }
  }
}

export function releaseGroupSlot(groupId: string, taskId: string): void {
  freeSlot(groupId, taskId);
}

/** 只给回归测试看这份计数本身(组里此刻占着 + 等着的)。 */
export function groupSlotUsage(groupId: string): { used: number; waiting: number } {
  return { used: slotsTaken(groupId), waiting: waiting.get(groupId) ?? 0 };
}

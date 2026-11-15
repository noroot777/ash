// 分组的并发名额:同一组里由系统拉起的成员 —— 分组运行(runParallel)、「接着跑」兑现欠账
// (dispatch-hold.ts) —— 合起来同时至多 MAX_PARALLEL 个在跑。名额等整轮跑完才还,同 runParallel。
// 早先限流只活在 runParallel 那一趟的局部变量里:组里六条被按住、记成欠账,接着跑逐条直起,
// 六条同时开跑(第 1 轮复审 F3)。
export const MAX_PARALLEL = 4;

// 一组只有一份计数,`used` = 持有名额的 + 已被叫醒、还没恢复的。还名额时有人在等就**原样转给它**
// (used 不减),没人等才减;减到 0 才删记录。早先是先减、再叫醒,被叫醒的要到下一个微任务才把
// 自己加回去:中间那一下计数能归零、记录被删,后来的建出第二份计数,两份各放四个(第 2 轮复审 F2)。
export type Slot = { used: number; waiting: Array<() => void> };
const groupSlots = new Map<string, Slot>();

/** 占一个名额（满了就排着等）。成员起跑别直接用它，走 member-start.ts startMember：那里有轮到之后的重新准入。 */
export async function acquireGroupSlot(groupId: string): Promise<Slot> {
  let slot = groupSlots.get(groupId);
  if (!slot) groupSlots.set(groupId, slot = { used: 0, waiting: [] });
  if (slot.used < MAX_PARALLEL) slot.used += 1;
  else await new Promise<void>((resolve) => slot.waiting.push(resolve));
  return slot;
}

export function releaseGroupSlot(groupId: string, slot: Slot): void {
  const next = slot.waiting.shift();
  if (next) return next();
  slot.used -= 1;
  if (!slot.used) groupSlots.delete(groupId);
}

/** 只给回归测试看这份计数本身(组里此刻占着 + 等着的)。 */
export function groupSlotUsage(groupId: string): { used: number; waiting: number } {
  const slot = groupSlots.get(groupId);
  return { used: slot?.used ?? 0, waiting: slot?.waiting.length ?? 0 };
}

// 分组的并发名额:同一组里由系统拉起的成员 —— 分组运行(runParallel)、「接着跑」兑现欠账
// (dispatch-hold.ts) —— 合起来同时至多 MAX_PARALLEL 个在跑。名额等整轮跑完才还,同 runParallel。
// 早先限流只活在 runParallel 那一趟的局部变量里:组里六条被按住、记成欠账,接着跑逐条直起,
// 六条同时开跑(第 1 轮复审 F3)。
export const MAX_PARALLEL = 4;

const groupSlots = new Map<string, { used: number; waiting: Array<() => void> }>();

export async function withGroupSlot<T>(groupId: string, run: () => Promise<T>): Promise<T> {
  let slot = groupSlots.get(groupId);
  if (!slot) groupSlots.set(groupId, slot = { used: 0, waiting: [] });
  while (slot.used >= MAX_PARALLEL) await new Promise<void>((resolve) => slot!.waiting.push(resolve));
  slot.used += 1;
  try {
    return await run();
  } finally {
    slot.used -= 1;
    slot.waiting.shift()?.();
    if (!slot.used && !slot.waiting.length) groupSlots.delete(groupId);
  }
}

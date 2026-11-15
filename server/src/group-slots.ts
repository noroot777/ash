import { claimOwnTurnUnlessStarted, turnStartsOf, type TurnIdentity } from "./turn-lock.js";

// 分组的并发名额:同一组里由系统拉起的成员 —— 分组运行(runParallel)、「接着跑」兑现欠账
// (dispatch-hold.ts) —— 合起来同时至多 MAX_PARALLEL 个在跑。名额等整轮跑完才还,同 runParallel。
// 早先限流只活在 runParallel 那一趟的局部变量里:组里六条被按住、记成欠账,接着跑逐条直起,
// 六条同时开跑(第 1 轮复审 F3)。
export const MAX_PARALLEL = 4;

// 一组只有一份计数,`used` = 持有名额的 + 已被叫醒、还没恢复的。还名额时有人在等就**原样转给它**
// (used 不减),没人等才减;减到 0 才删记录。早先是先减、再叫醒,被叫醒的要到下一个微任务才把
// 自己加回去:中间那一下计数能归零、记录被删,后来的建出第二份计数,两份各放四个(第 2 轮复审 F2)。
type Slot = { used: number; waiting: Array<() => void> };
const groupSlots = new Map<string, Slot>();

async function acquire(groupId: string): Promise<Slot> {
  let slot = groupSlots.get(groupId);
  if (!slot) groupSlots.set(groupId, slot = { used: 0, waiting: [] });
  if (slot.used < MAX_PARALLEL) slot.used += 1;
  else await new Promise<void>((resolve) => slot.waiting.push(resolve));
  return slot;
}

function release(groupId: string, slot: Slot): void {
  const next = slot.waiting.shift();
  if (next) return next();
  slot.used -= 1;
  if (!slot.used) groupSlots.delete(groupId);
}

/**
 * 组里一位成员占一个名额起跑(没有分组就不排队,直接起)。`start` 拿到的 `claim` 是**唯一**该用的
 * 占位:排队那一刻就记下这一位起过几轮,轮到时它已经被别的入口起过(哪怕已经跑完、又落回能起的
 * 状态)就不占 —— 排队时成立的资格,轮到时不一定还成立,「此刻没有回合」也不等于「这一次还没兑现」
 * (第 2 轮复审 F1:分组运行的旧请求把欠账入口已经跑完的那一位又起了一遍)。资格(状态、提问、
 * 哨兵、被按住)同样要在 `start` 里轮到之后重读,不能用排队前那一份。
 */
export async function startMember<T>(groupId: string | null, taskId: string,
  start: (claim: () => TurnIdentity | null) => Promise<T>): Promise<T> {
  const seen = turnStartsOf(taskId);
  const claim = () => claimOwnTurnUnlessStarted(taskId, seen);
  if (!groupId) return start(claim);
  const slot = await acquire(groupId);
  try {
    return await start(claim);
  } finally {
    release(groupId, slot);
  }
}

/** 只给回归测试看这份计数本身(组里此刻占着 + 等着的)。 */
export function groupSlotUsage(groupId: string): { used: number; waiting: number } {
  const slot = groupSlots.get(groupId);
  return { used: slot?.used ?? 0, waiting: slot?.waiting.length ?? 0 };
}

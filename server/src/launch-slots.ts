// 同一分组里「同时在跑」的名额。分组运行（scheduler.ts `runParallel`）和等齐就起（prerequisite-launch.ts）
// 共用这一份计数：两边各数各的时，叠在一起就能同时跑出两倍。不在分组里的任务算一个公共桶。
//
// 占名额是同步的（查和占之间没有 await）：先读计数、隔几次 await 再占，几路同时进来都会看到「还有空」。
// 占到的人自己负责在每一条出路上还（成功跑完、起不来、抛错）。
const PARALLEL_LIMIT = 4;
const taken = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
let waiters: (() => void)[] = [];

const bucket = (groupId: string | null | undefined) => groupId ?? "";

export function slotsTaken(groupId: string | null | undefined): number {
  return taken.get(bucket(groupId))?.size ?? 0;
}

/**
 * 这条任务此刻占着名额吗（占着 = 正由某一路起跑、或者在跑）。占名额的那几路（分组运行、接着跑、等齐就起）
 * 都是先占名额、隔几次 await 才把状态落成 queued/running，这段时间库里还是 backlog —— 换分组只看状态就会把
 * 它挪走，名额却还记在原来那组（queue-membership-guard.ts）。
 */
export function holdsSlot(taskId: string): boolean {
  for (const set of taken.values()) if (set.has(taskId)) return true;
  return false;
}

/**
 * 占一个名额。满了、或者这条任务的名额已经被另一路占着（它正由那一路起跑），都返回 false ——
 * 不能让两路共用一个名额：起不来的那一路照例还名额，还掉的就是正在跑的那一路的。
 */
export function takeSlot(groupId: string | null | undefined, taskId: string): boolean {
  const key = bucket(groupId);
  const set = taken.get(key) ?? new Set<string>();
  if (set.has(taskId)) return false;
  if (set.size >= PARALLEL_LIMIT) return false;
  set.add(taskId);
  taken.set(key, set);
  return true;
}

export function freeSlot(groupId: string | null | undefined, taskId: string): void {
  const key = bucket(groupId);
  const set = taken.get(key);
  if (!set?.delete(taskId)) return;
  if (!set.size) taken.delete(key);
  const woken = waiters;
  waiters = [];
  for (const wake of woken) wake();
  for (const listener of listeners) listener();
}

/** 等下一次有名额空出来（任意分组）。 */
export function whenSlotFrees(): Promise<void> {
  return new Promise((resolve) => { waiters.push(resolve); });
}

/** 有名额空出来时叫一声（等齐就起靠它补放被名额挡住的那几条）。 */
export function onSlotFreed(listener: () => void): void {
  listeners.add(listener);
}

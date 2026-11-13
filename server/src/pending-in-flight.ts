// 待发送投递的两本**同进程去重**账:冷却窗口与「在途」标记。都只是内存里的去重,不是
// 「已认领」的凭据 —— 认领靠行上的租约(delivering_since),这里丢了(进程重启)不丢消息。

// 一次投递之后的冷却:continueTask 对单任务是「先同步占住内存锁,再异步把状态
// 改成 running」,中间那一小段里任务读出来还是空闲的。两个触发源(tick 与终态
// 钩子)如果恰好挤在这道缝里,第二条消息会被标成 sent 却被 continueTask 的单飞
// 锁直接丢掉——消息就凭空消失了。所以同一任务刚发过就先按住,下一次触发再说。
const FIRE_COOLDOWN_MS = 5_000;
const lastFiredAt = new Map<string, number>();

export function noteFired(taskId: string): void {
  lastFiredAt.set(taskId, Date.now());
}

// 那一次没送成(租约归还):冷却跟着作废,重投不必再等它。
export function clearFired(taskId: string): void {
  lastFiredAt.delete(taskId);
}

// `rescan` = 被冷却挡下的这一扫欠的那一次:窗口一过就补上(同一任务只排一个)。不补的话,刚收过
// 消息的任务要是 5 秒内就空下来(起跑即失败、一两句话的短回合),等着的下一条没有别的触发源,
// 只能落回 30 秒兜底 tick。
const rescanDue = new Set<string>();

export function cooling(taskId: string, at: number, rescan: () => void): boolean {
  const last = lastFiredAt.get(taskId);
  if (last == null || at - last >= FIRE_COOLDOWN_MS) return false;
  if (!rescanDue.has(taskId)) {
    rescanDue.add(taskId);
    const timer = setTimeout(() => {
      rescanDue.delete(taskId);
      rescan();
    }, last + FIRE_COOLDOWN_MS - at);
    timer.unref?.(); // 补扫绝不该让进程多活一毫秒
  }
  return true;
}

// 已经排上、**还没把自己那一回合起起来**的投递:等任务当前那一轮退干净,加上起跑那一小段。
// 冷却窗口(5s)只够盖住 continueTask 内部那道缝,盖不住「等一轮跑完」。这段时间里同一任务的
// 第二条消息绝不能也被排上,否则两条会挤在一起争同一个回合。
//
// 注意它只是**同进程内的去重**,不是「已认领」的标记 —— 等待期间那一行必须仍是
// pending(见 deliverWhenIdle):进程随时可能被重启掐掉,内存里的等待回调会一起
// 消失,行要是那时已经是 sent 就再也没人管它了。
//
// **回合起来了就得摘**(输入回执落定那一刻;没走到那一步的,投递收场时摘)。此后的互斥归
// 回合锁与任务状态管 —— 跟手动运行、回复起的回合一个样。continueTask 等的是**整个回合**,
// 标记要是跟着挂到它返回,这一回合结束时的那次扫描(status.ts 的钩子)就被自己的标记挡掉,
// 摘掉之后又没人再扫:回合中途到的哨兵结果、用户补的一句,只能干等 30 秒兜底 tick
// (2026-11-13 实测:排队消息起的回合 45 例全部如此,别的回合 43 例全部秒送)。
const inFlight = new Set<string>();

export function deliveryInFlight(taskId: string): boolean {
  return inFlight.has(taskId);
}

// 返回摘标记的函数:幂等,且只摘自己挂的那一次 —— 回合起来时摘过之后,同一任务的下一条可能
// 已经挂上了它自己的,这一条收场时再摘一遍不许把那一个带走。
export function holdInFlight(taskId: string): () => void {
  inFlight.add(taskId);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    inFlight.delete(taskId);
  };
}

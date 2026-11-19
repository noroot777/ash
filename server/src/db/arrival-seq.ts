// 验收记忆的到达序号（为什么要它见 server/src/accept-order.ts）。单独一个不依赖任何东西的模块：
// 建表那一步（schema-accept-memory.ts）要拿库里已有的最大号给它垫底，accept-order.ts 要用它发号。

let last = 0;

/**
 * 发号不能只靠「时钟总比上次大」：系统时间往回校、再重启，进程里的计数归零，新号就会比库里留下的
 * 旧号小，之后的确认全被当成过期的静默丢掉（第 3 轮审查 N1）。所以启动时先用库里的最大号垫底。
 */
export function seedArrivalSeq(floor: number): void {
  if (floor > last) last = floor;
}

/** 下一个号：到达时刻（微秒），同一微秒内或时钟回退时顺延一位，永不回头。 */
export function nextArrivalSeq(): number {
  last = Math.max(Date.now() * 1000, last + 1);
  return last;
}

// 会话产物（`<会话>.md`、`<会话>.trace.jsonl`）的逐文件写锁 + 原子整份替换。
//
// 这两份文件平时只追加。追加者分两类：
//  - 回合里的写流（orchestrator / task-run / reattach 的 `out`、single-run 的 trace）—— 只在
//    有回合在跑时存在，改写方（删除消息）先占回合锁并确认没有进程在跑，与它们天然互斥；
//  - 回合之外随时会来的那几笔（任务时间线旁注、会话注记、接力补记）—— 它们与改写方之间
//    什么都不共享，所以都走这里的 `withRunFileLock`。
// `appendFileSync` 那种同步追加不用进锁：改写方在锁里的读、算、写、换名全是同步的，同一个
// 进程里两段同步代码不可能交错。
//
// 改写用「写临时文件 → rename 盖过去」：rename 是原子的，写到一半失败（磁盘满、权限、短写）
// 原文件一个字节都不动；就地 write + truncate 做不到这一点。代价是换了 inode —— 所以凡是
// 会在改写期间开着这份文件的追加者，都必须是上面两类之一。
import { renameSync, rmSync, writeFileSync } from "node:fs";

const tails = new Map<string, Promise<unknown>>();

/** 按路径串行：同一份文件上的追加与改写排队进行，不同文件互不等待。 */
export async function withRunFileLock<T>(paths: readonly string[], fn: () => Promise<T> | T): Promise<T> {
  const keys = [...new Set(paths)].sort();
  const before = keys.map((key) => tails.get(key) ?? Promise.resolve());
  const run = Promise.all(before.map((wait) => wait.catch(() => undefined))).then(fn);
  const tail = run.catch(() => undefined);
  for (const key of keys) tails.set(key, tail);
  try {
    return await run;
  } finally {
    for (const key of keys) if (tails.get(key) === tail) tails.delete(key);
  }
}

/** 整份替换：要么换成新内容，要么原样不动。只能在 `withRunFileLock` 里调。 */
export function replaceFileAtomically(path: string, content: string): void {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, content);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

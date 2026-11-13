// 「data/runs/<任务>」这类按任务编号拼出来的目录，归属会变：任务删掉之后，同一个编号还可能被
// 接力导入重新领回去（handoff-import.ts）。删目录的一方（run-dir-reclaim.ts）和往里写的一方
// 必须对同一个编号互斥，否则旧的清理可能在新导入写完之后才删到那一步，把刚导入的正文删掉。
//
// 只看「任务行在不在」挡不住：导入是先写文件、后建任务行的，查到「没有任务」的那一刻，导入
// 可能正在写。所以导入从写文件到建完行整段持锁，清理在锁内重新确认任务不存在才动手——两边
// 排队，谁也看不到对方的半截状态。ash 是单进程（singleton.ts），进程内的锁就是全部写方。
const tails = new Map<string, Promise<void>>();

export async function withTaskDirLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(taskId) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => held);
  tails.set(taskId, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(taskId) === tail) tails.delete(taskId);
  }
}

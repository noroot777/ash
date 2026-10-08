// 创建完成时把任务回写进列表的合并策略(WorkspaceShell.createTask 用)。
// 两类在途竞态必须同时成立(第 2、3 轮审查各复现过一边):
//   ① 本地行更"新"(SSE 已送达入队/移出等更晚的队列更新),HTTP 快照过期 → 保留本地;
//   ② 本地行更"旧"(只收到过 task.created,入队的 task.updated 断流),成功重取的
//     HTTP 快照才是最新 → 用快照覆盖。
// 两者在字段上同形(都是「一边 queueId=null、一边非 null」),只能比先后:服务端在
// 队列变更时 bump 成员 updatedAt(queues.ts publishQueueMembers),这里按它裁决。
// 相等时保留本地行——SSE 载荷是发布时现读库的 enriched 快照,至少不旧于同刻的响应。
export function mergeCreatedTask<T extends { id: string; updatedAt: string }>(
  current: T[],
  created: T,
): T[] {
  const existing = current.find((row) => row.id === created.id);
  if (!existing) return [created, ...current];
  if (existing.updatedAt >= created.updatedAt) return current;
  return current.map((row) => (row.id === created.id ? created : row));
}

// 入队响应波及成员(前驱等)的合并策略:同样按 updatedAt 裁决,但**缺行不插入**。
// 与 mergeCreatedTask 的差别只在缺行语义:创建路径的缺行 = 「task.created 事件还没
// 送到」,占位插入是对的;成员同步的缺行 = 本页已经删除它(或它本就不可见),被删的
// 行没有 updatedAt 可比较,插入等于让在途旧快照复活已删任务(第 6 轮审查真实复现)。
// 新任务的首次插入由创建路径(onCreated → mergeCreatedTask)负责,这里只更新存量行。
export function mergeTaskSnapshot<T extends { id: string; updatedAt: string }>(
  current: T[],
  snapshot: T,
): T[] {
  const existing = current.find((row) => row.id === snapshot.id);
  if (!existing || existing.updatedAt >= snapshot.updatedAt) return current;
  return current.map((row) => (row.id === snapshot.id ? snapshot : row));
}

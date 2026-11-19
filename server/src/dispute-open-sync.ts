import { bus } from "./bus.js";

// 「等你裁定」（Task.disputeOpen）变了，列表得收到一份新的任务快照。
//
// 它是任务列表上的一格后台事实（task-store.ts 现查），住在审查轮次上，改它不动 tasks.updated_at；
// 侧栏只认 task.created / task.updated，审查面板才认 task.review。会改它的写入点全都发 task.review：
// 驳回落下、维持（含「按意见修复」）、采纳、转独立任务、转出失败回滚、被新一轮审查取代
// （free-review-dispute.ts / free-review-defer.ts）；接力导入整条带过来的那一路自己发 task.updated
// （handoff-import.ts）。所以推送挂在 task.review 上统一做，哪个出口都不必再记得「另外补发一次」。
//
// **每次都发，不按缓存去重。** 第 2 轮审查：上一版先查那一格、跟进程里记着的值相等就不发 —— 可那份
// 记忆只是「这个进程见过什么」，不是「页面手里拿着什么」。重启之后、或页面先整表拉到了 true，记忆里
// 是空的，裁定把它改成 false 时恰好「相等」，列表就一直写着等你裁定。task.review 本来就只在审查状态
// 真的变了时才发（不是逐行进度），多发一份快照的代价是一次单行查询；页面那边按 updatedAt /
// backgroundRevision 合并，重复的一份不会改动任何东西。
//
// 同一个任务一连发几次时并成一次：正在发的那次之后至多再补一次，补的那次读的是最新的库。

const inflight = new Map<string, Promise<void>>();
const again = new Set<string>();

async function republish(taskId: string): Promise<void> {
  try {
    const { publishTaskUpdated } = await import("./task-store.js");
    await publishTaskUpdated(taskId);
  } catch (error) {
    console.warn(`[navi] 重发任务 ${taskId} 的快照失败（审查状态变了）:`, error);
  }
}

function schedule(taskId: string): Promise<void> {
  const running = inflight.get(taskId);
  if (running) {
    again.add(taskId);
    return running;
  }
  const run = (async () => {
    do {
      again.delete(taskId);
      await republish(taskId);
    } while (again.has(taskId));
  })();
  inflight.set(taskId, run);
  // 循环刚退出、这里还没清掉之间又来了一次：那一次记在 again 里，清完接着补。
  void run.finally(() => {
    inflight.delete(taskId);
    if (again.delete(taskId)) void schedule(taskId);
  });
  return run;
}

let started = false;
/** 挂上事件总线。task-store.ts 加载时调一次 —— 列表投影在哪，这条推送就在哪。 */
export function startDisputeOpenSync(): void {
  if (started) return;
  started = true;
  bus.subscribe((event) => {
    if (event.type === "task.review") void schedule(event.taskId);
  });
}

/** 测试用：等某个任务排着的重发都落地。 */
export function disputeOpenSettled(taskId: string): Promise<void> {
  return inflight.get(taskId) ?? Promise.resolve();
}

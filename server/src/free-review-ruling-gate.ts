// 「这一刻有没有未裁定的驳回」与「写下一条驳回 / 按预约开一轮审查」之间的串行化边界。
//
// 裁定闸（startReservedFreeReview）先查争议、再 CAS 消费预约；驳回（disputeFreeReview）先查
// 审查链、再写驳回。两段各自都是「检查完再动手」，中间隔着好几次 await，而它们恰好会在同
// 一刻发生：驳回是执行回合里的 MCP 调用，回合一结束结算就去消费预约。预约自己的版本令牌
// 证明不了「争议状态没变」——用户手存的预约在驳回时原样保留，令牌不动，CAS 照样成功
// （第 1 轮审查实测：驳回先落库、预约随后被消费、审查照常派出，用户还没裁定）。
//
// 所以两段整体互斥，各自的判据到动手那一刻仍然成立：
//  · 驳回先排上 → 闸进来时驳回已落库，查得到，预约原样留着；
//  · 闸先排上 → 预约消费、审查链切进 reviewing 都在锁里做完，驳回进来时最近一轮已不在
//    「停在未通过」，按迟到拒收。
//
// 用它的规矩：
//  · 锁住的是「判据 + 动作」整段，拆开就回到检查与动作分离；
//  · 可重入（同一条异步调用链里再取直接放行），所以闸里调用的派审下游不必知道自己在锁里；
//  · 它在审查生命周期锁（review-lifecycle-lock.ts）之外：闸里的派审下游会取那把锁，反过来
//    持有那把锁的段里不许再来取这一把。
//
// 只保证**本进程内**的顺序，与 `serialize`、仓库锁同一档。
import { AsyncLocalStorage } from "node:async_hooks";

const chains = new Map<string, Promise<void>>();
const held = new AsyncLocalStorage<ReadonlySet<string>>();

export async function withRulingGate<T>(taskId: string, job: () => Promise<T>): Promise<T> {
  const holding = held.getStore();
  if (holding?.has(taskId)) return job();
  const previous = chains.get(taskId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => mine);
  chains.set(taskId, tail);
  await previous;
  try {
    return await held.run(new Set([...(holding ?? []), taskId]), job);
  } finally {
    release();
    if (chains.get(taskId) === tail) chains.delete(taskId);
  }
}

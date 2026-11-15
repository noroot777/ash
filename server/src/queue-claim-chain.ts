// 队列/分组归属的唯一原子边界。两类人排在这一条链上依次执行：
//   · 认领方 —— 「整队无人在跑 / 还在原组」的检查和「落 queued 占位」（queue-seat.ts 手动启动、
//     scheduler.ts 队列推进、member-start.ts 分组运行与接着跑兑现）；
//   · 归属写方 —— 改 queue_items（建队、插入、重排、移出、重新排队、建任务时串队）和改任务
//     groupId（PATCH、删分组摘出）。
//
// 只串行认领方不够：认领方在临界区里读完归属、隔着几个 await 才提交占位，写方若不进同一条链，
// 照样能在这段窗口里按「它还是 backlog」把它插进一条正有人在跑的队列，认领方随后按旧归属起跑，
// 同队两个一起跑（mIDVPBcrvLZ8 第 4 轮审查实测）。写方进链后只剩两种顺序：写在前，认领方重读
// 就看见新归属；占位在前，写方的校验就看得见那个 queued。
//
// 写方的规矩：**校验读与写入都在临界区里做**（请求进门时读到的快照不作数），publish、推进队列
// 这类会再进链的副作用放到临界区外 —— 链不可重入，在里面等它就是等自己。
//
// 独立成一个小模块（只依赖回合锁）：queues.ts（写方）和 queue-seat.ts（认领方）互相引用，链放在
// 任何一边都会让另一边背上一条循环 import。
import { claimedSince, isTurnClaimed, turnClaimWatermark } from "./turn-lock.js";

let chain: Promise<unknown> = Promise.resolve();

// 链上任何一次失败都不许断链（与 pending-messages 的 scanChain 同款写法）。
export function serializeQueueClaims<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn);
  chain = next.catch(() => undefined);
  return next;
}

// ── 不在队列的那一类起跑:库里看不见,只能看内存 ─────────────────────────────────────
// 队列成员的起跑在链上落 queued 占位,写方和调度器读库都看得见。独立任务的起跑不落占位
// (queue-seat.ts claimQueueSeat 不在队列那一支):它要是先落 queued,编排器就认不出「paused
// 检查点上的追问」,一句「怎么样了」会被当成执行回合吞掉检查点(orchestrator.ts
// checkpointFollowUp)。于是从放行到状态落 running 之间,库里还是 backlog/paused。
//
// 这段时间里的事实只有内存知道,而调度器不读内存 —— 所以写方对这种任务**一律不放进队列**
// (不是「算一个在跑、不超过一个就行」:放进去之后队列推进看它是 backlog,照样起它前面那条)。
// 等它落成 running,库里看得见了,再按常规口径入队。
//
// 「正在起跑」由两样组成,都有明确的终点,不靠时限:
//   · 回合锁被占着:先占锁再认领的入口(/run、/fire、/retry、定时、重跑上一回合)一直占到起跑
//     落定之后;别的起跑方式也都在跑之前占上它;
//   · 认领放行、锁还没占上的那一拍(回复、答复、消息补投是先认领后占锁):放行时记一笔,
//     **这之后任何人占上这个任务的回合锁**就由回合锁接手、这一笔作废;起跑没成、锁一次都没
//     占上的,认领方交回的那份占位 release() 时撤掉。进程重启一并清空,删任务时一并忘掉。
const soloStarts = new Map<string, number>();

/** claimQueueSeat 在临界区里放行一个不在队列的任务时记一笔;返回撤掉这一笔的函数(只撤自己这一笔)。 */
export function noteSoloStart(taskId: string): () => void {
  const watermark = turnClaimWatermark();
  soloStarts.set(taskId, watermark);
  return () => {
    if (soloStarts.get(taskId) === watermark) soloStarts.delete(taskId);
  };
}

/** 任务删了就不再记(task-delete-routes.ts)。 */
export function forgetSoloStart(taskId: string): void {
  soloStarts.delete(taskId);
}

/** 写方在链上问:这条库里还是 backlog/paused 的任务,此刻是不是正在起跑。 */
export function startingOutsideQueue(taskId: string): boolean {
  if (isTurnClaimed(taskId)) return true;
  const watermark = soloStarts.get(taskId);
  if (watermark === undefined) return false;
  if (!claimedSince(taskId, watermark)) return true;
  soloStarts.delete(taskId);
  return false;
}

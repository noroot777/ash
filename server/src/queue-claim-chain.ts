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
import { holdsRealTurn } from "./turn-lock.js";

let chain: Promise<unknown> = Promise.resolve();

// 链上任何一次失败都不许断链（与 pending-messages 的 scanChain 同款写法）。
export function serializeQueueClaims<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn);
  chain = next.catch(() => undefined);
  return next;
}

// ── 不在队列的那一类起跑:库里看不见,写方得看内存 ─────────────────────────────────────
// 队列成员的起跑在链上落 queued 占位,写方读库就看得见。独立任务没有同队语义,认领在「不在
// 队列」那一支直接放行、不落占位(queue-seat.ts claimQueueSeat),从放行到状态落 running 之间
// 库里还是 backlog/paused —— 写方按库判就会把一条正在起跑的任务插进有人在跑的队列。
// 这段时间里能证明「它正在起」的只有两样:
//   · 起跑那一轮占着的回合锁(/run、/fire、/retry、定时、重跑上一回合都是先占锁再认领,一直
//     占到起跑落定之后;别的起跑方式也都在跑之前占上它);
//   · 回复、答复、消息补投是认领放行之后才去占锁,中间那一拍只有这里记的一笔。
// 那一笔自己有界(SOLO_ADMIT_GRACE_MS):正常几毫秒内就被回合锁接走,放行后没起成的也不会让
// 它永远进不了队列;进程重启一并清空。
const SOLO_ADMIT_GRACE_MS = 5_000;
const soloAdmits = new Map<string, number>();

/** claimQueueSeat 在临界区里放行一个不在队列的任务时记一笔。 */
export function noteSoloAdmit(taskId: string): void {
  soloAdmits.set(taskId, Date.now());
}

/** 写方在链上问:这条(还不在队列里的)任务此刻是不是正在起跑。 */
export function startingOutsideQueue(taskId: string): boolean {
  if (holdsRealTurn(taskId)) return true;
  const at = soloAdmits.get(taskId);
  if (at === undefined) return false;
  if (Date.now() - at < SOLO_ADMIT_GRACE_MS) return true;
  soloAdmits.delete(taskId);
  return false;
}

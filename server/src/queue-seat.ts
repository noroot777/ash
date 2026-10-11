// 队列执行占位(seat):**「整队无人在跑」的检查和「落 queued 占位」必须是同一个临界区**,
// 而且是所有执行入口共用的同一个 —— 手动运行(/run)、立即触发(/fire)、失败重试(/retry)、
// 重跑上一回合(retry-turn)、消息补投扫描(pending-messages)、队列推进(advanceQueue)。
//
// 为什么:这些入口各自都是「先读库检查、隔着若干 await、再把状态落库/把任务拉起」。检查
// 读的是 tasks.status,而另一个入口在自己的窗口里只占了**任务级**回合锁(claimTurn)、
// 状态还停在终态 —— 于是两个入口各自读到「整队空闲」,同一条串行队列上两个成员一起跑
// (第 7 轮审查:重跑上一回合在异步读旧记录期间保持 done,扫描判定整队空闲并启动另一个
// 失败成员,普通 HTTP 并发 10/10 复现)。任务级锁解决不了跨成员互斥;多查几次也关不掉
// TOCTOU —— 检查与占位必须争同一个原子对象,这里就是那个对象。
//
// 口径:挡路判定复用 manualStartBlockers(与 /run 前置检查、selectNextInQueue 同一把
// 尺子),所以**终态续聊的豁免原样保留**(queueStatus 按 followUpFrom 把续聊回合看成
// 原终态)——真正的终态续聊从不调本模块,也不会被占位挡住。
//
// 占位的生命周期:
//   claim 成功 → 任务立即是 queued,此后任何入口的检查都看得见;
//   真正开跑 → continueTask 把状态推到 running,结算覆盖占位,seat.release() 成为 no-op;
//   一个字都没跑成(租约被抢、消息被取消、起跑被挡)→ 调 release() 按守卫回滚:回合锁
//   被人占着(别的路径正要跑)或状态已不是 queued(结算已覆盖)都不动,只有「没人接手、
//   还停在占位上」才退回占位前的状态 —— 否则任务永远卡在 queued。
//
// ⚠ release() 不许在 serializeQueueClaims 的临界区里调:回滚到终态会触发
// advanceQueueFromTask → advanceQueue,后者也要进同一条链,届时会死等自己。
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "./db/index.js";
import { queueItems, tasks } from "./db/schema.js";
import { manualStartBlockers } from "./queues.js";
import { isTurnClaimed } from "./runs.js";
import { setTaskStatus } from "./status.js";

export type QueueSeat = {
  taskId: string;
  /** 占位前的状态,release() 回滚的目标。 */
  prevStatus: string;
  /** 占位落空的兜底回滚(守卫判据见模块头)。送达/正常结算后调用是 no-op,可安全多调。 */
  release(): Promise<void>;
};

// ── 旁路回合欠下的队列推进(第 ln9Q6IJEgmWf 链第 3 轮)───────────────────────────
// 续聊/旁路回合(followUpFrom 是 paused/backlog 一类非终态)正占着 running 时,前项
// 让位触发的推进会被 selectNextInQueue 的「有人在跑」守卫冻结;这轮结算又按「恢复
// 原样」quiet 落回 paused(setTaskStatus 的 quietAdvance),那次真实发生过的让位就
// 没了下家 —— 后项和它自己都静止到用户手点(审查真实页面复现:前项在追问期间完成,
// 检查点任务停在 paused,刷新也不动)。所以推进被这类回合冻结时记一笔账,旁路结算
// 恢复后消费补办;期间没有任何推进事件的静止检查点无账,照旧不被一句追问续跑。
//
// 互斥性:记账发生在 advanceQueue 的 serializeQueueClaims 临界区内,消费也必须包进
// 同一条链 —— 消费段排在记账段之后就取得到;排在之前则恢复已先落库,记账那次推进
// 在临界区里读到的就是 paused,自己就能挑中它,两边都不丢。
const missedAdvances = new Map<string, string>(); // 旁路回合成员 taskId → 它的 queueId

export function noteMissedAdvance(taskId: string, queueId: string): void {
  missedAdvances.set(taskId, queueId);
}

/** 旁路结算恢复后取走欠账;要么在 serializeQueueClaims 里调(互斥才成立),要么是丢弃场景。 */
export function takeMissedAdvance(taskId: string): string | null {
  const queueId = missedAdvances.get(taskId) ?? null;
  missedAdvances.delete(taskId);
  return queueId;
}

export type QueueSeatClaim =
  | { ok: true; seat: QueueSeat | null } // seat=null:任务不在任何队列,没有同队语义
  | { ok: false; blockers: string[] };

// 所有「检查整队 → 占位/落 queued」的临界区排在这一条链上依次执行。队列很小、临界区里
// 只有几条 SQLite 查询,全局一条链足够;链上任何一次失败都不许断链(与 pending-messages
// 的 scanChain 同款写法)。
let chain: Promise<unknown> = Promise.resolve();

export function serializeQueueClaims<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn);
  chain = next.catch(() => undefined);
  return next;
}

/**
 * 为 taskId 认领它所在队列的执行占位。认领到 = 任务已落 queued,调用方随后真正拉起它;
 * 被挡 = 返回挡路成员,调用方按自己的语义处理(路由 409 / 扫描按「等」记账)。
 * 不在队列的任务直接放行(seat 为 null),独立任务没有同队互斥。
 */
export async function claimQueueSeat(taskId: string): Promise<QueueSeatClaim> {
  const item = (await db.select().from(queueItems).where(eq(queueItems.taskId, taskId))).at(0);
  if (!item) return { ok: true, seat: null };
  return serializeQueueClaims(async (): Promise<QueueSeatClaim> => {
    // 成员与状态都在临界区里重读:链上前一次认领刚落的 queued,这里必须看得见。
    const items = await db
      .select()
      .from(queueItems)
      .where(eq(queueItems.queueId, item.queueId))
      .orderBy(asc(queueItems.position));
    if (!items.some((i) => i.taskId === taskId)) return { ok: true, seat: null }; // 排队间隙被移出了队列
    const rows = await db.select().from(tasks).where(inArray(tasks.id, items.map((i) => i.taskId)));
    const position = new Map(items.map((i) => [i.taskId, i.position]));
    const blockers = manualStartBlockers(
      rows.map((r) => ({ ...r, position: position.get(r.id) ?? 0 })),
      taskId,
    );
    if (blockers.length) return { ok: false, blockers };
    const prevStatus = rows.find((r) => r.id === taskId)?.status ?? "backlog";
    await setTaskStatus(taskId, "queued");
    return { ok: true, seat: makeSeat(taskId, prevStatus) };
  });
}

function makeSeat(taskId: string, prevStatus: string): QueueSeat {
  let released = false;
  return {
    taskId,
    prevStatus,
    async release() {
      if (released) return;
      released = true;
      // 回合锁被人占着 = 有人正拿着这个占位真正起跑,它的结算会覆盖状态,这里不动;
      // 锁空着才查状态回滚 —— 把别人正要跑的任务翻回终态,结算钩子会放行下一个成员,
      // 反而造出双跑。
      if (isTurnClaimed(taskId)) return;
      try {
        const cur = (await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId))).at(0);
        if (cur?.status === "queued") {
          await setTaskStatus(taskId, prevStatus as Parameters<typeof setTaskStatus>[1]);
        }
      } catch {
        /* 回滚失败只能留给重启 reconcile */
      }
    },
  };
}

// 「认领占位 → 启动 → 收尾释放」的组合件,凡是**占到位就 fire-and-forget 启动**的入口
// 共用(/run、/fire、/retry、定时到点 fire):被挡把挡路成员交回调用方按自己的语义处理
// (路由 409 / 定时不消费班次);占到位把启动 promise 挂上收尾 —— 起跑失败/被挡时按守卫
// 回滚占位,别让任务卡在 queued(真跑起来了 release 是 no-op)。
export async function seatThenStart(
  taskId: string,
  start: () => Promise<unknown>,
): Promise<{ ok: true } | { ok: false; blockers: string[] }> {
  const claim = await claimQueueSeat(taskId);
  if (!claim.ok) return { ok: false, blockers: claim.blockers };
  const seat = claim.seat;
  void start()
    .catch((err) => console.error(`[ash] 任务 ${taskId} 启动异常:`, err))
    .finally(() => { if (seat) void seat.release(); });
  return { ok: true };
}

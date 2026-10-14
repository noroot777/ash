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
import { isTurnClaimed, whenTurnIdle } from "./runs.js";
import { setTaskStatus } from "./status.js";

export type QueueSeat = {
  taskId: string;
  /** 占位前的状态,release() 回滚的目标。 */
  prevStatus: string;
  /** 占位落空的兜底回滚(守卫判据见模块头)。送达/正常结算后调用是 no-op,可安全多调。 */
  release(): Promise<void>;
};

// ── 旁路回合欠下的队列推进(第 ln9Q6IJEgmWf 链第 3、4 轮)─────────────────────────
// 两类让位会在这里挂账:
// ① 前项让位时,冻结源是旁路/续聊回合(followUpFrom 非终态)的活跃回合 —— 这轮结算
//   按「恢复原样」quiet 落回 paused(setTaskStatus 的 quietAdvance),那次真实发生过
//   的让位没有下家(第 3 轮:前项在追问期间完成,检查点任务静止等手点)。
// ② 推进挑中了一个刚恢复 paused、**旧回合锁还没释放**的成员 —— 先写 queued 再续跑
//   会被 turn-entry-guard 挡回,占位没人回滚,任务永久卡「排队中」(第 4 轮问题 1)。
//
// 共同解法:记账的同时就把补办挂上 whenTurnIdle —— 回合锁一释放(结算收尾一定晚于
// 状态恢复落库)回调重新 advanceQueue,那时成员已是干净的 paused,正常挑中续跑。
// 消费不依赖结算代码的执行顺序,所以「清身份→恢复状态」间的任何窗口都塞不掉这笔账;
// 期间没有任何推进事件的静止检查点依然无账,不会被一句追问续跑(第 2 轮语义保留)。
// 回调里的 advanceQueue 进同一条认领链,幂等:多记几笔最多多跑几次空转判定。
const missedAdvances = new Map<string, string>(); // 占着回合锁的成员 taskId → 它的 queueId

export function noteMissedAdvance(taskId: string, queueId: string): void {
  const pending = missedAdvances.has(taskId);
  missedAdvances.set(taskId, queueId);
  if (pending) return; // 已有一个回调在等这次 turn 释放
  whenTurnIdle(taskId, () => {
    const owed = missedAdvances.get(taskId);
    missedAdvances.delete(taskId);
    if (!owed) return;
    // 动态 import:scheduler 静态依赖本模块。void 不 await —— 本回调可能在推进的
    // 临界区内同步触发(turn 恰好已空),advanceQueue 排到链尾即可,await 会死等自己。
    void import("./scheduler.js").then(({ advanceQueue }) =>
      advanceQueue(owed).catch((err) => console.error(`[ash] 补办队列推进(${taskId})失败:`, err)),
    );
  });
}

export type QueueSeatClaim =
  | { ok: true; seat: QueueSeat | null } // seat=null:任务不在任何队列,没有同队语义
  | { ok: false; blockers: string[]; transient?: boolean }; // transient:数据库临时故障,不是同队在跑

// 手动启动入口(/run、/fire、/retry、重跑上一回合)的认领失败话术。transient(数据库
// 临时故障)时必须说真话:把一次可重试的写失败报成「同队有人在跑」,用户会去等一个
// 不存在的前项(第 ll7XKsu_ps0n 链第 2 轮指出)。
export function queueClaimError(r: { blockers: string[]; transient?: boolean }): string {
  return r.transient
    ? r.blockers.join("；")
    : "同一队列里还有未完成或正在运行的任务，先等它们结束、处理完，或把本任务移出队列";
}

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
    try {
      await setTaskStatus(taskId, "queued");
    } catch (err) {
      // 占位写入失败 ≠ 肯定没写入:setTaskStatus 写完 status 还要读 sessions 广播,
      // UPDATE 已提交、附带读取才超时的话任务已经是 queued(第 7 轮审查同款)。这里
      // 异常若直接外抛,手动启动入口(/run 等)在 claimTurn 之后的 await 就会把 500
      // 抛给用户、回合锁没人释放,此后一律 409「回合正在进行」(第 ll7XKsu_ps0n 链
      // 第 1 轮)。按失败认领返回,让调用方走统一的「认领失败」收口(释放自己的锁/
      // 暂存消息);可能的 queued 遗留延迟交给 scheduler 的守卫补偿按持久结果收拾。
      //
      // 补偿必须 repush:"never" —— 本函数的调用方全是带自身语义的入口(/fire 全新
      // 一轮、/run 续跑、扫描投递消息),记账重推走的是 advanceQueue 的 resumeOrRunTask,
      // 会把 /fire 的「永不 resume」偷换成续跑旧会话、消费掉检查点指令(第 ll7XKsu_ps0n
      // 链第 2 轮实测:409 之后任务自行续上旧检查点)。失败就只回滚遗留,让原入口按
      // 原语义重试(用户重点、扫描重投、定时不消费班次)。
      console.error(`[ash] 队列占位写入失败(${taskId}),按认领失败返回并安排遗留回收:`, err);
      void import("./scheduler.js").then(({ reclaimStrandedSeat }) => {
        const timer = setTimeout(
          () => void reclaimStrandedSeat(taskId, item.queueId, prevStatus as Parameters<typeof reclaimStrandedSeat>[2], { repush: "never" }),
          1_000,
        );
        timer.unref?.();
      });
      return { ok: false, transient: true, blockers: ["队列占位写入失败，请稍后重试"] };
    }
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
  start: (seat: QueueSeat | null) => Promise<unknown>,
): Promise<{ ok: true } | { ok: false; blockers: string[]; transient?: boolean }> {
  let claim: QueueSeatClaim;
  try {
    claim = await claimQueueSeat(taskId);
  } catch (err) {
    // 临界区里的读也可能撞锁:异常传出去就是手动入口 claimTurn 之后的 500 + 锁泄漏
    // (调用方的「认领失败 → releaseTurn」分支走不到)。读失败没有写入遗留,按失败
    // 认领返回即可,下一次点运行就是干净的重试。
    console.error(`[ash] 队列占位认领读取失败(${taskId}):`, err);
    return { ok: false, transient: true, blockers: ["队列占位读写失败，请稍后重试"] };
  }
  if (!claim.ok) return claim;
  const seat = claim.seat;
  void start(seat)
    .catch((err) => console.error(`[ash] 任务 ${taskId} 启动异常:`, err))
    .finally(() => { if (seat) void seat.release(); });
  return { ok: true };
}

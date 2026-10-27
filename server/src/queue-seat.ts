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
//
// ## 回滚的所有权:回合锁 + 条件写,两道都要
//
// `setTaskStatus` 自己内部就有 await:先整行 SELECT,再按 taskId UPDATE。所以「最后检查
// 一次所有权、紧接着调它」是挡不住的 —— 新持有者能在那次 SELECT 期间占锁、绑令牌、落
// running,旧回滚随后照样把它写回终态,还连带触发结算与队列推进(第 2 轮审查 F1 实测:
// 新锁仍在而状态已被翻成 failed,下一项还可能因此提前开跑)。
//
// 第一道是**把回合锁占在手里**再提交(`SEAT_ROLLBACK_ROLE`):占住期间任何新持有者都
// claim 不进来,提交窗口里不可能有人开始新一轮。占不到 = 有人正拿着这个占位起跑,排到
// 它释放之后再看一眼。
//
// 但回合锁只挡得住**走 `claimTurn` 的那些人**,而生产路径上有两个改状态的人不走它:
//   · 用户点停止 —— `/tasks/:id/stop` 直接 `setTaskStatus(canceled)`;
//   · 下一次占位认领 —— `claimQueueSeat` 排的是自己那条 `serializeQueueClaims` 链,
//     同一个任务重新认领一次就换了代次,而此刻库里的状态**恰好还是 queued**。
// 第 1 轮审查两条都实测到了:停止回 200、库里 canceled,旧回滚结束后变回 failed
// (`stop-rollback-smoke.log`);以及世代从 3 换到 4 之后旧回滚照样把它撤回终态
// (`seat-window.json`)。
//
// 所以第二道是**条件写**:提交那一笔带上「库里还得是 queued」(`expectStatus`)和
// 「代次还得是我这一代」:认领与补偿共用 `serializeQueueClaims`,覆盖等待写门、实际提交
// 和发号。状态条件由 SQL 核验,代次在链内核验;失效时不发布终态、停哨兵或推进队列。
// 这才是「认领、停止、回滚争同一份可原子核验的状态」,查几次都不是。
//
// ## 占位有世代,回滚只撤自己那一代
//
// 回滚可能**延期**执行(锁被占着时排到释放之后),而延期意味着「我当初占下的那个 queued」
// 和「现在库里这个 queued」可能已经不是同一个。只看状态等于 queued 就回滚,撤掉的就是
// 后来者的占位:任务被翻回终态,结算钩子放行下一个成员,反而造出双跑 —— 本轮审查 F3 实测
// `{"newTurnStillHeld":{"role":"single"},"statusAfterOldRollback":"failed"}`,因为 `endTurn`
// 按注册顺序跑回调,排在前面的那个合法回调已经抢到新锁、落了新占位,我这个后到的回滚照样写。
//
// 所以每次认领发一个号(`seatGen`),回滚只在「我这一代还是当前那一代」时才撤。占不到锁时
// **不是放弃,而是再排一次** —— 直接 return 就又回到了「占位永远没人回滚」那个形态
// (2026-10-26 实测 70+ 分钟)。
//
// ## 一个任务同时只能有一代活着的占位
//
// 模块头第一句讲的是**跨成员**互斥(整队只许一个在跑)。还差一条**同一个任务**的:
// `manualStartBlockers(rows, taskId)` 不把 taskId 自己算作挡路者 —— 那对终态续聊是对的,
// 但它顺带意味着「这个任务已经被占成 queued」也不挡它自己,于是两条入口能在同一个任务上
// 各占一代。后果不是多一行记录:
//   · 第二代读到的 `prevStatus` 是**第一代占下的那个 queued**,它的回滚于是成了「写回
//     queued」—— 什么也没回滚,任务停在排队中;
//   · 第一代的回滚和第二代的启动同时在动同一行状态,谁赢取决于时序。
// (第 1 轮审查 F1 的 `seat-window.json` 正是这个形态:世代 3 → 4,随后状态被旧的那一代
// 撤回终态。)
//
// 所以在同一个临界区里加一条:号码非 0 = 另一条入口正拿着这个任务的执行位,直接挡回。
// 调用方全都是「我要启动它」(/run、/fire、/retry、重跑上一回合、消息投递、定时班次、
// 队列推进),被挡的处理路径它们本来就有 —— 挡回话术要说真话,别套用「同队有人在跑」。
//
// ## 号码不许在没人接手时留着
//
// 世代号同时是 scheduler 兜底的让位判据(非 0 = 有活着的 seat 负责,外人别插手)。所以凡是
// 本 seat **放弃责任**的出口 —— 重排到顶、读写异常 —— 都必须「清号 + 把补偿交给 scheduler」,
// 一步都不能少。少了就是:号码留着、谁都不来收,兜底在读库之前就 return,任务永久「排队中」
// (第 2 轮审查 F2 实测 `afterUnlockAndGuard: {status:"queued", turn:null, seatGen:2}`)。
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "./db/index.js";
import { queueItems, tasks } from "./db/schema.js";
import { manualStartBlockers } from "./queues.js";
import { SEAT_ROLLBACK_ROLE, claimNonTurn, isTurnClaimed, whenTurnIdle } from "./runs.js";
import { setTaskStatus } from "./status.js";
import { appendTaskTimeline } from "./task-timeline.js";

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

// ── 占位世代 ─────────────────────────────────────────────────────────────────
// taskId → 它当前那一代占位的号。认领成功时发号,回滚落地后清掉(理由见模块头)。
const seatGen = new Map<string, number>();
let nextSeatGen = 0;

/**
 * 这个任务此刻有没有**活着的**执行占位,有的话是哪一代。0 = 没有。
 *
 * 给 scheduler 的 `reclaimStrandedSeat` 用:它收的是「没有任何 seat 认领的 queued 遗留」
 * (advanceQueue 自己 setQueued 的那种、以及占位写失败留下的那种)。非 0 就说明这具 queued
 * 是某个活着的 seat 的,该由那个 seat 自己的 release() 负责,外人不许替它回滚。
 */
export function seatGeneration(taskId: string): number {
  return seatGen.get(taskId) ?? 0;
}

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
  | {
    ok: false;
    blockers: string[];
    /** 数据库临时故障,不是同队在跑。 */
    transient?: boolean;
    /** 挡路的是**这个任务自己的另一代占位**(见模块头),不是同队别的成员。 */
    self?: boolean;
  };

// 手动启动入口(/run、/fire、/retry、重跑上一回合)的认领失败话术。transient(数据库
// 临时故障)时必须说真话:把一次可重试的写失败报成「同队有人在跑」,用户会去等一个
// 不存在的前项(第 ll7XKsu_ps0n 链第 2 轮指出)。
export function queueClaimError(r: { blockers: string[]; transient?: boolean; self?: boolean }): string {
  // transient(数据库临时故障)和 self(这个任务自己的另一代占位)都必须说真话:套用
  // 「同队有人在跑」会让用户去等一个不存在的前项(第 ll7XKsu_ps0n 链第 2 轮指出)。
  return r.transient || r.self
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

export function writeOwnedSeatStatus(
  taskId: string,
  generation: number,
  status: Parameters<typeof setTaskStatus>[1],
  opts?: { quietAdvance?: boolean },
): Promise<boolean> {
  return setTaskStatus(taskId, status, {
    ...opts,
    expectStatus: "queued",
    commitGuard: (commit) => serializeQueueClaims(async () =>
      seatGeneration(taskId) === generation && await commit()),
  });
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
    // 同一个任务不许叠第二代占位(理由见模块头)。检查和发号在同一个临界区里,所以这
    // 一问是原子的 —— 出了这段才问就又回到了「两条入口各读到一次空闲」。
    if (seatGeneration(taskId) !== 0) {
      return {
        ok: false,
        self: true,
        blockers: ["这个任务已经有另一条启动路径占着执行位，等它那一轮起完再试"],
      };
    }
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
    const gen = (nextSeatGen += 1);
    seatGen.set(taskId, gen); // 发号要在临界区里:出了这段就可能有人认领下一代
    return { ok: true, seat: makeSeat(taskId, item.queueId, prevStatus, gen) };
  });
}

/**
 * 延期回滚最多再排几次。每一次重排都要等一个完整的「占锁 → 放锁」周期,所以现实里它本就
 * 收敛;这个上限只为挡住病态的来回(两个入口在同一个释放点上反复互相接手)。到顶**不是
 * 撒手**:清掉号码并把补偿交给 scheduler,见模块头「号码不许在没人接手时留着」。
 */
const MAX_ROLLBACK_DEFERRALS = 5;

function makeSeat(taskId: string, queueId: string, prevStatus: string, gen: number): QueueSeat {
  let released = false;
  const mine = () => seatGen.get(taskId) === gen;
  const clearGen = () => { if (mine()) seatGen.delete(taskId); };

  /**
   * 本 seat 不再为这具占位负责了。**清号和交接必须成对**:只清号,没人会来收;只交接,
   * scheduler 看见非零号码会在读库之前就让位(第 2 轮审查 F2)。
   */
  const handOff = (why: string): void => {
    clearGen();
    console.warn(`[ash] 队列占位回滚交给 scheduler 兜底(${taskId}):${why}`);
    // 动态 import:scheduler 静态依赖本模块。repush:"never" —— 本模块的调用方全是带自身
    // 语义的入口,补办重推会把 /fire 的「全新一轮」偷换成续跑旧会话(见 claimQueueSeat)。
    void import("./scheduler.js").then(({ reclaimStrandedSeat }) =>
      reclaimStrandedSeat(taskId, queueId, prevStatus as Parameters<typeof reclaimStrandedSeat>[2], { repush: "never" }),
    ).catch((err) => console.error(`[ash] 队列占位回滚交接失败(${taskId}):`, err));
  };

  const rollback = async (deferrals: number): Promise<void> => {
    // 换代了 = 后面又有人认领过占位,库里那个 queued 是**他的**,不是我当初占的那个。
    // 这一代已经不归我管,交接也不该做(新 seat 自己负责)。
    if (!mine()) return;
    // **占住回合锁再提交**(理由见模块头):占不到 = 有人正拿着这个占位起跑,排到它释放
    // 之后再看。注意 endTurn 是按注册顺序跑回调的,排在我前面的合法回调会先抢到锁 ——
    // 那正是对的,我重排就是了。
    const releaseLock = claimNonTurn(taskId, SEAT_ROLLBACK_ROLE);
    if (!releaseLock) {
      if (deferrals >= MAX_ROLLBACK_DEFERRALS) { handOff("重排已达上限"); return; }
      whenTurnIdle(taskId, () => void rollback(deferrals + 1));
      return;
    }
    try {
      // 条件写(理由见模块头「回滚的所有权」):
      //   · `expectStatus: "queued"` —— 库里已经不是 queued 就是有权威后来者改过了
      //     (真实结算覆盖、用户点停止),这一笔过期;
      //   · 代次在共用认领链内核验,互斥覆盖实际提交而不只是同步读取 Map。
      // 广播与提交在同一临界区;队列推进异步排在后面,不等待重入认领链。
      const committed = await writeOwnedSeatStatus(
        taskId,
        gen,
        prevStatus as Parameters<typeof setTaskStatus>[1],
      );
      // 没提交也要清号:要么这具占位已经不是我的(clearGen 自带 mine() 保护,不会误清
      // 后来者的号),要么它已被别人收走 —— 两种都意味着我这一代不再需要负责人。留着
      // 号码等于让 scheduler 兜底在读库之前就让位,任务永久「排队中」(第 2 轮审查 F2)。
      clearGen();
      if (!committed) {
        console.warn(`[ash] 队列占位回滚已过期,未提交(${taskId}):库里不再是我这一代的 queued`);
      }
    } catch (err) {
      // 读或写失败:号码留着就没人会来收了,交给 scheduler 带重试的那条路。
      handOff(`回滚出错(${err instanceof Error ? err.message : String(err)})`);
    } finally {
      releaseLock();
    }
  };

  return {
    taskId,
    prevStatus,
    async release() {
      if (released) return;
      released = true;
      // 锁空着就当场回滚,被占着就排到它释放之后(判据与理由都在 rollback 里)。
      //
      // `void` 不 await:本函数可能在队列认领的临界区内被调用,await 一个会触发
      // advanceQueue 的回滚就会死等自己(见模块头的 ⚠)。
      if (isTurnClaimed(taskId)) {
        whenTurnIdle(taskId, () => void rollback(1));
        return;
      }
      await rollback(0);
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
): Promise<{ ok: true } | { ok: false; blockers: string[]; transient?: boolean; self?: boolean }> {
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
    .catch(async (err) => {
      console.error(`[ash] 任务 ${taskId} 启动异常:`, err);
      await appendTaskTimeline(taskId, `本次启动失败，未能继续执行：${err instanceof Error ? err.message : String(err)}。可稍后重试运行。`);
    })
    .finally(() => { if (seat) void seat.release(); });
  return { ok: true };
}

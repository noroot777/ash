// 「这一轮审查的任务书到底送进会话了没有」—— 派发这一问收在这个文件里。
//
// 派发是**两段式**的:`launchReviewRound` 同步地建好 run/round 行、写下「审查开始」,真正的
// 投递却交给 `continueWhenIdle` —— 它排进回合锁的等待队列,等这个任务当前那一轮退干净,才在
// 释放点上抢锁、起旁路回合。两段之间隔着一整轮的时长。
//
// 老写法在第二段上只有一次机会:抢锁失败就走 `onError` → `failReviewStart`,round 落 error、
// run 落 failed,**终态**。而抢锁失败是个纯瞬时条件 —— 同一个释放点上注册在前的那条 waiter
// 先同步抢走了锁(`endOwnTurn` 按注册顺序放 waiter 走),谁先注册纯属时序运气。
//
// 2026-10-31 的实例(任务 IZk5yKUHpR2G,run QHyF0WKIgo_h):修复回合 02:46:18 结束 → 预约复审
// 02:46:19.231 写下「第 1 轮审查开始」→ 02:46:19.379(148ms 后)「启动失败:回合被其它执行抢占,
// 消息未能投递」。预约在启动前就已被 CAS 消费掉,于是自动链就地停住,要用户手动再开一轮。
// **瞬时条件不该变成永久失败**,这个文件就是那条修法:
//
//   ① 抢锁失败不落终态 —— 把意图重新排进下一个空闲窗口(`hand` 的递归);
//   ② 有界 —— 连输 `MAX_REVIEW_DISPATCH_ATTEMPTS` 次才放弃,放弃时的终态带着「输了几次」;
//   ③ 有痕 —— 每一次重排和最终放弃都写时间线(持久,刷新后还在;不是 toast);
//   ④ 触发不止一条 —— 重排走的是回合锁自己的 `afterTurn`,所以**凡是放锁都会放它走**:持有者
//      自己的 finally、人工放开(`POST /tasks/:id/reclaim-turn`)、幽灵锁巡检的
//      `forceReleaseTurn` 全走 `endOwnTurn`。只挂「下次执行回合正常结束」是不够的 —— 那次实例
//      里抢赢的就有可能是个占了锁什么都不起的幽灵,它永远没有「下一次回合结束」。
//
// 后来补上的两条不变量,它们各自都曾把上面四条抵消掉(第 1 轮审查 F1/F2):
//
//   ⑤ **在途 ≠ 没在干活** —— 「本进程还盯着」必须是恢复状态机里独立的一档(`in-flight`),对账
//      看到它要 `continue`。并进「没有意图」那一档的话,合法排队中的审查会在约 30 秒后被周期
//      对账按孤儿收尸,自动链照样断。而认领必须是**同步** test-and-set(`claimReviewDispatch`):
//      补办要重走一长串 await,只在开头读一次等于没有占位,两个恢复入口会各排一份同样的任务书。
//   ⑥ **投递的凭据取在「原话落盘」那一刻**,不是整轮跑完 —— 后者要等审查者跑几十分钟才
//      resolve,这中间服务断掉,新进程看到挂着的意图就会对一条已经执行过的审查整份重投。
//
// ## 为什么界是「次数」而不是「时长」
//
// 这一侧等的是**另一个回合跑完**,而回合的时长没有上界(一轮审查几十分钟,duet 的人工裁决门
// 按小时算)。给它一个墙上时钟的截止时间,等于在慢任务身上重新造出原来那个缺陷 —— 审查明明
// 还在合法排队,却被判死。次数才是这里唯一有意义的界:**每一次计数都对应一次真实的锁释放,
// 而我们在那一次里输了**。连输五次说明不是运气而是系统性的(比如一串排队消息在同一个任务上
// 反复抢位),那才值得落终态让用户来看。
//
// ## 与幽灵锁修复的分工
//
// 那一侧(CKjeps4QSRTE)治「赢家占着锁不干活」,这一侧治「输家一次就放弃」。两者独立成立:
// 幽灵修好了,也仍然会有合法的赢家让我们输一次;重排做好了,也仍然需要有人把幽灵锁放开,
// 否则重排等的那次释放永远不来。
import { and, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeReviewRounds, type FreeReviewDispatchIntent } from "./db/schema.js";
import { continueWhenIdle } from "./runs.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";

type ContinueOpts = import("./task-continue-options.js").ContinueTaskOptions;

/**
 * 连输几次才放弃把这一轮交出去。
 *
 * 为什么 5 够:每一次计数都对应一次真实的锁释放,而正常现场里同一个释放点上的竞争者是**个位
 * 数**(排队消息投递、队列补推、这一条审查)。输五次意味着每一次释放都有人比我们先注册,那不
 * 是运气,是系统性的,该让用户看见而不是继续静静重排。
 *
 * 可调(`ASH_REVIEW_DISPATCH_ATTEMPTS`):回归要测「次数用尽」那一条,照 `ASH_SUSPECT_TURN_MS`
 * 同一口径从环境读。
 */
export const MAX_REVIEW_DISPATCH_ATTEMPTS = (() => {
  const configured = Number(process.env.ASH_REVIEW_DISPATCH_ATTEMPTS);
  return Number.isInteger(configured) && configured > 0 ? configured : 5;
})();

/**
 * **本进程此刻还盯着的那些派发** —— key 是「哪条 run 的哪一轮」。
 *
 * 为什么必须有这张表:`reconcileFreeReviews` 每 30 秒跑一次(`startRegressionSettlementRecovery`),
 * 它看到的「run 是 reviewing + round.dispatch 非空」有两种完全不同的现场:
 *  · 本进程正排着等窗口 —— 碰它就是**重复投递**(同一轮任务书送两遍);
 *  · 上一个进程排着、进程没了 —— 不碰它就**永远没人补办**。
 * 库里那一行分不出这两者(它们长得一模一样),只有「这个进程的内存里还armed 着吗」能分。
 */
const armed = new Set<string>();

const keyOf = (runId: string, round: number): string => `${runId}#${round}`;

/** 这条 run 的这一轮,**本进程**是否还盯着它的派发。给对账路径问(见 `armed`)。 */
export function reviewDispatchArmed(runId: string, round: number): boolean {
  return armed.has(keyOf(runId, round));
}

/**
 * **抢下「这一轮的补办归我」** —— 同步的 test-and-set,没抢到返回 false。
 *
 * 为什么非得有这一下:补办要重走整个 `launchReviewRound`(证据目录、工作区、MCP 预检、
 * 任务书重算),那是一长串 await。只在开头读一次 `reviewDispatchArmed` 等于没有占位 ——
 * 两个恢复入口(30 秒定时对账、单任务中断恢复、答复提问各有一条路)落在同一段时间里,
 * 都会读到「没人盯着」,各排一份同样的任务书。认领必须排在**任何 await 之前**,所以它是
 * 同步的,也必须就是 `armed` 这同一张表 —— 否则「谁在途」会有两个彼此不同步的答案。
 */
export function claimReviewDispatch(runId: string, round: number): boolean {
  const key = keyOf(runId, round);
  if (armed.has(key)) return false;
  armed.add(key);
  return true;
}

/** 认领了却没能交出去(补办在准备阶段就抛了):把认领还回去,否则这一轮在本进程里永远「在途」。 */
export function releaseReviewDispatchClaim(runId: string, round: number): void {
  armed.delete(keyOf(runId, round));
}

/**
 * 写下/刷新这一轮的派发意图。
 *
 * 落库失败**不拦路**:这一刻 `continueWhenIdle` 的 waiter 已经(或马上)挂上了,同进程的重排
 * 不靠这一行;它欠的只是「跨重启还能补办」与「放弃时说得出输了几次」。为此把整次派发判成失败,
 * 等于用一次库故障换掉一轮本来跑得动的审查。
 *
 * (这一点与 `queue_advance_intents` 的口径刻意不同:那边的推进是**丢出去就不管**的后台动作,
 * 凭据没落下就真的没有任何人会补办,所以必须抛;这边第二段的等待者是活的。)
 */
async function writeIntent(runId: string, round: number, intent: FreeReviewDispatchIntent): Promise<void> {
  await db.update(freeReviewRounds).set({ dispatch: intent })
    .where(and(eq(freeReviewRounds.runId, runId), eq(freeReviewRounds.round, round)))
    .catch((error) => console.error(`[ash] 审查派发意图落库失败 run=${runId} round=${round}:`, error));
}

/**
 * 这一轮的派发有了结局(送进会话了,或者次数用尽放弃了):意图到此了结。返回是否真的清掉了 ——
 * 调用方要靠它决定敢不敢放手(见 `settled`)。
 *
 * **只清自己那一行**(run+round),不按 taskId 扫:同一个任务上同时只有一条审查链在跑,但
 * 对账路径可能正拿着另一轮的快照在手里。
 */
export async function clearReviewDispatchIntent(runId: string, round: number): Promise<boolean> {
  return await db.update(freeReviewRounds).set({ dispatch: null })
    .where(and(eq(freeReviewRounds.runId, runId), eq(freeReviewRounds.round, round)))
    .then(() => true)
    .catch((error) => {
      console.error(`[ash] 审查派发意图清理失败 run=${runId} round=${round}:`, error);
      return false;
    });
}

export type ReviewDispatch = {
  taskId: string;
  /** 这一轮属于哪条审查链的第几轮 —— 意图的身份就是这两样。 */
  run: { id: string; currentRound: number };
  /** 界面上怎么称呼这一轮(「自由工作流第 2 轮」/「合并结果」),只进时间线措辞。 */
  label: string;
  /** 送进会话的那段话。重排原样重放它 —— 同进程里不必、也不该重算。 */
  message: string;
  opts: ContinueOpts;
  /** 跨重启补办要原样重放的三个入参(见 `FreeReviewDispatchIntent`)。 */
  resumeSessionId?: string | null;
  retry?: boolean;
  freshSession?: boolean;
  /** 已经输过几次(补办时从库里读回来);缺省 0 = 这是第一次交出去。 */
  attempts?: number;
  /** 第一次交出去的时刻(补办时沿用库里那个,别把等待时长重置掉)。 */
  since?: string;
  /** 这一轮彻底起不来了,按原路收尾(`failReviewStart`)。 */
  onFail: (message: string) => Promise<unknown>;
};

/**
 * 把这一轮的任务书交给回合锁,**抢不到就重排**,直到送进会话或者次数用尽。
 *
 * 同步返回(与 `continueWhenIdle` 一样是「排进去就回来」):第二段的结局通过 `onFail` 与时间线
 * 交代,调用方不等它。
 */
export async function dispatchReviewRound(dispatch: ReviewDispatch): Promise<void> {
  const { taskId, run, label } = dispatch;
  const key = keyOf(run.id, run.currentRound);
  const since = dispatch.since ?? now();
  let attempts = dispatch.attempts ?? 0;

  /**
   * 这一轮的派发收摊 —— **先清库、再放内存**,顺序是这两步的全部要点。
   *
   * 「库里挂着意图」和「内存里有人盯着」是对账区分「该补投」与「别碰」的唯一一对线索
   * (`reviewDispatchRecovery`)。反过来写就会开出一个两边都说「没人在途」的窗口:对账的 30 秒
   * 定时器正好落在里面,就会对着一条**刚刚送进会话**的审查再投一次任务书。
   *
   * 清库没成功就**不放手**:那一行还挂着,内存这一侧就得继续认领它,代价只是一条 Set 记录
   * 活到进程结束。
   */
  const settled = async (): Promise<void> => {
    if (await clearReviewDispatchIntent(run.id, run.currentRound)) armed.delete(key);
  };

  const giveUp = async (message: string, failure: string): Promise<void> => {
    await settled();
    await dispatch.onFail(message);
    console.error(`[ash] ${label}派发放弃 task=${taskId} run=${run.id} attempts=${attempts}: ${failure}`);
  };

  const hand = async (): Promise<void> => {
    attempts += 1;
    // 同样的顺序,反方向:**先占内存、再写库**。先写库会开出「库里有意图、内存还没认领」的
    // 窗口,对账落在里面就会抢着补投一条本进程正排着队的派发(同一个双线索判据)。
    armed.add(key);
    await writeIntent(run.id, run.currentRound, {
      attempts, since, resumeSessionId: dispatch.resumeSessionId ?? null, retry: dispatch.retry,
      freshSession: dispatch.freshSession,
    });
    continueWhenIdle(taskId, dispatch.message, dispatch.opts, async (message, failure) => {
      // 瞬时以外的四种(撤回 / continueTask 答了没送出去 / 抛错)照旧落终态:它们不是「这一刻
      // 轮不到我们」,重排只会把同一个拒绝理由再撞一遍,而撤回那一种还会磨掉用户的决定。
      if (failure !== "turn-taken") return giveUp(message, failure);
      if (attempts >= MAX_REVIEW_DISPATCH_ATTEMPTS) {
        return giveUp(
          `${message}；已连续重排 ${attempts} 次（每次都在回合锁的释放点上被其它执行先抢到），不再重试`,
          failure,
        );
      }
      // 留痕排在重排**之前**:重排是同步排进等待队列的,排完下一次失败可能立刻就到,先写时间线
      // 才保证顺序读得通。
      await appendTaskTimeline(taskId,
        `${label}的任务书还没能送进会话：回合锁在释放点上被其它执行先抢到（第 ${attempts} 次）。`
        + `已重新排到下一个空闲窗口，不需要你动手；连续 ${MAX_REVIEW_DISPATCH_ATTEMPTS} 次都抢不到才会停下来。`);
      await hand();
    }, async () => {
      // 真的送进会话了 —— 意图到此了结。这一声取在**原话落盘**那一刻(而不是整轮跑完,
      // 理由在 `continueWhenIdle` 的 `onDelivered` 上):取后者的话,这一轮审查跑着的几十
      // 分钟里库里都挂着意图,服务在中间断掉,新进程就会对一条**已经执行过**的审查整份重投。
      await settled();
    });
  };

  await hand();
}

/**
 * 上一个进程死在「交出去了、还没送进会话」中间的那些轮次 —— 这一轮该怎么办。
 *
 * 四档,每一档对应一个**不同的动作**,合并任意两档都会出事:
 *
 *  · `none`      —— 压根没有在途意图(普通审查)。调用方照原路往下走。
 *  · `in-flight` —— 有意图,而且**本进程还盯着它**:它正排在回合锁的等待队列里等下一个空闲
 *    窗口。既不该补投(同一轮任务书送两遍),**也不该收尸** —— 这一条当初并进 `none` 过,于是
 *    合法排队中的审查落回对账的通用收尸路,约 30 秒后自己 failed、自动链照样断在那里
 *    (第 1 轮审查 F1)。「有人负责等待」不等于「没有在途工作」。
 *  · `redeliver` —— 有意图、没人盯着(= 上一个进程没了):补投一次。
 *  · `exhausted` —— 同上,但次数已经用尽:落终态,并且**说得出一句理由**。并进 `none` 的话这
 *    一轮会落回通用收尸路,用户只看到「审查未能正常给出结论」—— 而真相是「任务书连一次回合
 *    窗口都没抢到」,两句话对他下一步该做什么的指示完全不同。
 *
 * 判据故意不含「任务忙不忙」:那一问由 `reconcileFreeReviews` 在它自己那一串判据里回答过了
 * (reviewer 还活着就压根走不到这里)。
 */
export type ReviewDispatchRecovery =
  | { kind: "none" }
  | { kind: "in-flight" }
  | { kind: "redeliver"; intent: FreeReviewDispatchIntent }
  | { kind: "exhausted"; intent: FreeReviewDispatchIntent };

export function reviewDispatchRecovery(
  runId: string, round: number, intent: FreeReviewDispatchIntent | null | undefined,
): ReviewDispatchRecovery {
  if (!intent) return { kind: "none" };
  if (reviewDispatchArmed(runId, round)) return { kind: "in-flight" };
  return intent.attempts < MAX_REVIEW_DISPATCH_ATTEMPTS
    ? { kind: "redeliver", intent }
    : { kind: "exhausted", intent };
}

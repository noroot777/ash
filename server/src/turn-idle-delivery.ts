// 「等这个任务当前这一轮退干净，再把下一条输入送进它的会话」—— 这条唯一安全的续跑路。
//
// 从 `turn-lock.ts` 搬出来的理由跟那边当初从 runs.ts 搬出来的一样实:那边是「谁有权开始下一
// 轮」这把锁本身(占位、冻结、放 waiter),这边是**排到队头之后的那一整套交接** —— 占位、
// 所有权闸、冻结复查、投递回执、四种失败分类。两摊的使用方几乎不重叠,挤在一起那个文件已经
// 到 691 行、顶着 700 行上限(第 1 轮审查要加的所有权闸就加不进去了)。
//
// **老使用方照旧从 `runs.js` import**:那边把这里的导出原样转出去。依赖单向 —— 这个文件
// 只向 `turn-lock.js` 借锁,锁那边不认识这里。
import {
  claimOwnTurn, releaseTurn, turnSourceRole, turnSourceReview, whenTurnIdle, type TurnSource,
} from "./turn-lock.js";
import type { TurnStartDecline } from "./task-continue-options.js";
// 运行时依赖只有这一个纯函数模块(它自己只引类型),不碰 orchestrator —— 那一条留给下面的 dynamic import。
import { lastWordOnInput, type InputAcceptance } from "./turn-input-acceptance.js";
import type { ReviewStartReceipt } from "./review-start-withdrawal.js";

/**
 * **这一次投递为什么没成功** —— 四种原因里只有 `turn-taken` 是**瞬时**条件。
 *
 * 为什么必须分开报:四种在调用方眼里完全不是一件事,而老签名只给一个字符串,于是每个调用方
 * 都只能一视同仁地落终态。瞬时那一种因此被当成永久失败(2026-10-31 实例 IZk5yKUHpR2G:
 * 预约复审建好 run 之后 148ms 落 failed,只因为同一个释放点上另一条 waiter 先抢到了锁)。
 *
 *  · `turn-taken`   —— 排到队头时 `claimOwnTurn` 失败。**此刻锁在别人手上**,而这一侧到这
 *    一刻一个字节都没动(没查库、没建会话、没碰状态),所以重排是安全的;而且锁总会被还回来
 *    (持有者自己的 finally,或人工放开 / 幽灵锁巡检的 `forceReleaseTurn` —— 它们走的也是
 *    `endOwnTurn`,一样会放 `afterTurn` 的 waiter 走),所以「排到下一个空闲窗口」一定还有
 *    下一次机会。
 *  · `withdrawn`    —— 起跑前的冻结闸撤回(分组已暂停 / 任务已归档或删除)。那是用户的动作,
 *    重排只会把它的决定磨掉。
 *  · `not-delivered`—— `continueTask` 自己答了「一个字没送出去」,而且是**重排也没用**的那几种
 *    (历史审查退役、接力出去的存档、验收互斥、检查点待恢复、唤醒资格不再成立、读不到状态)。
 *    它们都确证没送出去,但重排是原地再撞同一个拒绝理由。
 *  · `uncertain`    —— `continueTask` 答了「这个任务上挂着一次**说不清有没有投喂**的交付」。
 *    一个字都不许重投,而且报给用户的话里不许出现「一个字都没送出去」。
 *  · `failed`       —— 抛了。
 *  · `superseded`   —— 排到队头时**这一笔交接已经不归调用方负责了**(`ownership` 闸给的答复)。
 *    跟 `turn-taken` 一样一个字节都没动,但出路相反:重排只会把同一笔过期交接再排一遍,而
 *    落终态会把**现任**负责的那一次打死。所以调用方该做的是就地让出(见 free-review-dispatch
 *    的 `handOff`)。
 */
export type TurnDeliveryFailure =
  "turn-taken" | "withdrawn" | "not-delivered" | "uncertain" | "failed" | "superseded";

/**
 * `continueTask` 那个 false 的原因 → 这一层的失败分类。
 *
 * 为什么必须有这张表(第 1 轮审查问题 2):`continueTask` 的 false 原先在这里被**一律**压成
 * `not-delivered`,而它的成因里有一种是**瞬时**的 —— 外层在这里占到了锁,交接到内层
 * `reclaimTurn` 之间隔着所有权闸、冻结复查、起跑预检,这把锁完全可以在那期间被合法放开、
 * 另一回合占上。那一种和「这一刻轮不到我们」(上面 `turn-taken`)是同一件事,出路也该一样:
 * 重排。实测压扁的代价:一次这样的争用就让整轮审查 run=failed / round=error,只尝试过 1 次。
 *
 * 反过来「所有 false 都重排」也是错的,所以这里是一张**逐档**的表,不是一个兜底。
 */
const DELIVERY_FAILURE: Record<TurnStartDecline, { failure: TurnDeliveryFailure; message: string }> = {
  "turn-taken": { failure: "turn-taken", message: "回合被其它执行抢占，消息未能投递" },
  withdrawn: { failure: "withdrawn", message: "这一轮在起跑前被撤回，消息未能投递" },
  backoff: { failure: "not-delivered", message: "这一轮此刻起不来（起跑前的闸没放行），消息未能投递" },
  uncertain: {
    failure: "uncertain",
    // 不许说「一个字都没送出去」:这个任务上悬着的那一次交付到底有没有执行,此刻谁都不知道。
    message: "这个任务上还挂着一次无法确认是否已执行的交付，这一轮没有起跑",
  },
};

/**
 * 交接成功之后,**这一轮的输入到底有没有进 agent 手里** —— 三档裁决,每档一个出口,三个都必填。
 *
 * 这里从前是一个 `onDelivered`:`continueTask` 那一声「落盘了」叫一次,整轮返回还没叫过就兜底再
 * 叫一次(「按已投递了结」)。那正是上游把 `onDelivered` 改名成三态 `onInputSettled` 要杀的歧义
 * (task-continue-options.ts 那段 F2/F3:把「回调被调到」读成「已送达」)—— 它在这一层换了个
 * 名字照样活着:协议层**明确拒收**的那一轮,整轮返回之后被兜底当成送到,派审那一侧据此把在途
 * 意图了结掉,这一轮审查从此既没人重投、也没人说得出它其实一个字都没收到。
 *
 * 三个都必填,用意与上游改名相同:让每个调用点在编译期把三档各自想一遍。
 *  · `onAccepted`    —— 协议层收下了。回执一落定就报(正常是原话落盘之后几百毫秒),**不等这一轮
 *    跑完**:一轮审查几十分钟,等整轮的话持久意图一直挂着,服务在中间一断,新进程就会对一条已经
 *    执行过的审查整份重投(第 1 轮审查 F2)。
 *  · `onRefused`     —— 确证一个字都没进去,原文可以放心重投。**这一轮结束之后**才报:被拒收的那一
 *    轮此刻还在收尾,调用方现在就去落终态或重排,会和它自己的结算抢同一批状态。
 *  · `onUnconfirmed` —— 这一轮已经结束,回执仍然说不上来(写出去了没等到应答;或者压根没走到交接
 *    回执那一步 —— 起跑在 spawn 之前就失败了,失败交代由 `continueTask` 自己写)。**既不是成功也
 *    不是失败**:不许据此了结任何东西,也不许据此重投;该做的是把「我在盯着」这句话收回来,交给
 *    持久凭据和对账去判。
 *
 * `onAccepted`/`onRefused` 合起来**至多一次**(协议定论单调,先落定的算)。`onUnconfirmed` 至多一次,
 * 但它之后**仍可能迟到一句定论**(回执在有界等待之外才落定,见 turn-input-acceptance.ts)——
 * 所以三档的处置都必须幂等。
 *
 * 不传 = 调用方没有要了结的账(就地验证、打回重做、验收交接这几条):这一轮的成败由它自己的
 * 结算钩子收口,这里只记日志。`onError` 管的始终只是「这一轮没起来」那一族(见 `TurnDeliveryFailure`),
 * 不会被拿来报「跑过了、输入被拒收」—— 那些调用方的失败回调是按「启动失败、一切回滚」写的,
 * 在一轮已经结算过之后再回滚一次,会把它结算出来的新状态抹掉。
 */
export interface IdleDeliveryVerdict {
  onAccepted: () => void | Promise<unknown>;
  /**
   * `input` = 被拒收的**那一次输入**的起跑收据(审查回合才有)。拒收是这一次输入的事实,不是整轮
   * 审查的事实:同一轮里它之后可能已经送进了下一次输入(答复提问、检查点续跑),那时这句迟到的
   * 拒收只说明旧输入没进去,拿它去终结整轮就误杀了正在跑的那一次(free-review-round.ts 的
   * `failReviewStart`)。所以必须带着身份交出去,由落账那一侧在同一个事务里核。
   */
  onRefused: (message: string, input?: ReviewStartReceipt) => void | Promise<unknown>;
  onUnconfirmed: (message: string) => void | Promise<unknown>;
}

const REFUSED_MESSAGE = "协议层明确拒收：这一轮的输入一个字都没送进 agent，原文可以放心重投";
const UNCONFIRMED_MESSAGE = "这一轮已经结束，但拿不到「agent 收下了」的回执，送没送到说不上来";

/**
 * 一次交接的三档裁决状态机。**协议事实先记、再做任何可失败的事**(上游 895b1ea4 的同一条:回执
 * 排在本地记账之前),所以调用方自己的记账抛了也不会让这一句定论丢掉。
 */
function trackVerdict(taskId: string, hooks: IdleDeliveryVerdict | undefined) {
  /** 协议层说过的最新一句。accepted/refused 是定论,不翻盘;unknown 等后话。 */
  let fact: InputAcceptance | null = null;
  /** 这一次交接送进去的那一份输入(审查回合的起跑收据)。一个跟踪器只对应一次输入,先到先记。 */
  let input: ReviewStartReceipt | undefined;
  let receipt: Promise<InputAcceptance> | undefined;
  let turnOver = false;
  let concluded = false;
  let unconfirmed = false;
  const report = async (what: string, hook: (() => void | Promise<unknown>) | undefined): Promise<void> => {
    try { await hook?.(); } catch (error) {
      console.error(`[ash] continueWhenIdle(${taskId}) ${what}的处置失败:`, error);
    }
  };
  const conclude = async (): Promise<void> => {
    if (concluded || !fact) return;
    if (fact === "accepted") {
      concluded = true;
      return report("「agent 收下了」", hooks && (() => hooks.onAccepted()));
    }
    if (!turnOver) return; // 拒收 / 说不上来:等这一轮自己收完尾再交代
    if (fact === "refused") {
      concluded = true;
      console.error(`[ash] continueWhenIdle(${taskId}) 输入被拒收：${REFUSED_MESSAGE}`);
      return report("「协议层拒收」", hooks && (() => hooks.onRefused(REFUSED_MESSAGE, input)));
    }
    if (unconfirmed) return;
    unconfirmed = true;
    console.error(`[ash] continueWhenIdle(${taskId}) 交付说不清：${UNCONFIRMED_MESSAGE}`);
    return report("「交付说不清」", hooks && (() => hooks.onUnconfirmed(UNCONFIRMED_MESSAGE)));
  };
  const hear = (word: InputAcceptance, from?: ReviewStartReceipt): void => {
    input ??= from;
    if (fact === "accepted" || fact === "refused") return;
    fact = word;
  };
  return {
    /** `onInputReceipt`:回执本体,回合结束时再问它最后一句。 */
    keep: (promise: Promise<InputAcceptance>): void => { receipt = promise; },
    /** 同步记下协议事实(连同它属于哪一次输入)—— 必须排在调用方任何可失败的记账之前。 */
    hear,
    /** 记完、调用方记账也走过之后,按当下所知交代一次(初次与迟到都走这里)。 */
    conclude,
    /**
     * `continueTask` 交回 true:这一轮结束了。初次那一档可能是几十秒前有界等待的结果,进程关掉
     * 之后回执多半已经落定,所以结算之前再问它最后一句(同 task-resume.ts 的 finally)。没交接过
     * 回执 = 这一轮没走到 spawn 之后,`lastWordOnInput` 照样答 unknown —— 不许再被读成「送到了」。
     */
    async turnEnded(): Promise<void> {
      turnOver = true;
      hear(await lastWordOnInput(receipt, fact));
      await conclude();
    },
  };
}

/**
 * 结算钩子里给同一个任务续跑的**唯一安全写法**：等它这一轮退干净再送消息。
 *
 * 直接 `continueTask` 会被单飞锁静默挡回（结算钩子跑在 run loop 的 try 里，锁还锁着），
 * 表现是「什么都没发生」——就地验证轮起不来、打回重做的提示没人收。动态 import 是为了
 * 不让这个中立模块回头依赖 orchestrator（类型是纯类型引用，不构成运行时环）。
 */
// 入口参数的类型住在 `task-continue-options.ts`(只放类型,不放运行时 —— 这条链上的运行时
// import 要留给那句 dynamic import)。
type ContinueOpts = import("./task-continue-options.js").ContinueTaskOptions;

export function continueWhenIdle(
  taskId: string,
  text: string,
  opts: ContinueOpts = {},
  onError?: (message: string, failure: TurnDeliveryFailure) => void | Promise<unknown>,
  /** 交接成功之后那三档裁决各自交给谁(见 `IdleDeliveryVerdict`)。 */
  verdict?: IdleDeliveryVerdict,
  /**
   * **起跑前的最后一道闸:这一笔交接现在还归我吗** —— 返回理由字符串 = 不归了,一个字都别送。
   *
   * 为什么光有回合锁不够:这一侧在等待队列里排的那段时间,调用方那边的**派发所有权**完全可以
   * 换过人(用户重跑了这一轮、另一条恢复路接手了同一份意图)。回合锁只回答「此刻谁能开始跑一
   * 轮」,它对「这一轮该由哪一次派发来跑」一无所知 —— 于是过期的那一笔照样能在释放点上抢到锁,
   * 把一份作废的任务书送进会话:同一轮审查被交付两次,而审查者那边刚提了问题还没等到答复
   * (第 1 轮审查问题 1 实测:同一轮 invocations 由 1 增至 3)。
   *
   * **排在 `claimOwnTurn` 之后、冻结复查与投递之前**:拿着锁问才问得准(问完到动手之间没有
   * 别人能插进来起一轮);不归我的话随后把锁原样还掉,等待队列里**现任**那一笔照常被放走。
   * 闸是异步的,因为「还归我吗」的权威有一半在库里(那份在途意图此刻属于谁)。
   */
  ownership?: () => Promise<string | null>,
): void {
  whenTurnIdle(taskId, () => {
    // 排到队头的一瞬间**同步**锁定所有权（turnHeld 传递给 continueTask 接管）：不占的
    // 话，异步 import 的间隙里同一释放点的后续 waiter 能同步抢锁——投递「not delivered」
    // 而调用方可能已提前写下状态（审查实测 3/3：dispatch 释放点被竞争 waiter 抢先，
    // 任务留在 stage=verifying 而验证从未启动）。
    // **占位的那一刻就把「谁起的、为哪一次审查而起」一起交代清楚**:派审那一侧此刻手里正握着
    // run 和轮次,而创建入口过后只能查「现在是哪一次」—— 那两者在派审交接期并不是同一个
    // (第 10 轮审查 F1)。两样同在一个 `TurnSource` 里,所以这里不可能只带到一半。
    const source = (opts as { turnSource?: TurnSource | null }).turnSource ?? null;
    // 占到的那份身份一路带到下面两条释放出路上:从这里到它们之间隔着 `await import`、
    // 隔着一次查库,人工放开完全可以在那段间隙里把这把锁拔走、另一轮合法占上(见
    // `endOwnTurn`)。按任务 id 还锁撤掉的就是后来者那把。
    const owner = claimOwnTurn(taskId, turnSourceRole(source), turnSourceReview(source));
    if (!owner) {
      console.error(`[ash] continueWhenIdle(${taskId}) not delivered: turn re-claimed`);
      // **瞬时**:锁此刻在别人手上,而这一侧一个字节都没动。分类交给调用方决定要不要重排
      // (见 `TurnDeliveryFailure`);不想重排的照旧按失败收场,行为与老签名一致。
      //
      // 这一声不等它(重排是异步的,等于等整条链),但 rejection 必须接住:底下另外几条出路都
      // try/catch 过,只有这一条漏着 —— 重排路上任何一步抛出来就是一条没人接的 rejection
      // (进程级 unhandledRejection),而那一侧的清理也跟着跳过(第 3 轮审查 F3)。
      void Promise.resolve(onError?.("回合被其它执行抢占，消息未能投递", "turn-taken"))
        .catch((error) => console.error(`[ash] continueWhenIdle(${taskId}) 抢占后的重排处理失败:`, error));
      return;
    }
    const tracked = trackVerdict(taskId, verdict);
    void import("./turn-freeze.js")
      .then(async ({ turnFreezeReason }) => {
        // 所有权排在冻结之前:不归我的那一笔,连「用户有没有撤回」都不该由它来问 —— 它问出
        // 来的答案会被当成**现任**那一笔的撤回理由上报上去。
        const superseded = ownership ? await ownership() : null;
        if (superseded) {
          releaseTurn(taskId, owner);
          console.error(`[ash] continueWhenIdle(${taskId}) superseded: ${superseded}`);
          return { failure: "superseded" as const, message: superseded };
        }
        // 这条路上的启动**全是系统发起的**（就地验证、自由派审、修复、验收冲突叫醒），
        // 而且都是「先占位登记、释放点之后才真起跑」的交接：从调用方那次预检查到这里，
        // 中间隔着上一整轮，用户完全可能已经把分组暂停、把任务删了或归档了。
        //
        // 内存里的起跑冻结标记在这条路上**指望不上**：`pauseGroup` 冻的是占位那一个
        // 回合（dispatch），占位方的 finally `releaseTurn` 会连着标记一起清掉——接棒的
        // 真实回合什么都看不到，于是「暂停已经 200 返回，reviewer 照样被拉起来」
        //（第 4 轮审查确定性复现）。所以这里按事实查库权威复查一次。
        const freeze = await turnFreezeReason(taskId, true);
        if (!freeze) {
          /** 内层说的「为什么没起跑」。它和那个 false 同一笔交回来(见 `DELIVERY_FAILURE`)。 */
          let declined: TurnStartDecline | null = null;
          const delivered = await (await import("./orchestrator.js"))
            .continueTask(taskId, text, {
              ...opts,
              turnHeld: owner,
              onDecline: (reason) => { declined = reason; },
              onInputReceipt: (promise) => {
                tracked.keep(promise);
                opts.onInputReceipt?.(promise);
              },
              // 三档、初次与迟到都会进来(契约见 task-continue-options.ts)。顺序:协议事实先记 →
              // 调用方自己的记账(排队消息标 sent 那一类)→ 再交代裁决。调用方记账抛了不拦裁决:
              // 「agent 收没收下」是协议事实,不因为本地一笔账没记上就变成另一档。
              onInputSettled: async (acceptance, reviewInput) => {
                tracked.hear(acceptance, reviewInput);
                try { await opts.onInputSettled?.(acceptance, reviewInput); } catch (error) {
                  console.error(`[ash] continueWhenIdle(${taskId}) 调用方的投递记账(${acceptance})失败:`, error);
                }
                await tracked.conclude();
              },
            });
          // continueTask 返回 false = 一个字都没送出去（验收互斥退避等）。吞掉它，
          // 调用方的时间线就会停在「意见已发回会话」而消息实际没了——必须当失败上报。
          //
          // **按它自己给的原因分档**,不替它猜:那一侧确证一个字节都没动的瞬时抢占(内层
          // `reclaimTurn` 没接上)和用户撤回压成同一个 `not-delivered`,就是第 1 轮审查
          // 问题 2 —— 一次合法的锁交替让整轮审查落了终态。原因缺席(老调用路径、或者那边
          // 漏报)时照旧按 `not-delivered` 走,行为与改之前一致。
          if (delivered === false) {
            const classified: TurnStartDecline | null = declined;
            const mapped = classified ? DELIVERY_FAILURE[classified] : null;
            console.error(`[ash] continueWhenIdle(${taskId}) not delivered: ${classified ?? "原因未报"}`);
            return mapped ?? { failure: "not-delivered" as const, message: "回合被其它执行抢占，消息未能投递" };
          }
          return null;
        }
        // 撤回，且**不标停止落位**：这一轮一个字都没送出去，任务状态还停在上一轮的终态，
        // 标了就会被下一次真启动误读成「上一轮是被停的」。当作投递失败上报，调用方那套
        // 回滚（清 verifyRound、复位 stage、写时间线）才跑得到——不然任务会永久卡在
        // 「正在验证」而验证从未开始。
        releaseTurn(taskId, owner);
        console.error(`[ash] continueWhenIdle(${taskId}) withdrawn: ${freeze.reason}`);
        // **撤回不再冒充 delivered**:老代码在这儿先 `onError` 再 `return true`,靠「true 不等于
        // false」绕过下面那道判定 —— 于是「送出去了」和「被撤回了」在返回值上长得一模一样,
        // 新接进来的成功回调会在撤回时也被叫一次(那正是持久意图被误了结的形状)。
        return { failure: "withdrawn" as const, message: `${freeze.reason}，这一轮在启动前被撤回` };
      })
      .then(
        async (outcome) => {
          if (!outcome) {
            // 这一轮接过去、跑完了。**「跑完了」不等于「送到了」**:这里从前兜底「按已投递
            // 了结」,于是被拒收的那一轮也被当成送到。现在按协议定论交代 —— 收下的多半已经
            // 报过(这里空转),拒收/说不清的在这一刻才交代。
            await tracked.turnEnded();
            return;
          }
          try { await onError?.(outcome.message, outcome.failure); } catch { /* 上报失败不再连锁 */ }
        },
        async (error) => {
          // 只有 import 失败或 continueTask 进入自己的 try/finally 之前抛错才会到这——
          // 那两种情况下锁还是这里占的那把，必须还回去（continueTask 一旦接管，正常与
          // 失败路径都由它自己释放，不会落到这个分支）。
          releaseTurn(taskId, owner);
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[ash] continueWhenIdle(${taskId}) failed:`, error);
          try { await onError?.(message, "failed"); } catch { /* 上报失败不再连锁 */ }
        },
      );
  });
}

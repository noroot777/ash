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
 *  · `not-delivered`—— `continueTask` 自己答了「一个字没送出去」。它的几种成因(历史审查退役、
 *    接力出去、输入交付期中断的 uncertain、验收互斥退避)在这一层分不开,所以不猜,照旧上报。
 *  · `failed`       —— 抛了。
 *  · `superseded`   —— 排到队头时**这一笔交接已经不归调用方负责了**(`ownership` 闸给的答复)。
 *    跟 `turn-taken` 一样一个字节都没动,但出路相反:重排只会把同一笔过期交接再排一遍,而
 *    落终态会把**现任**负责的那一次打死。所以调用方该做的是就地让出(见 free-review-dispatch
 *    的 `handOff`)。
 */
export type TurnDeliveryFailure =
  "turn-taken" | "withdrawn" | "not-delivered" | "failed" | "superseded";

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
  /**
   * `continueTask` 真的接过了这一轮(送出去了)。
   *
   * 为什么要有它:老接口只报失败,于是「这一轮的输入到底送进会话了没有」在外面无法回答 ——
   * 而凡是把派发记成**持久意图**的调用方都要靠这一声去把意图了结掉,不然重启后的补办会
   * 对着一条已经在跑的审查再投一次任务书。
   *
   * **时机是「原话落盘」那一刻,不是这一轮跑完**:`continueTask` 要等执行器收流、结算做完
   * 才 resolve,一轮审查动辄几十分钟。取后者等于在整轮期间都把意图挂着,服务在这中间断掉,
   * 新进程看到「有意图、没人盯着」就会对一条**已经执行过**的审查整份重投(第 1 轮审查 F2)。
   * 所以这里接的是 `continueTask` 自己的 `onDelivered`(orchestrator 里 spawn + 落盘之后的
   * 那一声),整轮返回只作兜底 —— 见下面 `confirmDelivered`。
   */
  onDelivered?: () => void | Promise<unknown>,
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
    /**
     * 「这一轮的输入已经落盘」只报一次。
     *
     * 两处会叫它:`continueTask` 自己的 `onDelivered`(原话写进会话那一刻,**权威**),以及
     * 整轮返回之后的兜底 —— 后者只为「走了一条没经过那一声的投递路径」留条活路:那一轮
     * 确实跑过了,不报的话调用方的持久意图会一直挂着,重启后又整份重投一次。
     */
    let handed = false;
    const confirmDelivered = async (): Promise<void> => {
      if (handed) return;
      handed = true;
      try { await onDelivered?.(); } catch (error) {
        console.error(`[ash] continueWhenIdle(${taskId}) 投递成功的回执处理失败:`, error);
      }
    };
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
          const delivered = await (await import("./orchestrator.js"))
            .continueTask(taskId, text, {
              ...opts,
              turnHeld: owner,
              // 调用方自己的记账先走(排队消息标 sent 那一类),再报「送出去了」。它抛了就
              // 不报,留给下面的兜底 —— 那一侧还会把异常记下来。
              onDelivered: async () => {
                await opts.onDelivered?.();
                await confirmDelivered();
              },
            });
          // continueTask 返回 false = 一个字都没送出去（验收互斥退避等）。吞掉它，
          // 调用方的时间线就会停在「意见已发回会话」而消息实际没了——必须当失败上报。
          if (delivered === false) {
            console.error(`[ash] continueWhenIdle(${taskId}) not delivered`);
            return { failure: "not-delivered" as const, message: "回合被其它执行抢占，消息未能投递" };
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
            // 真的交出去了。正常路径上「原话落盘」那一刻已经报过,这里只兜底:整轮都跑完了
            // 却一声没报,说明这一轮走的是一条没经过那个点的投递路径 —— 它确实跑过,所以照样
            // 报(否则持久意图会一直挂着),但要留一行日志,别让这条异常路静默下去。
            if (!handed) console.error(`[ash] continueWhenIdle(${taskId}) 整轮已结束却没收到落盘回执，按已投递了结`);
            await confirmDelivered();
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

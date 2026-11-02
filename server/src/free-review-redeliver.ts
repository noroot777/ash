// 自由工作流审查的**崩溃补投**:上一个进程死在「任务书交出去了、还没送进会话」中间时,
// 把这一轮重新拉起来一次(`redeliverReviewRound`),以及它判「其实早就送到了」所依据的
// 持久交付凭据(`reviewPromptAlreadyDelivered`)。
//
// 从 `free-review-round.ts` 切出来的原因:那份文件已经贴着 700 行上限。依赖是单向的
// (本文件 → free-review-round.ts 取 launchReviewRound/failReviewStart),所以不成环;
// 恢复入口(`reconcileFreeReviews`、单任务中断恢复、答复提问)都只认这里这一个出口。
import { and, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeReviewRounds, regressionEvidence, tasks } from "./db/schema.js";
import { freeReviewEvidenceDir } from "./free-review-files.js";
import {
  claimReviewDispatch, clearReviewDispatchIntent, releaseReviewDispatchClaim,
  reviewDispatchRecovery, reviewDispatchVerdict,
} from "./free-review-dispatch.js";
import {
  failReviewStart, launchReviewRound,
  type ReviewRoundRow, type ReviewRunRow,
} from "./free-review-round.js";

type TaskRow = typeof tasks.$inferSelect;

/**
 * **这一轮的任务书其实已经送到审查者手上了** —— 库里那份在途意图只是没来得及清掉。
 *
 * 为什么非得问这一句:投递是两次写,而且不同事务 —— `commitReviewTurnDelivery` 先持久记下
 * `waitOwnership.deliveredReview`(紧挨着 spawn 之后),之后才经过落盘、回执,最后才清意图。
 * 服务断在这两次写中间,留下的组合就是「凭据已确认 + 意图还挂着」。只看意图的恢复会把这份
 * **审查者已经读过**的任务书整份再发一遍,白烧一轮(第 2 轮审查 F2 实测:无需任何磁盘故障,
 * 恢复即再次拉起执行器)。把回执提前到落盘那一刻只缩短了窗口,消不掉它 —— 所以恢复这一侧
 * 必须认持久交付事实为权威。
 *
 * 判据是**目录 + 代次**:目录里带着 run 与轮次,所以第 2 轮、合并结果审查各不相同;代次区分
 * 同一轮的不同次「重跑」(`reopenFailedFreeReview` 走 `restartRegressionEvidence` 换代次),
 * 上一次的旧凭据因此配不上这一次。
 */
async function reviewPromptAlreadyDelivered(task: TaskRow, run: ReviewRunRow, round: number): Promise<boolean> {
  const receipt = task.waitOwnership?.deliveredReview;
  if (!receipt) return false;
  const directory = freeReviewEvidenceDir(task.id, run.id, round);
  if (receipt.directory !== directory) return false;
  const evidence = (await db.select({ generation: regressionEvidence.generation })
    .from(regressionEvidence).where(eq(regressionEvidence.directory, directory))).at(0);
  return !!evidence && evidence.generation === receipt.generation;
}

/**
 * 上一个进程死在「任务书交出去了、还没送进会话」中间 —— 这一轮**补投一次**。
 *
 * 为什么不能让它照原路收尸:`reconcileFreeReviews` 对一条挂在 reviewing 的 run 的判词是
 * 「已经没有任何东西能把它跑完」,对**跑着跑着死掉**的那一轮是对的 —— 可对这一轮不是:它一个
 * 字都还没送出去,审查者压根没见过任务书。两者在库里长得一模一样,区别只在 round 上那份派发
 * 意图(`FreeReviewDispatchIntent`)。
 *
 * 为什么重走整个 `launchReviewRound` 而不是只重发那段话:任务书必须按**此刻**的工作区重算
 * (重启之间 HEAD 完全可能已经变了,`reviewedCommit` 也要跟着重锚),而它那几步副作用都是幂等的
 * ——证据目录 `evidenceState` 命中已有行就返回,合并结果 worktree 的 HEAD 对得上就原样复用,
 * MCP 预检只是问一句。
 *
 * 三种回答,调用方据它决定要不要往下走:
 *  · `none`    —— 这一轮没有在途意图(或者那份意图已经被别人办完了、其实早已送达),照原路对账;
 *  · `hold`    —— 有在途派发而且有人负责(本进程正排队,或另一个恢复入口刚认领走):**什么都
 *    别碰**,这一轮既不该补投也不该收尸;
 *  · `handled` —— 这一次由这里处理了(补投出去了,或者次数用尽已落终态)。
 */
export type ReviewRoundRecovery = "none" | "hold" | "handled";

export async function redeliverReviewRound(
  task: TaskRow,
  run: ReviewRunRow,
  round: ReviewRoundRow,
): Promise<ReviewRoundRecovery> {
  // 先按调用方手里那份快照粗筛:没有意图、或者本进程还盯着,都不必往下读库。
  const screened = reviewDispatchRecovery(run.id, round.round, round.dispatch);
  if (screened === "none") return "none";
  if (screened === "in-flight") return "hold";
  // **这一轮的这一次**的身份:认领、意图 CAS、清理、失败收尾全按它认人(见
  // free-review-dispatch.ts 文件头 ⑨)。证据行还没建就谈不上补办,交回原路。
  const directory = freeReviewEvidenceDir(task.id, run.id, round.round);
  const generation = (await db.select({ generation: regressionEvidence.generation })
    .from(regressionEvidence).where(eq(regressionEvidence.directory, directory))).at(0)?.generation;
  if (!generation) return "none";
  // **先同步领证,再做任何 await** —— 下面整条路是一长串异步准备(读库、证据目录、工作区、
  // MCP 预检、任务书重算),中途另一个恢复入口(定时对账 / 单任务中断恢复 / 答复提问各有一条
  // 路)完全可能也读到「没人盯着」。领证就是 `armed` 那张表,所以「谁在途」只有一个答案。
  const token = claimReviewDispatch(run.id, round.round, generation);
  if (!token) return "hold";
  // **只有「真的排进了等待队列」才把证留给派发层**,其余每一条出路(含抛异常)都在 finally 里
  // 把它还回去 —— 领了证却没人负责等待,对账见 `armed` 就跳过这一轮,库里那份没消费的意图
  // 再也没人补办,数据库早恢复健康也救不回来(第 3 轮审查 F3)。重复归还是安全的:认领证按
  // token 认人,中间若已有新一次派发接管,还掉的也不会是它那张。
  let dispatched = false;
  try {
    // **领证之后一律按库里现读的那一份办事**:调用方那个 round 是读完之后又 await 过几次才到
    // 这里的快照 —— 先到的一份恢复完全可以在这期间把任务书送出去、把意图清掉、把内存认领也
    // 放掉,我们这一份才从 await 里回来。信那份快照就会把一条**已经办完**的意图重建出来,再排
    // 一份完整任务书(第 2 轮审查 F1)。库里现读 + 下游写意图时的版本 CAS 是同一个不变量的两道。
    const current = (await db.select().from(freeReviewRounds)
      .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, round.round)))).at(0);
    const intent = current?.status === "reviewing" ? current.dispatch : null;
    const verdict = reviewDispatchVerdict(intent);
    // **「这份意图已经被别人办掉了」不能回答成「压根没有派发」** —— 后者是「照原路按孤儿往下
    // 走」的通行证,而此刻的真相恰恰相反:刚刚有人把这一轮投递出去了,审查者很可能正在输出。
    // 调用方开头那次「reviewer 还活着吗」是几次 await 之前读的,它不会再问第二遍,于是这一轮
    // 会被按孤儿落成 failed/error —— 用户看到的是「审查刚开始就提前判失败」(第 3 轮审查 F1)。
    // 答 `hold` = 这一拍的信息已经过期,什么都别做;下一拍按新读到的状态重新判。
    if (verdict === "none" || !intent) return "hold";
    // 交付凭据对得上 = 这份任务书审查者已经收到了,意图只是没来得及清:结清它,不重投。
    // 同样答 `hold`(而不是 `none`):刚投出去的那一份此刻可能正在跑,结不结算等下一拍按新状态判。
    if (await reviewPromptAlreadyDelivered(task, run, round.round)) {
      await clearReviewDispatchIntent(run.id, round.round, generation);
      console.error(`[ash] 审查任务书已确认送达，补投取消 run=${run.id} round=${round.round}`);
      return "hold";
    }
    if (verdict === "exhausted") {
      // 界用尽了才落终态,而且**说得出原因**:通用收尸那句「未能正常给出结论」会让用户以为审查者
      // 跑过、没交卷,实际上它一个字都没收到。意图由 `failReviewStart` 在终态那一个事务里一并清掉。
      //
      // 措辞只说「排了几次队」而不说「输了几次」:`attempts` 记的是**已登记的尝试**,而最后一次
      // 完全可能只排上队、还没等到释放点服务就断了 —— 那一次没有真的被谁抢走,说成「被抢 N 次」
      // 就是把没发生的事算进去了。
      await failReviewStart(run, `任务书始终没能送进会话 —— 已经排了 ${intent.attempts} 次队都没抢到空闲回合窗口（含服务重启后的补投），不再重试`, { generation });
      return "handled";
    }
    // 次数接着上一次往下数:补投也是一次尝试,否则重启反复发生时这条链会永远重投下去。
    //
    // **只有这一段的异常才算「这一轮起不来」** —— 工作区没了、MCP 没登记、任务书算不出来,
    // 落终态并写明原因是对的。上面那几步(现读、凭据查询)抛的是另一回事:见外层 catch。
    try {
      const launched = await launchReviewRound(task, run, {
        resumeSessionId: intent.resumeSessionId ?? undefined,
        retry: intent.retry,
        // 这一路的责任是上面那一段自己领的(代次现读 + 同步认领),`since` 沿用库里那一份 ——
        // 补办不是另一次派发,是同一次派发的第二次投递,等待时长不能被重置。
        responsibility: { generation, claimToken: token, since: intent.since },
        redeliver: {
          attempts: intent.attempts,
          since: intent.since,
          // 老行(加这一位之前写下的意图)没有记会话策略,按原公式回落 —— 当初唯一会把它压成
          // false 的就是补办自己,所以去掉那一项就是原值。
          freshSession: intent.freshSession
            ?? (!intent.retry && (run.currentRound === 1 || run.targetKind === "accepted_merge")),
        },
      });
      dispatched = launched.dispatched;
    } catch (error) {
      // 起不来就按原路收尾(round→error、run→failed、写明原因),和首次派发失败同一条出路。
      await failReviewStart(run, error instanceof Error ? error.message : String(error), { generation });
    }
    return "handled";
  } catch (error) {
    // **准备阶段抛的不算「这一轮起不来」,一个终态都别写** —— 现读、交付凭据查询抛出来的多半
    // 是瞬时读库故障(SQLITE_BUSY 一类),把这一轮打成 error 等于拿一次锁争用换掉一轮审查。
    // 认领在 finally 里还回去、库里那份没消费的意图原样留着,下一拍健康的对账照样能补办;
    // 答 `hold` 是因为这一拍什么都没问清,收尸的判据也就谈不上成立(第 3 轮审查 F3)。
    console.error(`[ash] 审查补投准备阶段出错 run=${run.id} round=${round.round}`
      + `（认领已归还，意图留着等下一拍重试）:`, error);
    return "hold";
  } finally {
    if (!dispatched) releaseReviewDispatchClaim(run.id, round.round, token);
  }
}

// 自由工作流的**启动期 / 周期对账**:一条挂在 `reviewing` 的审查链,此刻到底还有没有人能把它
// 跑完 —— 答得出「有」的每一种形状都要先排除掉,剩下的才收尸。
//
// 从 `free-workflow.ts` 切出来的原因:那份文件贴着 700 行上限,而这一串判据自己已经快一百行。
// 依赖是单向的(本文件 → free-workflow.ts 取结算入口),所以不成环;`index.ts`、
// `regression-settlement.ts` 都直接从这里取 `reconcileFreeReviews`,不再绕 free-workflow.ts。
import type { TaskStatus } from "@ash/shared";
import { and, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeReviewRounds, freeReviewRuns, tasks } from "./db/schema.js";
import { reviewDispatchArmed } from "./free-review-dispatch.js";
import { redeliverReviewRound } from "./free-review-redeliver.js";
import { reviewerTurnHeld, reviewOrphanStillUnowned } from "./free-review-round.js";
import { handleFreeWorkflowSettlement } from "./free-workflow.js";
import { activeReviewEvidence, reviewContinuationPending } from "./review-continuation.js";
import { retireHistoricalReview } from "./review-retirement.js";
import { id } from "./util.js";

/**
 * 启动对账（排在 reattach 与 reconcileInterrupted 之后）：`reviewing` 是持久状态，真正的
 * 审查会话却在内存投递链上——进程死在「run 已落 reviewing、reviewer 回合还没起」的当口，
 * 重启后 run 会永远挂在 reviewing，验收与再审持续 409。
 * 判据用**任务的运行事实**，不用 sessions 表（session 行的 endedAt 既不代表进程活着、也
 * 不代表回合归属：reviewer 正常提问后 session 已结束、进程死了行却可能留 null，两个方向
 * 都会判错，审查实测复现）：
 * - 任务 running/queued 或 turn 已被占 → reattach 接回的回合活着，让它自己结算；
 * - 任务挂着 question / resumePrompt → 审查回合在等答复或续跑，是正常的等待态；
 * - 其余 → 这条审查已经没有任何东西能把它跑完，落 failed 并撤预约，用户可再派一轮。
 */
export async function reconcileFreeReviews(ownerTaskId?: string): Promise<void> {
  const stuck = await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.status, "reviewing"));
  for (const run of stuck) {
    if (ownerTaskId && run.taskId !== ownerTaskId) continue;
    const task = (await db.select().from(tasks).where(eq(tasks.id, run.taskId))).at(0);
    if (!task) {
      // 任务行已不存在（旧版删除没做级联）：审查链永远无人结算，原地收尸自愈。
      await db.delete(freeReviewRounds).where(eq(freeReviewRounds.runId, run.id));
      await db.delete(freeReviewRuns).where(eq(freeReviewRuns.id, run.id));
      continue;
    }
    // **审查那一轮还活着就不碰**——这一条必须排在最前面：reviewer 可能已上报结论、但回合被
    // reattach 接回还在跑，此刻按 turnOk=true 补结算是提前放行——reviewer 随后非零
    // 退出/被停止时，正常结算已找不到 reviewing run，错误结论无法撤销（审查实测）。
    //
    // 判据是**回合身份**而不是「这个任务忙不忙」（整段理由在 `reviewerTurnHeld` 上）。
    //
    // 顺带回答「审查窗口内排队消息把执行者 resume 要不要挡」：正常路径上不需要另加挡板——
    // `afterSettlement` 是在**回合锁里面**调的（turn-lock.ts 顶部那段），放锁排在它之后
    // （orchestrator 的 finally），所以排队消息最早也只能在结算做完之后才拿到回合。现场那条
    // 消息能在 reviewer 退出后 143ms 插进来，恰恰是因为结算被上面那条后门提前 return 了。
    // 剩下的唯一例外就是这条自愈路径（结算发生在执行者回合**之中**），而那时结论早已写定、
    // 报告也早落盘，挡住用户的输入只会换来一个说不出理由的滞留。
    if (reviewerTurnHeld(task, run.id)) continue;
    // **本进程还盯着这一轮的派发就什么都别碰** —— 它正排在回合锁的等待队列里等下一个空闲窗口。
    // 「有人负责等待」不等于「没有在途工作」:下面每一条判据问的都是「还有没有东西能把它跑完」,
    // 而这一轮的答案是「有,就是那条 waiter」—— 它只是还没轮到。并进「没有意图」那一档的代价
    // 实测过:派审在释放点上输给一个 single 回合、已经合法排到第二次,而对方跑得久一点(或者
    // 成为幽灵),下一拍对账就把这条链按孤儿收尸,约 30 秒后自己 failed,自动链照样断在那里
    // (第 1 轮审查 F1)。
    //
    // 这一问排在**退役与收尸全部判据之前**,而不是跟补投那一档合在一处,为的是堵上重排的那段
    // 空档:输掉一次之后、下一个 waiter 挂上之前,中间隔着「写时间线」和「写意图」两次 await
    // (free-review-dispatch.ts 的 `hand`)。那段时间里 armed 是真的,但等待队列里一个人都没有
    // —— 占锁者恰在此时放手,锁就会在「有人盯着」的同时空出来,于是 `retireHistoricalReview`
    // 能抢到锁、把这条还活着的链按老审查退役掉(本进程的意图随后投给一条已死的 run)。
    if (reviewDispatchArmed(run.id, run.currentRound)) continue;
    if (await retireHistoricalReview(task, { role: "reviewer", review: { run: run.id, round: run.currentRound } })) continue;
    // 已交卷（当前 round 有结论）且回合确实死了：直接补结算，不能因遗留的
    // question/等待态被永远跳过——那会让验收持续被 active review 409 挡住（审查实测）。
    const round = (await db.select().from(freeReviewRounds)
      .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)))).at(0);
    // `ignoreActive=true`：「owner 在跑」已经由上面那道身份判据回答过了（在跑的不是 reviewer
    // 才会走到这里），这里再按 status 拦一次就等于把刚修好的那条路又关上。
    const waiting = await db.transaction(async (transaction) => {
      const evidence = await activeReviewEvidence(transaction, task);
      return reviewContinuationPending(transaction, task, evidence, !!round?.conclusion, true);
    }, { behavior: "immediate" });
    if (waiting) continue;
    // **「任务书还没送进会话」和「跑着跑着死了」不是一件事** —— 库里这两种长得一模一样(run/round
    // 都挂在 reviewing),区别只在 round 上那份在途派发意图。上一个进程排着等空闲窗口、自己没了的
    // 那一轮,审查者压根没见过任务书,下面那条「已经没有任何东西能把它跑完」的收尸对它是误判:
    // 补投一次才是它该得的(判据与边界见 free-review-dispatch.ts / `redeliverReviewRound`)。
    // 返回 `none` = 压根没有在途意图，照原路往下走；`hold` = 有人负责了（包括「刚刚被另一份
    // 恢复投递出去」），这一拍什么都别做，下一拍按新状态重判。
    if (round && await redeliverReviewRound(task, run, round) !== "none") continue;
    // **下笔之前再问一次「这一轮真的没人管了吗」** —— 开头那次「reviewer 活着吗」是好几次
    // await 之前读的，这中间另一份恢复完全可能已经把任务书送进会话、审查者正在输出
    // （第 3 轮审查 F1）。失去投递权不等于获得结算权，判据整段在 `reviewOrphanStillUnowned`。
    const fence = await reviewOrphanStillUnowned(run);
    if (!fence) continue;
    if (round?.conclusion) {
      await handleFreeWorkflowSettlement(run.taskId, task.status as TaskStatus, false, null, "reviewer",
        true, false, fence);
      continue;
    }
    if (await db.transaction(async (transaction) => reviewContinuationPending(transaction, task,
      await activeReviewEvidence(transaction, task), false, true), { behavior: "immediate" })) continue;
    if (!round) await db.insert(freeReviewRounds).values({ id: id(), runId: run.id, round: run.currentRound,
      status: "reviewing", startedAt: run.createdAt }).onConflictDoNothing();
    await handleFreeWorkflowSettlement(run.taskId, task.status as TaskStatus, false, null, "reviewer",
      true, false, fence)
      .catch((error) => console.error(`[ash] 孤儿审查收尾待重试 ${run.id}:`, error));
  }
}
// 自由工作流「一轮审查」的生命周期：查在跑的 run、起一轮、续下一轮、启动失败收尾，
// 以及**把崩掉的那一轮重新拉起来**（reopenFailedFreeReview）。
//
// 崩溃补投（`redeliverReviewRound`，上一个进程死在「交出去了、还没送进会话」中间那一种）
// 住在 `free-review-redeliver.ts` —— 它反过来用这里的 launchReviewRound/failReviewStart。
//
// 从 `free-workflow.ts` 切出来的原因：那份文件已经贴着 700 行上限，而重跑审查回合需要
// 复用 launchReviewRound/failReviewStart 这一组。依赖是单向的（free-workflow.ts →
// 本文件），`task-retry-turn.ts` 直接从这里取重跑入口，不用绕回去。
import type { AgentType } from "@ash/shared";
import { and, desc, eq } from "drizzle-orm";
import { gateAshMcpBeforeLaunch } from "./ash-mcp-launch-gate.js";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { freeReviewRounds, freeReviewRuns, projects, regressionEvidence, sessions, tasks } from "./db/schema.js";
import { freeReviewPrompt, freeReviewResumeMessage } from "./free-review-prompts.js";
import { freeReviewEvidenceDir } from "./free-review-files.js";
// 「任务书交出去了没有」那一段(有界重排、意图落库、留痕)住在 free-review-dispatch.ts;
// 依赖是单向的 —— 那边收 `onFail` 回调,不认识 failReviewStart,所以不成环。
import {
  claimReviewDispatch, dispatchReviewRound, preparingReviewDispatch, releaseReviewDispatchClaim,
  reviewDispatchArmed, reviewDispatchOwned, supersedeReviewDispatch,
} from "./free-review-dispatch.js";
import { evidenceState, restartRegressionEvidence } from "./regression-evidence-lifecycle.js";
import { releaseFreeWorkflowAction, tryAcquireFreeWorkflowAction } from "./free-workflow-lock.js";
import { freeWorkflowState, type FreeWorkflowApiState } from "./free-workflow-state.js";
import { headCommit } from "./git.js";
import { cleanupPostMergeReviewWorktree, preparePostMergeReviewWorktree } from "./post-merge-review-worktree.js";
import type { SettlementFence } from "./regression-settlement.js";
import { reviewInputHoldNow, reviewInputStillCurrent } from "./review-input-verdict.js";
import type { ReviewStartReceipt } from "./review-start-withdrawal.js";
import { reviewLifecycle } from "./review-lifecycle-lock.js";
import { claimOwnTurn, releaseTurn, turnIdentity } from "./runs.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { taskWorkspace } from "./task-workspace.js";
import { turnProducedWork } from "./transcript.js";
import { id, now } from "./util.js";

type TaskRow = typeof tasks.$inferSelect;
export type ReviewRunRow = typeof freeReviewRuns.$inferSelect;
export type ReviewRoundRow = typeof freeReviewRounds.$inferSelect;

/**
 * **这一轮的这一次派发责任** —— 公开 reviewing 之前就登记好的那一份(free-review-dispatch.ts
 * 文件头 ⑭)。三样各有各的用处,少一样下游就得自己去猜:
 *  · `generation` 持久代次(证据行上那个值),认领/意图 CAS/清理/失败收尾的共同身份;
 *  · `claimToken` 内存认领证,回答「此刻还是不是负责人」;
 *  · `since`      第一次把这一轮交出去的时刻 —— 登记责任那一笔已经把它写进意图了,排队那几笔
 *    必须沿用,否则时间线上的等待时长每排一次就被重置一回。
 */
export type ReviewDispatchResponsibility = { generation: string; claimToken: string; since: string };

/**
 * **原派发要的是一条新会话还是续旧的** —— 公式只许有这一处。
 *
 * 为什么:这个值既要在登记责任那一笔里落进意图(补办要原样重放它,见
 * `FreeReviewDispatchIntent.freshSession`),又要在 `launchReviewRound` 里用来真的拉会话。
 * 两处各写一遍公式,漂了就会变成「补办后接进上一条链的旧对话」那一类静默故障(第 1 轮审查 F4)。
 */
export function freshSessionFor(run: ReviewRunRow, round: number, resuming: boolean): boolean {
  // `resuming` = 续这一轮自己那条会话(`reviewRetrySessionId`)。重跑而这一轮还没有会话时**照原派发
  // 的规则来**:从前重跑一律不新开,下游就按「同类型最近的审查会话」挑,新链第 1 轮在起跑前失败
  // 后重跑,接进的是上一条链的旧对话(下一次自由审查第 2 轮 R1)。
  return !resuming && (round === 1 || run.targetKind === "accepted_merge");
}

/**
 * 这一轮审查的输入实际进过的那条会话;这一轮还没有就是 null。「继续本轮审查」的停止判断、执行器
 * 指纹、续哪条上下文都只读这一份归属(理由整段在 free-review-retry-identity.ts 文件头)。
 */
export function reviewRetrySessionId(task: Pick<TaskRow, "id" | "waitOwnership">, run: ReviewRunRow): string | null {
  const delivered = task.waitOwnership?.deliveredReview;
  return delivered?.sessionId && delivered.directory === freeReviewEvidenceDir(task.id, run.id, run.currentRound)
    ? delivered.sessionId : null;
}

// 唯一的「活」状态是 reviewing（审查旁路回合正在跑）。修复中/等待复审这些叙事不落库，
// 由「任务在跑 + 预约槽」推导（见 shared/free-workflow.ts 状态注释）。
export async function reviewingRun(taskId: string): Promise<ReviewRunRow | null> {
  return (await db.select().from(freeReviewRuns)
    .where(and(eq(freeReviewRuns.taskId, taskId), eq(freeReviewRuns.status, "reviewing")))
    .orderBy(desc(freeReviewRuns.createdAt))
    .limit(1)).at(0) ?? null;
}

export async function latestRun(taskId: string): Promise<ReviewRunRow | null> {
  return (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.taskId, taskId))
    .orderBy(desc(freeReviewRuns.createdAt)).limit(1)).at(0) ?? null;
}

/** 验收前工作区审查的最近一条链；合并结果审查不得污染修复、预约与新鲜度语义。 */
export async function latestWorkspaceRun(taskId: string): Promise<ReviewRunRow | null> {
  return (await db.select().from(freeReviewRuns).where(and(
    eq(freeReviewRuns.taskId, taskId),
    eq(freeReviewRuns.targetKind, "workspace"),
  )).orderBy(desc(freeReviewRuns.createdAt)).limit(1)).at(0) ?? null;
}

export async function roundOf(run: ReviewRunRow): Promise<ReviewRoundRow | null> {
  return (await db.select().from(freeReviewRounds)
    .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)))).at(0) ?? null;
}

export async function cleanupAcceptedMergeRun(run: ReviewRunRow, strict = false): Promise<void> {
  if (run.targetKind !== "accepted_merge") return;
  const task = (await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, run.taskId))).at(0);
  const project = task
    ? (await db.select({ repoPath: projects.repoPath }).from(projects).where(eq(projects.id, task.projectId))).at(0)
    : null;
  if (!project) return;
  try {
    await cleanupPostMergeReviewWorktree(project.repoPath, run.taskId, run.id);
  } catch (error) {
    if (strict) throw error;
    await appendTaskTimeline(run.taskId, `合并结果审查临时工作区清理失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 一次审查收尾了：把**它名下**的哨兵收回来。
 *
 * 跟任务终态那条连坐是一对。审查是旁路回合，回合退出时任务状态被恢复成原来的终态，
 * `stopMonitorsForTask` 紧接着就跑 —— 那边刻意放过了「还在进行的审查」名下的哨兵（否则
 * 审查者刚挂好的等待会被当场停掉，第 1 轮审查 F1），所以这一刀必须在审查真正结束时补上。
 *
 * 审查落终态的写点有四处（`handleFreeWorkflowSettlement` 的三种结局 + 下面的启动失败），
 * 每一处结束后都调它。`owner` 是**调用方自己是哪一次**（轮次 + 代次）:只按 runId 收是越界的
 * 刀 —— run 既跨轮复用又会被同轮重跑,而收尾是异步的,于是上一次的收尾会把后来那一次刚挂上的
 * 哨兵停掉(第 4 轮审查 F2,判据整段在 `stopMonitorsForReviewRun`)。
 *
 * **动态 import**：`monitors.ts` → `pending-messages.ts` → 这一侧，静态引用会把环连起来
 * （同 `status.ts` 的那一处）。收不回来只记日志：审查本身已经结算完了，不该被它拖住；
 * 漏下的哨兵仍有自己的到期时间，而它推的事件会被出口闸按「来源审查已结束」拒掉。
 */
export async function stopReviewRunMonitors(
  runId: string, reason: string, strict = false,
  owner?: { round?: number | null; generation?: string | null },
): Promise<number> {
  return await import("./monitor-reclaim.js")
    .then(({ stopMonitorsForReviewRun }) => stopMonitorsForReviewRun(runId, reason, owner))
    .catch((error) => {
      if (strict) throw error;
      console.error(`[ash] stopMonitorsForReviewRun(${runId}) failed:`, error);
      return 0;
    });
}

/**
 * 这一轮**起都没起来**:round 落 error、run 落 failed,写明原因。
 *
 * 开头那道闸是必须的:这个函数的几个调用点都挂在**异步**投递链上(抢锁失败、冻结撤回、补办
 * 抛错),而「这一轮」在那期间完全可能已经有了结论 —— 迟到的失败收尾会把 `passed` 覆盖成
 * `error`,界面上就是「审查通过」后面紧跟一句「审查启动失败」(第 1 轮审查 F3 实测)。所以只
 * 认一种形状:那一轮此刻还停在 `reviewing`。轮次行压根不存在也放行 —— `nextRound` 建行失败
 * 时正是这副样子,而那条 run 仍然必须落终态。
 *
 * 三处写入合在一个事务里(round 终态 + run 终态 + 清在途意图):进程死在中间的话,留下的会是
 * 「终态已落、意图还挂着」—— 下一次对账据那份意图又去补投一条已经宣告失败的轮次。
 *
 * `owner` 是**这一笔失败说的是哪一次**,而且**必填、没有兜底**(第 2 轮审查问题 1)。原先它可省,
 * 理由写的是「nextRound / 重跑入口就在自己这一代次里同步收尾,不存在隔代误伤」—— 那句话错了:
 * 这三处的 catch 挂的都是**异步**准备链,异常可以在这一轮已经失败、被重跑成另一次之后才到。
 * 省掉身份的那一笔于是绕过代次闸,把**现任**打成 error,还按整轮(run 级)把新一代刚挂上的哨兵
 * 停掉(第 2 轮审查实测 `superseded-error`:新审查者仍在输出,它等的后台检查被停)。所以两种
 * 形状各自可核,都不是「不知道就放行」:
 *  · `{ generation }`  这一轮的这一次。闸 = 还停在 reviewing **且**证据行此刻就是这一代次
 *    (权威在证据行,文件头 ⑫)。过期就整段让出 —— 一个终态不写,一份资源不碰。
 *    带着 `refusedInput`(交出去之后被协议层拒收那一档)时,闸再加一问:被拒收的**那一次输入**
 *    此刻还是不是这一轮的当前输入(`reviewInputStillCurrent`)。同一轮的答复、检查点续跑不换代次,
 *    只换输入身份 —— 旧输入迟到的拒收单凭代次闸放得过去,会把已经收下答复、正在跑的现任打成
 *    error(本次自由审查 R1,已实测)。拒收的事实早已按它自己那次输入的身份记下,这里只是不许它
 *    越过那一次输入去动整轮。拿不到身份(`null`)同样不放行。
 *  · `"unpublished"`   这一轮**压根没公开过**(连代次都还没取到,`nextRound` 读证据行就抛了)。
 *    闸 = 轮次行**真的不存在**;run 的终态照落(否则那条链永远挂在 reviewing),但不碰任何资源
 *    —— 没公开过的轮次没有自己的哨兵,而「停掉这一轮的哨兵」在没有身份时停的就是别人的。
 *
 * **整段排进这条 run 的生命周期链**(`reviewLifecycle`):那道代次闸原先只管得住落账那一笔,
 * 它提交之后的哨兵/时间线/工作区清理全是 run 级的、一个代次都不认,而那段 await 里用户完全
 * 可以重跑这一轮 —— 旧收尾于是把新一代刚挂上的哨兵停掉、把它等的结果作废(第 4 轮审查 F2
 * 实测)。排进链里之后两种时序都收口:要么这一段整个做完才轮到重跑换代次,要么重跑先换完、
 * 这一段进来时被代次闸整段挡住(连资源都不碰)。判据与锁序规矩见那个文件。
 */
export type ReviewStartFailureOwner = { generation: string; refusedInput?: ReviewStartReceipt | null } | "unpublished";

export async function failReviewStart(
  run: ReviewRunRow, message: string, owner: ReviewStartFailureOwner,
): Promise<void> {
  await reviewLifecycle(run.id, () => failReviewStartHeld(run, message, owner));
}

async function failReviewStartHeld(
  run: ReviewRunRow, message: string, owner: ReviewStartFailureOwner,
): Promise<void> {
  const at = now();
  const settled = await db.transaction(async (transaction) => {
    const current = (await transaction.select().from(freeReviewRounds)
      .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)))).at(0);
    if (owner === "unpublished") {
      // 「没公开过」是可核的断言,不是兜底:轮次行真的不存在才算。行在那里就说明它已经被公开
      // (很可能还被重跑成了另一次),这一笔没资格碰它 —— 这正是无身份收尾误杀现任的那条路。
      if (current) return false;
    } else {
      if (current && current.status !== "reviewing") return false;
      const evidence = (await transaction.select({ generation: regressionEvidence.generation })
        .from(regressionEvidence)
        .where(eq(regressionEvidence.directory, freeReviewEvidenceDir(run.taskId, run.id, run.currentRound)))).at(0);
      // 读不出代次(行没了)也不放行:这一笔说不清自己是哪一次,就没有落账的资格。
      if (evidence?.generation !== owner.generation) return false;
      if (owner.refusedInput !== undefined) {
        const task = (await transaction.select({ waitOwnership: tasks.waitOwnership }).from(tasks)
          .where(eq(tasks.id, run.taskId))).at(0);
        if (!reviewInputStillCurrent(task, owner.refusedInput,
          freeReviewEvidenceDir(run.taskId, run.id, run.currentRound), owner.generation)) return false;
      }
    }
    await transaction.update(freeReviewRounds).set({ status: "error", endedAt: at, dispatch: null })
      .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)));
    await transaction.update(freeReviewRuns).set({ status: "failed", updatedAt: at, finishedAt: at })
      .where(eq(freeReviewRuns.id, run.id));
    return true;
  }, { behavior: "immediate" });
  if (!settled) {
    console.error(`[ash] 迟到的审查启动失败不落账 run=${run.id} round=${run.currentRound}`
      + `（这一轮已有结论，或者已经被重跑成另一次，或者被拒收的那次输入已经不是这一轮当前的输入）：${message}`);
    return;
  }
  // 没公开过的轮次没有自己的资源可收;**也不许无身份地收**(停掉的会是现任那一代的,见上面)。
  if (owner !== "unpublished") {
    await stopReviewRunMonitors(run.id, "这次审查启动失败，它挂的哨兵一并收回", false,
      { round: run.currentRound, generation: owner.generation });
  }
  await appendTaskTimeline(run.taskId, `${run.targetKind === "accepted_merge" ? "合并结果" : `自由工作流第 ${run.currentRound} 轮`}审查启动失败：${message}`);
  await cleanupAcceptedMergeRun(run);
  bus.publish({ type: "task.review", taskId: run.taskId });
}


// 预检的候选目录超集挪到了 `ash-mcp-launch-gate.ts`（验证轮、辩论也要用）；这里留一个转出口。
export { reviewCwdCandidates, type ReviewCwdSession } from "./ash-mcp-launch-gate.js";

/**
 * 崩掉的那一轮能不能**从中断处接着做**：那条 CLI 会话在崩掉的那一回合里干过活吗。
 *
 * 干过活 = 它拿到过本轮任务书、做到一半的分析都在它自己的会话历史里，续跑只要一句
 * 「接着做」；没干过活（CLI 压根没起来）就只能把任务书整份重发 —— 对一条没见过本轮
 * 任务的会话说「继续」，它要么原地发呆，要么接着上一轮的事往下说。
 */
async function reviewTurnResumable(taskId: string, sessionId: string): Promise<boolean> {
  const row = (await db.select({ startedAt: sessions.startedAt, turnStartedAt: sessions.turnStartedAt })
    .from(sessions).where(eq(sessions.id, sessionId))).at(0);
  if (!row) return false;
  // 会话行跨回合复用，turnStartedAt 记着最近一次回合的起点；没有它（老行）就退回建会话的时刻。
  return turnProducedWork(taskId, sessionId, row.turnStartedAt ?? row.startedAt);
}

export async function launchReviewRound(
  task: TaskRow,
  run: ReviewRunRow,
  // 重跑崩掉的那一轮时传：落回**那一条**审查会话（挑错人等于换个审查者从头看），
  // 且必须关掉 freshSession —— 第 1 轮崩了的话它本来会新开一条空会话。
  opts: {
    resumeSessionId?: string; retry?: boolean;
    /**
     * 上一个进程把这一轮交出去了、还没送进会话就没了 —— 这一次是**补投**(由
     * `redeliverReviewRound` 传进来)。三处差别:时间线说的是「重新投递」而不是「审查开始」,
     * 接着上一次的次数往下数(不是从 1 重新开始),以及**会话策略照原派发重放**(见下面
     * `freshSession`)。其余一概照常走 —— 证据目录、合并结果 worktree、MCP 预检都是幂等的,
     * 任务书也必须按**此刻**的工作区重算。
     */
    redeliver?: { attempts: number; since: string; freshSession: boolean };
    /**
     * **这一轮的这一次派发责任** —— 必填:登记责任的那一步排在「公开 reviewing」之前,所以它
     * 一定发生在调用这个函数之前(free-review-dispatch.ts 文件头 ⑭)。这里只核一句「这张证还是
     * 不是负责人」,不自己领、也不自己还 —— 领证的人(即时派审 / 升轮 / 重跑 / 补投)负责还。
     */
    responsibility: ReviewDispatchResponsibility;
  },
): Promise<{ resumed: boolean; dispatched: boolean }> {
  const { generation, claimToken } = opts.responsibility;
  {
    // **进来就核一句「这张证还是不是负责人」** —— 从登记责任到这里之间可能已经隔了几次 await
    // (公开 reviewing 那一笔、清预约、写时间线),中途完全可以有一次重跑把它定向撤销掉
    // (`supersedeReviewDispatch`)。不核就会以作废的身份往下准备、排队,而真正的现任在办同一轮。
    if (!reviewDispatchOwned(run.id, run.currentRound, claimToken)) {
      console.error(`[ash] 审查派发让出 task=${task.id} run=${run.id} round=${run.currentRound}：手里这张认领证已经被撤销（这一轮期间被重跑成另一次）`);
      return { resumed: false, dispatched: false };
    }
  }
  {
    // 这一行同时核**这一轮的这一次**的身份(`generation`):认领、意图 CAS、清理、失败收尾都按
    // 它认人(理由见 free-review-dispatch.ts 文件头 ⑨)。命中已有行就返回 —— 登记责任那一步
    // 已经把它建好了,所以这里读到的必须就是登记时那一代;对不上说明中间被重跑换过,让出。
    // **库里那一行才是权威**(文件头 ⑫):内存认领只能证明「本进程此刻没有第二个人在办」。
    const evidence = await evidenceState(task.id, freeReviewEvidenceDir(task.id, run.id, run.currentRound), task);
    if (evidence.generation !== generation) {
      console.error(`[ash] 审查派发让出 task=${task.id} run=${run.id} round=${run.currentRound}：准备期间这一轮被重跑成另一次`);
      return { resumed: false, dispatched: false };
    }
  }
  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  let cwd: string | undefined;
  let workspacePath: string | undefined;
  // 锚定本轮结论的基准：审查启动时工作区的 HEAD。之后代码变没变、结论新不新鲜，
  // 全靠它跟当前 HEAD 比，不靠任何状态字段。取不到（工作区缺失）就留 null。
  if (run.targetKind === "accepted_merge") {
    if (!project || !run.targetCommit) throw new Error("合并结果审查缺少项目或验收 commit");
    cwd = await preparePostMergeReviewWorktree(project.repoPath, task.id, run.id, run.targetCommit);
    await db.update(freeReviewRounds).set({ reviewedCommit: run.targetCommit })
      .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)));
  } else if (project) {
    const workspace = await taskWorkspace(task, project.repoPath).catch(() => null);
    workspacePath = workspace?.path;
    const head = workspace ? await headCommit(workspace.path) : null;
    if (head) {
      await db.update(freeReviewRounds).set({ reviewedCommit: head })
        .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)));
    }
  }
  // 审查者交卷靠 ash MCP 的 report_stage，而那条登记在**它自己的 CLI 配置里**，ash 只能
  // 问、不能替它注入。缺了的话这一轮会完整跑完、报告也写得好好的，最后一步才发现没有
  // 工具可调 —— 一轮审查动辄几十分钟、几百万 token（2026-10-28 现场）。所以在这儿拦，
  // 抛出去由三个调用点统一走 failReviewStart。验证轮、辩论走的是同一道闸（ash-mcp-launch-gate.ts）。
  //
  // **排在 cwd 算出来之后**：claude 的项目级登记（`--scope local`）只在那个目录下看得见，
  // 在它之前问等于拿「别的目录没有」去拦这一轮（第 1 轮审查 F1）。只传单个 `cwd` 不够 ——
  // 普通工作区分支的 `cwd` 一直是 undefined，于是预检在 **server 进程**的目录里问，
  // 任务目录里接好的 claude 被判成没登记（第 2 位审查者 F1），所以闸那边按超集问。
  await gateAshMcpBeforeLaunch(task, { agentType: run.agentType, executorId: run.executorId }, "审查者", {
    cwd,
    workspacePath,
  });
  const prompt = await freeReviewPrompt(task, run, run.currentRound, project?.repoPath ?? "(项目已不存在)");
  // 重跑分两档，差别不在按钮而在**送进去的那句话**：上下文还在就只说「接着做」（一条崩在
  // 10M token 上的审查，重来一次就是再烧 10M）；上下文是空的才把任务书整份重发。
  const resumed = !!opts.retry && !!opts.resumeSessionId && await reviewTurnResumable(task.id, opts.resumeSessionId);
  // **会话策略由原派发定,补办只是重放它** —— 所以这里不能自己带上 `&& !opts.redeliver`:那样
  // 新链第 1 轮、合并结果审查在补办时会从「新开一条空会话」变成「按 agentType+role 挑最近的
  // 历史会话」(下游默认动作,不按 run 隔离),于是接进了上一条链的旧对话(第 1 轮审查 F4)。
  // 原值跟着意图落库,补办时原样传回来(老行的回落见 `redeliverReviewRound`)。
  const freshSession = opts.redeliver ? opts.redeliver.freshSession
    : freshSessionFor(run, run.currentRound, !!opts.retry && !!opts.resumeSessionId);
  const label = run.targetKind === "accepted_merge" ? "合并结果审查" : `自由工作流第 ${run.currentRound} 轮审查`;
  await appendTaskTimeline(task.id, opts.redeliver
    // 补投不写「审查开始」:那一句上一次已经写过了,再写一遍会让时间线读成开了两轮。
    // `attempts === 0` = 上次中断在**准备阶段**(责任登记好了、还没排上队,见
    // `preparingReviewDispatch`):说成「已尝试 0 次」会让用户以为计数坏了。
    ? opts.redeliver.attempts === 0
      ? `${label}的任务书重新投递：服务上次中断时它还在准备阶段，一个字都没送出去。`
      : `${label}的任务书重新投递：服务上次中断时它还没送进会话（已尝试 ${opts.redeliver.attempts} 次）。`
    : opts.retry
      ? resumed
        ? `${label}从中断处继续：${run.reviewerName}。`
        : `${label}重跑上一回合：${run.reviewerName}。`
      : run.targetKind === "accepted_merge"
        ? `合并结果审查开始：${run.reviewerName} · ${run.targetBranch}@${run.targetCommit?.slice(0, 8)} · ${run.checkMode === "logic" ? "逻辑检查" : "语法检查"}。`
        : `自由工作流第 ${run.currentRound} 轮审查开始：${run.reviewerName} · ${run.checkMode === "logic" ? "逻辑检查" : "语法检查"}。`);
  bus.publish({ type: "task.review", taskId: task.id });
  const message = !opts.retry
    ? prompt
    : resumed
      ? freeReviewResumeMessage(task, run, run.currentRound)
      : `上一回合异常结束，本轮审查从头继续。\n\n${prompt}`;
  // 投递本身走 `dispatchReviewRound`:它在回合锁上抢不到位时**重排**而不是落终态(瞬时条件
  // 不该变成永久失败,整段理由见 free-review-dispatch.ts 文件头)。抢不到以外的失败照旧
  // `failReviewStart`,行为与改之前一致。
  const outcome = await dispatchReviewRound({
    taskId: task.id,
    run: { id: run.id, currentRound: run.currentRound },
    generation,
    label,
    message,
    opts: {
      system: "run",
      sideTurn: true,
      agent: run.agentType as AgentType,
      executorId: run.executorId,
      model: run.model,
      reasoningEffort: run.reasoningEffort,
      // **这一轮是谁起的、为哪一次审查的哪一轮起的** —— 由这里交代,因为只有这里手里同时握着
      // run 和轮次。创建入口过后只能查「现在是哪一次」,而那两者在派审交接期不是同一个
      // (第 10 轮审查 F1:旧审查者提交的哨兵被绑到新派的审查者上)。两样同在一个对象里,
      // 所以恢复那几条路也不可能只带到一半(本轮审查 F2)。
      turnSource: { role: "reviewer", review: { run: run.id, round: run.currentRound } },
      freshSession,
      resumeSessionId: opts.resumeSessionId,
      cwd,
      // 重跑这一路的预检查（freeReviewRetryBlocker）离真正拉起 CLI 很远，中间还要经过
      // 「先释放重试路由那把锁、排队再起」的交接——那段时间里分组可能已经被暂停。起跑前
      // 再核一遍冻结事实（turn-freeze.ts）；命中就撤回，这条链留在 failed，仍可再重试。
      //
      // 补投也开着它:那一次重启之后分组同样可能已经被暂停、任务已经被归档。
      freezeGuard: !!opts.retry || !!opts.redeliver,
    },
    resumeSessionId: opts.resumeSessionId,
    retry: opts.retry,
    freshSession,
    // 没有补办那一路的次数时也从 **0** 起数(而不是不传):登记责任那一笔已经把
    // `attempts: 0` 的意图落进库了,第一次排队要按它做 CAS(见 `preparingReviewDispatch`)。
    attempts: opts.redeliver?.attempts ?? 0,
    since: opts.redeliver?.since ?? opts.responsibility.since,
    // 证是**公开这一轮的那一个**领的(文件头 ⑭ 第二条),原样传下去;派发层只核一句它还是不是
    // 负责人,不自己重领 —— 重领会撞上现任那一张,当场判「这一轮已经有在途派发」并让出,一次
    // 正常派审就这么丢了(第 1 轮 ㉒甲 一写就抓到)。
    claimToken,
    // 这一笔失败只说**这一次**:代次对不上(中间被用户重跑过)就不许落账,否则刚重跑起来的
    // 那一次会被上一次的迟到失败打成 error(第 3 轮审查 F2)。
    // 拒收那一档还带着被拒收的那一次输入(`refusedInput`),落账闸据此核它是不是当前输入。
    onFail: (error, refusedInput) => failReviewStart(run, error,
      { generation, ...(refusedInput !== undefined ? { refusedInput } : {}) }),
  });
  // **只有真排进去了**才算责任交出去:那之后由派发层在投递成功/放弃/让出时还证。让出那几种
  // 原样回给调用方 —— 还证的人是领证的那一个(free-review-dispatch.ts 文件头 ⑭ 第二条),
  // 它按 `dispatched` 决定要不要还,所以这里不许吞掉这个值。
  return { resumed, dispatched: outcome === "dispatched" };
}

/**
 * **reviewer 的回合此刻是不是正按着这条 run** —— 「这一轮还有人在跑」的唯一判据。
 *
 * 判据是**回合身份**而不是「这个任务忙不忙」:这两件事在自由工作流里经常不是一件事 ——
 * 执行者挂着哨兵,哨兵结果回来把它 resume 去跑**实现回合**,而这条审查早就交卷死透了。
 * 只看 `status==="running"` 的旧判据会让这种任务永远跳过,round 挂在 reviewing:验收 409、
 * 自动复审不开、修复交接不发(现场实测挂了一整天,见 docs/incidents.md「审查交卷后 round 挂死」)。
 *
 * 身份读不出来(没有回合在册)却还 running/queued:这一拍说不清在跑的是谁,保守当成「有人在跑」
 * —— 保守的那一边是「多等 30 秒」,激进的那一边是撤不掉的错误结论。
 */
export function reviewerTurnHeld(task: TaskRow, runId: string): boolean {
  const held = turnIdentity(task.id);
  return held
    ? held.role === "reviewer" && (!held.review || held.review.run === runId)
    : task.status === "running" || task.status === "queued";
}

/**
 * **这一轮真的没人管了吗** —— 答「是」的同时交出一张**落笔时要核的凭据**。
 *
 * 为什么不能只答一句「是」:对账那一串判据全是**异步**的 —— 开头读一次「reviewer 活着吗」,
 * 之后还要 await 退役检查、轮次读取、等待检查、补办,最后才下笔。两份恢复同时进来时,快的那
 * 一份完全可以在这期间把任务书送进会话、拉起审查者;慢的那一份带着开头那个「没人在跑」的结论
 * 一路走到收尾,把一条**正在输出**的审查落成 failed/error(第 3 轮审查 F1 实测:没有任何磁盘
 * 故障,两个恢复者正常交错即可)。**失去投递权不等于获得结算权。**
 *
 * 所以这里做的是两件事,而且第二件才是硬保证:
 *  · 现读五样做**早退**:任务行、回合身份、内存认领、轮次行(终态 / 又挂上在途意图)、run 行
 *    (已被结算 / 已翻到下一轮)。少一样就有一条白跑一趟、还顺手写一句误导时间线的路。
 *  · 交出 `directionEpoch` 当**落笔条件**:再怎么现读,读完到提交之间仍然隔着几次 await ——
 *    「检查完再动手」本身就是这条缺陷的形状,多读一遍只是把窗口变窄。而「这中间有没有又起过
 *    回合」在库里有一个一次只增的持久凭据:每个回合起跑(含审查旁路回合)都在同一笔事务里把
 *    `tasks.direction_epoch` +1(`orchestrator.ts` / `task-run.ts` 的 `turnDirectionStart`)。
 *    把它当条件写进结算那个事务,检查-然后-动作就变成了一次 CAS:窗口里真有回合起来,那一笔
 *    自己就不成立(判据 `directionEpochUnchangedSince`,用法见 `handleFreeWorkflowSettlement`
 *    的 `orphanFence`)。
 *
 * 返回 null = 别收;返回凭据 = 可以往下走,但**必须把它带到落笔那一刻**。
 */
export async function reviewOrphanStillUnowned(run: ReviewRunRow): Promise<SettlementFence | null> {
  const fresh = (await db.select().from(tasks).where(eq(tasks.id, run.taskId))).at(0);
  if (!fresh) return null;
  if (reviewerTurnHeld(fresh, run.id)) return null;
  if (reviewDispatchArmed(run.id, run.currentRound)) return null;
  const round = (await db.select().from(freeReviewRounds)
    .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)))).at(0);
  if (round && (round.status !== "reviewing" || round.dispatch)) return null;
  const current = (await db.select({ status: freeReviewRuns.status, currentRound: freeReviewRuns.currentRound })
    .from(freeReviewRuns).where(eq(freeReviewRuns.id, run.id))).at(0);
  if (current?.status !== "reviewing" || current.currentRound !== run.currentRound) return null;
  // **「此刻没有任何派发责任」也要带到落笔那一刻** —— 上面那两问(内存认领、round 上的意图)读完
  // 之后还隔着几次 await,而这中间谁都可以合法接手:公开 reviewing 的那一笔就带着持久责任
  // (`preparingReviewDispatch`),重跑也会在同一段同步代码里换代次并重新登记。拿任务 epoch 去核
  // 答的是另一个问题 —— 准备责任不增长 epoch,所以旧孤儿决策照样提交得了(第 2 轮审查问题 2
  // 复现 B)。让这句前提在提交那一刻自己成立,检查-然后-动作就变成一次 CAS。
  return {
    taskId: fresh.id, directionEpoch: fresh.directionEpoch,
    review: { runId: run.id, round: run.currentRound },
  };
}

export async function nextRound(task: TaskRow, run: ReviewRunRow): Promise<void> {
  const round = run.currentRound + 1;
  const at = now();
  const nextRun = { ...run, status: "reviewing", currentRound: round, updatedAt: at };
  // **代次先有、责任先登记,再公开这一轮** —— 顺序就是问题 2 的全部修法(free-review-dispatch.ts
  // 文件头 ⑭)。证据行读不出来时这一轮还一个字都没公开过,那一档失败按 `"unpublished"` 收尾:
  // 写得了 run 的终态,碰不了任何资源。
  let generation: string;
  try {
    generation = (await evidenceState(task.id, freeReviewEvidenceDir(task.id, run.id, round), task)).generation;
  } catch (error) {
    await failReviewStart(nextRun, error instanceof Error ? error.message : String(error), "unpublished");
    throw error;
  }
  const claimToken = claimReviewDispatch(run.id, round, generation);
  if (!claimToken) {
    // 这一轮已经有人在办(并发入口撞上了):一个字都不写、也不落终态,那一次会把它办完。
    console.error(`[ash] 自由工作流第 ${round} 轮让出 run=${run.id}：这一轮已经有在途派发`);
    return;
  }
  let handed = false;
  try {
    // 公开这一轮与「有人负责」同在这一笔 insert 里:round 行就是孤儿路与补投路共同读的那一行,
    // 所以它从不存在「已经 reviewing、却谁都没在负责」的瞬间。
    await db.insert(freeReviewRounds).values({
      id: id(), runId: run.id, round, status: "reviewing", conclusion: null, startedAt: at, endedAt: null,
      dispatch: preparingReviewDispatch(generation, at,
        { retry: false, freshSession: freshSessionFor(run, round, false) }),
    });
    await db.update(freeReviewRuns).set({ status: "reviewing", currentRound: round, updatedAt: at })
      .where(eq(freeReviewRuns.id, run.id));
    // 预约槽已由 startReservedFreeReview 在调用本函数**之前**按 CAS 消费掉（消费成功才
    // 会走到这里）。这里再无条件清一次，清掉的可能是用户中途保存的新预约（审查实测）。
    handed = (await launchReviewRound(task, nextRun,
      { responsibility: { generation, claimToken, since: at } })).dispatched;
  } catch (error) {
    await failReviewStart(nextRun, error instanceof Error ? error.message : String(error), { generation });
    throw error;
  } finally {
    // 领证的人负责还证:准备阶段抛了、或者就地让出了,**证必须还回去** —— 不还的话这一轮在本
    // 进程里永远「在途」,对账见 `armed` 就跳过,库里那份没消费的意图再也没人补办(文件头 ⑩)。
    if (!handed) releaseReviewDispatchClaim(run.id, round, claimToken);
  }
}

/**
 * 「这条审查链能不能重跑上一回合」的唯一判据，返回拒绝文案或 null。
 *
 * 只认一种形状：最近一条 run 落在 failed、且它当前那一轮落在 error —— 那正是「审查回合
 * 没能给出结论（崩了 / 启动失败 / 报错后照样 exit 0），自动链已停」留下的痕迹。已给出结论
 * 的轮次（passed/stopped）不在此列：那是正常结局，要再看一遍应该派新一轮审查。
 *
 * 这也是审查档「上一回合崩没崩」的**唯一**判据，退出码不参与：CLI 打完
 * 「API Error: Connection lost mid-response」仍会 exit 0，那一轮照样一个结论都没有。
 */
export function freeReviewRetryBlocker(
  run: ReviewRunRow | null,
  round: ReviewRoundRow | null,
  awaitsInputDecision = false,
): string | null {
  if (!run) return "这个任务没有审查记录";
  if (awaitsInputDecision) return null;
  if (run.status !== "failed") return "最近一轮审查没有停在异常结束状态";
  if (!round || round.status !== "error") return "最近一轮审查没有停在异常结束状态";
  return null;
}

/**
 * 这一轮停在「任务书送没送到说不清、等用户拿主意」上 —— 审查回合已经结束、没交卷,协议又没给
 * 定论,系统不替它结也不替它重投(判据整段在 review-input-verdict.ts)。它跟「异常结束」一样
 * 交给「继续本轮审查」:重投是用户知情之后的显式决定。
 */
export async function reviewAwaitsInputDecision(
  task: TaskRow, run: ReviewRunRow | null, round: ReviewRoundRow | null,
): Promise<boolean> {
  if (!run || run.status !== "reviewing" || round?.status !== "reviewing" || round.conclusion) return false;
  if (round.round !== run.currentRound || reviewerTurnHeld(task, run.id)) return false;
  const input = await reviewInputHoldNow(task.id, task, freeReviewEvidenceDir(task.id, run.id, round.round));
  return input === "hold" || input === "unconfirmed";
}

/**
 * 把崩掉的那一轮审查重新拉起来（会话续跑，不是新开一轮）。
 *
 * 触发点是会话底部那颗「继续本轮审查」——审查会话异常结束时，用户看到的就是那条
 * reviewer 会话，重试语义只能是「让**同一位审查者**接着把这一轮跑完」。走新一轮
 * （nextRound）会白白吃掉一次复审额度，还会让 report.md 落到另一个 round 目录。
 *
 * 返回的 `resumed` 是「这一次到底是接着做还是从头再来」（判据见 reviewTurnResumable）：
 * 两者用户都只按了同一颗按钮，所以必须原样回给前端，让它如实说是哪一种。
 *
 * `dispatched` 是「这一次**真的**把任务书排出去了吗」：排不出去只有一种现场 —— 同代次已经有
 * 一份在途派发在负责（比如定时对账正在补投这一轮）。那一次不该冒充安排成功，也不该把这一轮
 * 打成失败（真有人在办），所以如实回一句、并留一行时间线（第 3 轮审查 F2）。
 */
export async function reopenFailedFreeReview(
  taskId: string,
  opts: { holdTurn?: boolean } = {},
): Promise<{ state: FreeWorkflowApiState; resumed: boolean; dispatched: boolean }> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) throw new Error("任务不存在");
  if (task.mode !== "single" || task.parentId || task.reviewOf || task.workflowMode !== "free") {
    throw new Error("当前任务不是自由工作流");
  }
  if (task.archived) throw new Error("归档任务不能重跑审查");
  if (task.status === "running" || task.status === "queued") throw new Error("任务正在运行或排队，结束后再重跑");
  if (task.question || task.resumePrompt) throw new Error("任务正等待答复或续跑，处理后再重跑");
  const initialRun = await latestRun(taskId);
  // 已验收任务只允许重跑它自己的合并结果审查；验收前工作区审查仍不能越过验收边界。
  if ((task.stage === "accepted" || task.stage === "merged") && initialRun?.targetKind !== "accepted_merge") {
    throw new Error("任务已进入验收结果；如需继续修改，请先重新运行任务");
  }
  // 与即时派审同级的原子互斥（理由见 free-workflow.ts 的 startFreeReview）：占位身份
  // dispatch，校验到写库整段占住；释放后审查消息才可能真正投递。
  // 占到的那把锁的身份一路带到 finally:这中间全是 await,人工放开可以把锁拔走、另一轮
  // 合法占上,按任务 id 还锁撤掉的就是后来者那把(本轮审查 F1,见 turn-lock.ts `endOwnTurn`)。
  const holdingTurn = opts.holdTurn === true;
  const turn = holdingTurn ? claimOwnTurn(taskId, "dispatch") : null;
  if (holdingTurn && !turn) throw new Error("任务回合正在进行，结束后再重跑");
  try {
    if (!tryAcquireFreeWorkflowAction(taskId)) throw new Error("当前已有自由工作流操作正在进行");
    try {
      const run = await latestRun(taskId);
      const round = run ? await roundOf(run) : null;
      const blocker = freeReviewRetryBlocker(run, round, await reviewAwaitsInputDecision(task, run, round));
      if (blocker) throw new Error(blocker);
      // 续哪条会话由这里按这一轮自己的归属定,不收调用方挑的:没有就从头交代任务书。
      const resumeSessionId = reviewRetrySessionId(task, run!) ?? undefined;
      const at = now();
      const directory = freeReviewEvidenceDir(taskId, run!.id, run!.currentRound);
      await evidenceState(taskId, directory);
      // **换代次这一笔要跟上一次的收尾互斥**(`reviewLifecycle`,第 4 轮审查 F2):上一次失败已经
      // 提交(所以重试闸放行了),它的哨兵/待发结果/工作区清理可能还在做,而那几刀全是 run 级的。
      // 不排队的话,换完代次拉起来的新一代资源会被旧收尾顺手收掉。只把这一笔放进链里 ——
      // 下面的 `launchReviewRound` 以及它 catch 里的 `failReviewStart` 都要取同一把锁,
      // 一起放进来就是自锁(判据见那个文件的「不许重入」)。
      /** 重跑换代次那一笔同步抢下来的责任 —— 一路传给 `launchReviewRound`。 */
      const prepared = await reviewLifecycle(run!.id, async () => {
        const { previous, current } = await db.transaction(async (transaction) => {
          // 换代次之前先记下**上一次是谁**:它退场时留下的哨兵与排着的结果得有人收,而它自己
          // 的收尾此刻要么已经做完、要么会被代次闸整段挡住(就是这把锁保证的)。送它退场的人
          // 负责收 —— 否则那几条会一直空烧到自己到期,新一次的收尾又只认自己那一代次。
          const before = (await transaction.select({ generation: regressionEvidence.generation })
            .from(regressionEvidence).where(eq(regressionEvidence.directory, directory))).at(0)?.generation;
          const after = await restartRegressionEvidence(taskId, directory, transaction);
          // **把这一轮放回 reviewing 的同一笔里就带上「有人负责」**(文件头 ⑭):否则从这笔提交
          // 到下面那行同步认领之间,库里是「reviewing + 谁都没在负责」—— 而那不是数据库级的
          // 不变量,一次对账落在中间就能把刚重跑起来的这一次收尸。
          await transaction.update(freeReviewRounds).set({
            status: "reviewing", conclusion: null, endedAt: null,
            dispatch: preparingReviewDispatch(after, at,
              { resumeSessionId: resumeSessionId ?? null, retry: true,
                freshSession: freshSessionFor(run!, run!.currentRound, !!resumeSessionId) }),
          }).where(eq(freeReviewRounds.id, round!.id));
          await transaction.update(freeReviewRuns).set({ status: "reviewing", updatedAt: at, finishedAt: null })
            .where(eq(freeReviewRuns.id, run!.id));
          return { previous: before, current: after };
        }, { behavior: "immediate" });
        // **撤旧证 + 抢新证必须是同一段同步代码**:中间插进任何 await,这一轮就有一段「run/round
        // 已经放回 reviewing、却谁都没在负责」的时间 —— 那正是对账收尸的全部依据。
        // 撤只撤上一代那一张(连「代次待定」的准备占位一起,理由见 `supersedeReviewDispatch`):
        // 接管在这条链上只有这一条有权威依据的出路,因为「上一代是谁」是这一笔自己刚换掉的。
        if (previous) supersedeReviewDispatch(run!.id, run!.currentRound, previous);
        const claimToken = claimReviewDispatch(run!.id, run!.currentRound, current);
        if (previous) {
          await stopReviewRunMonitors(run!.id, "这一轮被重跑，上一次挂的哨兵一并收回", false,
            { round: run!.currentRound, generation: previous });
        }
        return { generation: current, claimToken };
      });
      const revived = { ...run!, status: "reviewing", updatedAt: at, finishedAt: null };
      // 用户重跑一条工作区审查 = 他自己又开了一轮：挂着的未裁定驳回被取代（同 startFreeReview）。
      if (run!.targetKind === "workspace") {
        const { supersedeOpenDisputes } = await import("./free-review-dispute.js");
        await supersedeOpenDisputes(taskId, "重跑了一轮审查");
      }
      // 证抢不到 = 这一轮真有另一次派发在负责(上面那一撕没撕着:这一轮的证属于别人)。
      // **一个字都不写、也不落终态**,但要留得下痕:只在返回值里说一句,用户刷新页面后看到的
      // 仍是「我点了，然后什么都没发生」。时间线是持久的那一半。
      if (!prepared.claimToken) {
        await appendTaskTimeline(taskId, "这次「继续本轮审查」没有另起投递：这一轮已经有一份"
          + "在途派发在负责，它会在下一个空闲回合窗口把任务书送进会话。");
        return { state: await freeWorkflowState(taskId), resumed: false, dispatched: false };
      }
      const responsibility = { generation: prepared.generation, claimToken: prepared.claimToken, since: at };
      let handed = false;
      try {
        const { resumed, dispatched } = await launchReviewRound(task, revived,
          { resumeSessionId, retry: true, responsibility });
        handed = dispatched;
        if (!dispatched) {
          await appendTaskTimeline(taskId, "这次「继续本轮审查」没有另起投递：这一轮已经有一份"
            + "在途派发在负责，它会在下一个空闲回合窗口把任务书送进会话。");
        }
        return { state: await freeWorkflowState(taskId), resumed, dispatched };
      } catch (error) {
        // 起不来就把 run/round 放回 failed/error（否则它会永远挂在 reviewing，验收和
        // 再派审都被 hasActiveFreeReview 挡住）。**带着这一次的代次**:省掉身份的那一笔会把
        // 现任打成 error、还按整轮收掉它的资源(第 2 轮审查问题 1)。
        await failReviewStart(revived, error instanceof Error ? error.message : String(error),
          { generation: prepared.generation });
        throw error;
      } finally {
        // 领证的人负责还证(同 nextRound 的 finally)。
        if (!handed) releaseReviewDispatchClaim(run!.id, run!.currentRound, responsibility.claimToken);
      }
    } finally {
      releaseFreeWorkflowAction(taskId);
    }
  } finally {
    if (turn) releaseTurn(taskId, turn);
  }
}

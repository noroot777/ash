// 自由工作流「一轮审查」的生命周期：查在跑的 run、起一轮、续下一轮、启动失败收尾，
// 以及**把崩掉的那一轮重新拉起来**（reopenFailedFreeReview）。
//
// 从 `free-workflow.ts` 切出来的原因：那份文件已经贴着 700 行上限，而重跑审查回合需要
// 复用 launchReviewRound/failReviewStart 这一组。依赖是单向的（free-workflow.ts →
// 本文件），`task-retry-turn.ts` 直接从这里取重跑入口，不用绕回去。
import type { AgentType } from "@ash/shared";
import { and, desc, eq } from "drizzle-orm";
import { gateAshMcpBeforeLaunch } from "./ash-mcp-launch-gate.js";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { freeReviewRounds, freeReviewRuns, projects, sessions, tasks } from "./db/schema.js";
import { freeReviewPrompt, freeReviewResumeMessage } from "./free-review-prompts.js";
import { freeReviewEvidenceDir } from "./free-review-files.js";
// 「任务书交出去了没有」那一段(有界重排、意图落库、留痕)住在 free-review-dispatch.ts;
// 依赖是单向的 —— 那边收 `onFail` 回调,不认识 failReviewStart,所以不成环。
import { claimReviewDispatch, dispatchReviewRound, releaseReviewDispatchClaim, reviewDispatchRecovery } from "./free-review-dispatch.js";
import { evidenceState, restartRegressionEvidence } from "./regression-evidence-lifecycle.js";
import { releaseFreeWorkflowAction, tryAcquireFreeWorkflowAction } from "./free-workflow-lock.js";
import { freeWorkflowState, type FreeWorkflowApiState } from "./free-workflow-state.js";
import { headCommit } from "./git.js";
import { cleanupPostMergeReviewWorktree, preparePostMergeReviewWorktree } from "./post-merge-review-worktree.js";
import { claimOwnTurn, releaseTurn } from "./runs.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { taskWorkspace } from "./task-workspace.js";
import { turnProducedWork } from "./transcript.js";
import { id, now } from "./util.js";

type TaskRow = typeof tasks.$inferSelect;
export type ReviewRunRow = typeof freeReviewRuns.$inferSelect;
export type ReviewRoundRow = typeof freeReviewRounds.$inferSelect;

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
 * 每一处结束后都调它；按 runId 收，调用方只需知道「哪一次审查结束了」。
 *
 * **动态 import**：`monitors.ts` → `pending-messages.ts` → 这一侧，静态引用会把环连起来
 * （同 `status.ts` 的那一处）。收不回来只记日志：审查本身已经结算完了，不该被它拖住；
 * 漏下的哨兵仍有自己的到期时间，而它推的事件会被出口闸按「来源审查已结束」拒掉。
 */
export async function stopReviewRunMonitors(runId: string, reason: string, strict = false): Promise<number> {
  return await import("./monitor-reclaim.js")
    .then(({ stopMonitorsForReviewRun }) => stopMonitorsForReviewRun(runId, reason))
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
 */
export async function failReviewStart(run: ReviewRunRow, message: string): Promise<void> {
  const at = now();
  const settled = await db.transaction(async (transaction) => {
    const current = (await transaction.select().from(freeReviewRounds)
      .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)))).at(0);
    if (current && current.status !== "reviewing") return false;
    await transaction.update(freeReviewRounds).set({ status: "error", endedAt: at, dispatch: null })
      .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)));
    await transaction.update(freeReviewRuns).set({ status: "failed", updatedAt: at, finishedAt: at })
      .where(eq(freeReviewRuns.id, run.id));
    return true;
  }, { behavior: "immediate" });
  if (!settled) {
    console.error(`[ash] 迟到的审查启动失败不落账 run=${run.id} round=${run.currentRound}（这一轮已有结论）：${message}`);
    return;
  }
  await stopReviewRunMonitors(run.id, "这次审查启动失败，它挂的哨兵一并收回");
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
  } = {},
): Promise<{ resumed: boolean }> {
  await evidenceState(task.id, freeReviewEvidenceDir(task.id, run.id, run.currentRound), task);
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
  const freshSession = opts.redeliver
    ? opts.redeliver.freshSession
    : !opts.retry && (run.currentRound === 1 || run.targetKind === "accepted_merge");
  const label = run.targetKind === "accepted_merge" ? "合并结果审查" : `自由工作流第 ${run.currentRound} 轮审查`;
  await appendTaskTimeline(task.id, opts.redeliver
    // 补投不写「审查开始」:那一句上一次已经写过了,再写一遍会让时间线读成开了两轮。
    ? `${label}的任务书重新投递：服务上次中断时它还没送进会话（已尝试 ${opts.redeliver.attempts} 次）。`
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
  await dispatchReviewRound({
    taskId: task.id,
    run: { id: run.id, currentRound: run.currentRound },
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
    attempts: opts.redeliver?.attempts,
    since: opts.redeliver?.since,
    onFail: (error) => failReviewStart(run, error),
  });
  return { resumed };
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
 *  · `none`    —— 这一轮没有在途意图,照原路对账;
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
  const verdict = reviewDispatchRecovery(run.id, round.round, round.dispatch);
  if (verdict.kind === "none") return "none";
  if (verdict.kind === "in-flight") return "hold";
  const { intent } = verdict;
  if (verdict.kind === "exhausted") {
    // 界用尽了才落终态,而且**说得出原因**:通用收尸那句「未能正常给出结论」会让用户以为审查者
    // 跑过、没交卷,实际上它一个字都没收到。意图由 `failReviewStart` 在终态那一个事务里一并清掉。
    //
    // 措辞只说「排了几次队」而不说「输了几次」:`attempts` 记的是**已登记的尝试**,而最后一次
    // 完全可能只排上队、还没等到释放点服务就断了 —— 那一次没有真的被谁抢走,说成「被抢 N 次」
    // 就是把没发生的事算进去了。
    await failReviewStart(run, `任务书始终没能送进会话 —— 已经排了 ${intent.attempts} 次队都没抢到空闲回合窗口（含服务重启后的补投），不再重试`);
    return "handled";
  }
  // **先同步认领,再做任何 await** —— 下面整条 `launchReviewRound` 是一长串异步准备,中途另一个
  // 恢复入口(定时对账 / 单任务中断恢复 / 答复提问各有一条路)完全可能也读到「没人盯着」,于是
  // 同一轮排两份任务书,而迟到那一份的失败回调又会去覆盖先那一份已经拿到的结论
  // (第 1 轮审查 F3)。认领就是 `armed` 那张表,所以「谁在途」只有一个答案。
  if (!claimReviewDispatch(run.id, round.round)) return "hold";
  // 次数接着上一次往下数:补投也是一次尝试,否则重启反复发生时这条链会永远重投下去。
  try {
    await launchReviewRound(task, run, {
      resumeSessionId: intent.resumeSessionId ?? undefined,
      retry: intent.retry,
      redeliver: {
        attempts: intent.attempts,
        since: intent.since,
        // 老行(加这一位之前写下的意图)没有记会话策略,按原公式回落 —— 当初唯一会把它压成
        // false 的就是补办自己,所以去掉那一项就是原值。
        freshSession: intent.freshSession
          ?? (!intent.retry && (run.currentRound === 1 || run.targetKind === "accepted_merge")),
      },
    });
  } catch (error) {
    // 起不来就按原路收尾(round→error、run→failed、写明原因),和首次派发失败同一条出路。
    // 认领要还回去:那一笔压根没排进等待队列,留着它只会让这一轮在本进程里永远「在途」。
    releaseReviewDispatchClaim(run.id, round.round);
    await failReviewStart(run, error instanceof Error ? error.message : String(error));
  }
  return "handled";
}

export async function nextRound(task: TaskRow, run: ReviewRunRow): Promise<void> {
  const round = run.currentRound + 1;
  const at = now();
  const nextRun = { ...run, status: "reviewing", currentRound: round, updatedAt: at };
  try {
    await db.insert(freeReviewRounds).values({
      id: id(), runId: run.id, round, status: "reviewing", conclusion: null, startedAt: at, endedAt: null,
    });
    await db.update(freeReviewRuns).set({ status: "reviewing", currentRound: round, updatedAt: at })
      .where(eq(freeReviewRuns.id, run.id));
    // 预约槽已由 startReservedFreeReview 在调用本函数**之前**按 CAS 消费掉（消费成功才
    // 会走到这里）。这里再无条件清一次，清掉的可能是用户中途保存的新预约（审查实测）。
    await launchReviewRound(task, nextRun);
  } catch (error) {
    await failReviewStart(nextRun, error instanceof Error ? error.message : String(error));
    throw error;
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
): string | null {
  if (!run) return "这个任务没有审查记录";
  if (run.status !== "failed") return "最近一轮审查没有停在异常结束状态";
  if (!round || round.status !== "error") return "最近一轮审查没有停在异常结束状态";
  return null;
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
 */
export async function reopenFailedFreeReview(
  taskId: string,
  opts: { holdTurn?: boolean; resumeSessionId?: string } = {},
): Promise<{ state: FreeWorkflowApiState; resumed: boolean }> {
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
      const blocker = freeReviewRetryBlocker(run, round);
      if (blocker) throw new Error(blocker);
      const at = now();
      const directory = freeReviewEvidenceDir(taskId, run!.id, run!.currentRound);
      await evidenceState(taskId, directory);
      await db.transaction(async (transaction) => {
        await restartRegressionEvidence(taskId, directory, transaction);
        await transaction.update(freeReviewRounds).set({ status: "reviewing", conclusion: null, endedAt: null })
          .where(eq(freeReviewRounds.id, round!.id));
        await transaction.update(freeReviewRuns).set({ status: "reviewing", updatedAt: at, finishedAt: null })
          .where(eq(freeReviewRuns.id, run!.id));
      }, { behavior: "immediate" });
      const revived = { ...run!, status: "reviewing", updatedAt: at, finishedAt: null };
      try {
        const { resumed } = await launchReviewRound(task, revived, { resumeSessionId: opts.resumeSessionId, retry: true });
        return { state: await freeWorkflowState(taskId), resumed };
      } catch (error) {
        // 起不来就把 run/round 放回 failed/error（否则它会永远挂在 reviewing，验收和
        // 再派审都被 hasActiveFreeReview 挡住）。
        await failReviewStart(revived, error instanceof Error ? error.message : String(error));
        throw error;
      }
    } finally {
      releaseFreeWorkflowAction(taskId);
    }
  } finally {
    if (turn) releaseTurn(taskId, turn);
  }
}

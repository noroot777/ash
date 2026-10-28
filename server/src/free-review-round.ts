// 自由工作流「一轮审查」的生命周期：查在跑的 run、起一轮、续下一轮、启动失败收尾，
// 以及**把崩掉的那一轮重新拉起来**（reopenFailedFreeReview）。
//
// 从 `free-workflow.ts` 切出来的原因：那份文件已经贴着 700 行上限，而重跑审查回合需要
// 复用 launchReviewRound/failReviewStart 这一组。依赖是单向的（free-workflow.ts →
// 本文件），`task-retry-turn.ts` 直接从这里取重跑入口，不用绕回去。
import type { AgentType } from "@ash/shared";
import { and, desc, eq } from "drizzle-orm";
import { ashMcpReachability } from "./ash-mcp-reachability.js";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { freeReviewRounds, freeReviewRuns, projects, sessions, tasks } from "./db/schema.js";
import { freeReviewPrompt, freeReviewResumeMessage } from "./free-review-prompts.js";
import { freeReviewEvidenceDir } from "./free-review-files.js";
import { evidenceState, restartRegressionEvidence } from "./regression-evidence-lifecycle.js";
import { releaseFreeWorkflowAction, tryAcquireFreeWorkflowAction } from "./free-workflow-lock.js";
import { freeWorkflowState, type FreeWorkflowApiState } from "./free-workflow-state.js";
import { headCommit } from "./git.js";
import { cleanupPostMergeReviewWorktree, preparePostMergeReviewWorktree } from "./post-merge-review-worktree.js";
import { claimTurn, continueWhenIdle, releaseTurn } from "./runs.js";
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

export async function failReviewStart(run: ReviewRunRow, message: string): Promise<void> {
  const at = now();
  await db.update(freeReviewRounds).set({ status: "error", endedAt: at })
    .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)));
  await db.update(freeReviewRuns).set({ status: "failed", updatedAt: at, finishedAt: at })
    .where(eq(freeReviewRuns.id, run.id));
  await stopReviewRunMonitors(run.id, "这次审查启动失败，它挂的哨兵一并收回");
  await appendTaskTimeline(run.taskId, `${run.targetKind === "accepted_merge" ? "合并结果" : `自由工作流第 ${run.currentRound} 轮`}审查启动失败：${message}`);
  await cleanupAcceptedMergeRun(run);
  bus.publish({ type: "task.review", taskId: run.taskId });
}


/** `launchReviewRound` 传给预检的候选目录。见下面那段注释，顺序必须跟 orchestrator 一致。 */
export type ReviewCwdSession = { id: string; cwd: string | null; worktreePath: string | null };

/**
 * 「这一轮会在哪跑」的候选目录，**顺序照抄 orchestrator 的 `recorded`**
 * （`orchestrator.ts`：`opts.cwd || prev?.cwd || prev?.worktreePath || all[0]?.cwd
 * || all[0]?.worktreePath`），末尾再补上任务工作区 —— 那是它兜底 materialize 的那个。
 *
 * 单独提出来是为了能被回归钉住：预检只有拿到**这一轮真正会用的目录**才问得对，而第 1 版
 * 传的 `cwd` 在普通工作区分支一直是 undefined，于是 `execFile` 继承了 server 进程的目录，
 * 任务目录里接好的 claude 被判成「没有登记」，派审当场失败（第 2 位审查者 F1）。
 * `sessions` 必须按 `startedAt` 倒序传进来（跟 orchestrator 的 `all` 同序）。
 */
export function reviewCwdCandidates(
  explicitCwd: string | undefined,
  resumeSessionId: string | undefined,
  sessionsDesc: ReviewCwdSession[],
  workspacePath: string | undefined,
): (string | null | undefined)[] {
  const prev = resumeSessionId ? sessionsDesc.find((s) => s.id === resumeSessionId) : undefined;
  return [
    explicitCwd,
    prev?.cwd, prev?.worktreePath,
    sessionsDesc[0]?.cwd, sessionsDesc[0]?.worktreePath,
    workspacePath,
  ];
}

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
  opts: { resumeSessionId?: string; retry?: boolean } = {},
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
  // 抛出去由三个调用点统一走 failReviewStart。
  //
  // **排在 cwd 算出来之后**：claude 的项目级登记（`--scope local`）只在那个目录下看得见，
  // 在它之前问等于拿「别的目录没有」去拦这一轮（第 1 轮审查 F1）。判据刻意保守 ——
  // 问的是 CLI 自己，而且只有它明确说「没有」才拦，见 ash-mcp-reachability.ts。
  // 候选目录按 orchestrator 挑目录的**同一条链**给（`orchestrator.ts` 的 `recorded`）：
  // 显式 cwd → 要续的那条会话 → 最近一条会话 → 任务工作区。只传单个 `cwd` 不够 ——
  // 普通工作区分支的 `cwd` 一直是 undefined，于是预检在 **server 进程**的目录里问，
  // 任务目录里接好的 claude 被判成没登记（第 2 位审查者 F1）。
  const sess = await db.select({ id: sessions.id, cwd: sessions.cwd, worktreePath: sessions.worktreePath })
    .from(sessions).where(eq(sessions.taskId, task.id)).orderBy(desc(sessions.startedAt));
  const reach = await ashMcpReachability({
    ownerUserId: task.ownerUserId,
    agentType: run.agentType,
    executorId: run.executorId,
    cwdCandidates: reviewCwdCandidates(cwd, opts.resumeSessionId, sess, workspacePath),
  });
  if (!reach.reachable) throw new Error(`审查者交不了卷：${reach.problem}`);
  const prompt = await freeReviewPrompt(task, run, run.currentRound, project?.repoPath ?? "(项目已不存在)");
  // 重跑分两档，差别不在按钮而在**送进去的那句话**：上下文还在就只说「接着做」（一条崩在
  // 10M token 上的审查，重来一次就是再烧 10M）；上下文是空的才把任务书整份重发。
  const resumed = !!opts.retry && !!opts.resumeSessionId && await reviewTurnResumable(task.id, opts.resumeSessionId);
  const label = run.targetKind === "accepted_merge" ? "合并结果审查" : `自由工作流第 ${run.currentRound} 轮审查`;
  await appendTaskTimeline(task.id, opts.retry
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
  continueWhenIdle(task.id, message, {
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
    freshSession: !opts.retry && (run.currentRound === 1 || run.targetKind === "accepted_merge"),
    resumeSessionId: opts.resumeSessionId,
    cwd,
    // 重跑这一路的预检查（freeReviewRetryBlocker）离真正拉起 CLI 很远，中间还要经过
    // 「先释放重试路由那把锁、排队再起」的交接——那段时间里分组可能已经被暂停。起跑前
    // 再核一遍冻结事实（turn-freeze.ts）；命中就撤回，这条链留在 failed，仍可再重试。
    freezeGuard: !!opts.retry,
  }, (error) => failReviewStart(run, error));
  return { resumed };
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
  const holdingTurn = opts.holdTurn === true;
  if (holdingTurn && !claimTurn(taskId, "dispatch")) throw new Error("任务回合正在进行，结束后再重跑");
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
    if (holdingTurn) releaseTurn(taskId);
  }
}

// 自由工作流「一轮审查」的生命周期：查在跑的 run、起一轮、续下一轮、启动失败收尾，
// 以及**把崩掉的那一轮重新拉起来**（reopenFailedFreeReview）。
//
// 从 `free-workflow.ts` 切出来的原因：那份文件已经贴着 700 行上限，而重跑审查回合需要
// 复用 launchReviewRound/failReviewStart 这一组。依赖是单向的（free-workflow.ts →
// 本文件），`task-retry-turn.ts` 直接从这里取重跑入口，不用绕回去。
import type { AgentType } from "@harness/shared";
import { and, desc, eq } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { freeReviewRounds, freeReviewRuns, projects, tasks } from "./db/schema.js";
import { freeReviewPrompt } from "./free-review-prompts.js";
import { releaseFreeWorkflowAction, tryAcquireFreeWorkflowAction } from "./free-workflow-lock.js";
import { freeWorkflowState, type FreeWorkflowApiState } from "./free-workflow-state.js";
import { headCommit } from "./git.js";
import { claimTurn, continueWhenIdle, releaseTurn } from "./runs.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { taskWorkspace } from "./task-workspace.js";
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

export async function roundOf(run: ReviewRunRow): Promise<ReviewRoundRow | null> {
  return (await db.select().from(freeReviewRounds)
    .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)))).at(0) ?? null;
}

export async function failReviewStart(run: ReviewRunRow, message: string): Promise<void> {
  const at = now();
  await db.update(freeReviewRounds).set({ status: "error", endedAt: at })
    .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)));
  await db.update(freeReviewRuns).set({ status: "failed", updatedAt: at, finishedAt: at })
    .where(eq(freeReviewRuns.id, run.id));
  await appendTaskTimeline(run.taskId, `自由工作流第 ${run.currentRound} 轮审查启动失败：${message}`);
  bus.publish({ type: "task.review", taskId: run.taskId });
}

export async function launchReviewRound(
  task: TaskRow,
  run: ReviewRunRow,
  // 重跑崩掉的那一轮时传：落回**那一条**审查会话（挑错人等于换个审查者从头看），
  // 且必须关掉 freshSession —— 第 1 轮崩了的话它本来会新开一条空会话。
  opts: { resumeSessionId?: string; retry?: boolean } = {},
): Promise<void> {
  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  // 锚定本轮结论的基准：审查启动时工作区的 HEAD。之后代码变没变、结论新不新鲜，
  // 全靠它跟当前 HEAD 比，不靠任何状态字段。取不到（工作区缺失）就留 null。
  if (project) {
    const workspace = await taskWorkspace(task, project.repoPath).catch(() => null);
    const head = workspace ? await headCommit(workspace.path) : null;
    if (head) {
      await db.update(freeReviewRounds).set({ reviewedCommit: head })
        .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)));
    }
  }
  const prompt = await freeReviewPrompt(task, run, run.currentRound, project?.repoPath ?? "(项目已不存在)");
  await appendTaskTimeline(task.id, opts.retry
    ? `自由工作流第 ${run.currentRound} 轮审查重跑上一回合：${run.reviewerName}。`
    : `自由工作流第 ${run.currentRound} 轮审查开始：${run.reviewerName} · ${run.checkMode === "logic" ? "逻辑检查" : "语法检查"}。`);
  bus.publish({ type: "task.review", taskId: task.id });
  continueWhenIdle(task.id, opts.retry ? `上一回合异常结束，本轮审查从头继续。\n\n${prompt}` : prompt, {
    system: "run",
    sideTurn: true,
    agent: run.agentType as AgentType,
    executorId: run.executorId,
    model: run.model,
    reasoningEffort: run.reasoningEffort,
    sessionRole: "reviewer",
    freshSession: !opts.retry && run.currentRound === 1,
    resumeSessionId: opts.resumeSessionId,
  }, (error) => failReviewStart(run, error));
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
 * 异常结束（退出码非零 / 启动失败），自动链已停」留下的痕迹。已给出结论的轮次
 * （passed/stopped）不在此列：那是正常结局，要再看一遍应该派新一轮审查。
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
 * 触发点是会话底部那颗「重跑上一回合」——审查会话异常结束时，用户看到的就是那条
 * reviewer 会话，重试语义只能是「让**同一位审查者**接着把这一轮跑完」。走新一轮
 * （nextRound）会白白吃掉一次复审额度，还会让 report.md 落到另一个 round 目录。
 */
export async function reopenFailedFreeReview(
  taskId: string,
  opts: { holdTurn?: boolean; resumeSessionId?: string } = {},
): Promise<FreeWorkflowApiState> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) throw new Error("任务不存在");
  if (task.mode !== "single" || task.parentId || task.reviewOf || task.workflowMode !== "free") {
    throw new Error("当前任务不是自由工作流");
  }
  if (task.archived) throw new Error("归档任务不能重跑审查");
  if (task.status === "running" || task.status === "queued") throw new Error("任务正在运行或排队，结束后再重跑");
  if (task.question || task.resumePrompt) throw new Error("任务正等待答复或续跑，处理后再重跑");
  // 与 free-workflow.ts 的 assertBeforeAcceptance 同判据；这里内联两行是为了让依赖保持
  // 单向（free-workflow.ts → 本文件），不为一个 if 造一条反向边。
  if (task.stage === "accepted" || task.stage === "merged") {
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
      await db.update(freeReviewRounds).set({ status: "reviewing", endedAt: null })
        .where(eq(freeReviewRounds.id, round!.id));
      await db.update(freeReviewRuns).set({ status: "reviewing", updatedAt: at, finishedAt: null })
        .where(eq(freeReviewRuns.id, run!.id));
      const revived = { ...run!, status: "reviewing", updatedAt: at, finishedAt: null };
      try {
        await launchReviewRound(task, revived, { resumeSessionId: opts.resumeSessionId, retry: true });
      } catch (error) {
        // 起不来就把 run/round 放回 failed/error（否则它会永远挂在 reviewing，验收和
        // 再派审都被 hasActiveFreeReview 挡住）。
        await failReviewStart(revived, error instanceof Error ? error.message : String(error));
        throw error;
      }
      return await freeWorkflowState(taskId);
    } finally {
      releaseFreeWorkflowAction(taskId);
    }
  } finally {
    if (holdingTurn) releaseTurn(taskId);
  }
}

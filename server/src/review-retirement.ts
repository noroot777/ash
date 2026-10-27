import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeReviewRounds, regressionEvidence, tasks } from "./db/schema.js";
import { activeReviewScope, type ReviewDelivery } from "./review-ownership.js";
import { assertConclusionTask } from "./regression-conclusion-commit.js";
import { RegressionConclusionRejected } from "./regression-conclusion-errors.js";
import { claimTurn, releaseTurn, type TurnSource } from "./runs.js";
import { announceResumePrompt } from "./task-resume-prompt.js";
import { clearReviewWait, reviewWaitForExit } from "./review-wait.js";
import { taskStartStatus } from "./task-start-status.js";
import { now } from "./util.js";
import { withTurnPreflight } from "./turn-entry-guard.js";

type TaskRow = typeof tasks.$inferSelect;
type EvidenceRow = typeof regressionEvidence.$inferSelect;

// 「这一轮已经收口了,别再开它」。两种形状都算:**有结算记录且不再 pending**,以及**压根
// 没有待结算的记录**(证据行不存在,或存在但从没落过结算)—— 后者就是轮次目录这套东西
// 上线之前跑完的那些老审查,它们一行证据都没留下。
//
// 漏掉后一种的代价实测过一次(2026-10-26):重启时的启动对账扫到全库 112 条历史审查任务,
// 因为「没有证据行」被当成「还没结算」逐条退休 —— 107 条 done 改写成 failed、5 条
// canceled 一并改写,updatedAt 全顶到当下。侧栏那头是双份后果:按更新时间倒序它们齐刷刷
// 窜到最前,而 failed 又在 keepVisibleInPreview 的豁免名单里,24 小时年龄闸从此折不掉。
// 对账里本来就有一道「没有证据行就跳过」的闸(regression-settlement.ts 的
// `!task.verifyRound && !state`),只是退休扫描排在它前面,先一步把人收走了。
//
// 退休要拦的是**在飞**的旧轮次:缺少目标身份、却还能靠等待/检查点以审查权限续跑的那种。
// 任务自己早已终态收尾、没有在飞的就地轮次(verifyRound)也没有检查点(resumePrompt)时,
// 没有任何东西可退休,改写它的终态只是在销毁历史结论。
function closedHistoricalReview(owner: TaskRow, state: EvidenceRow | undefined, free: boolean): boolean {
  return !free && state?.settlement?.pending !== true && !owner.verifyRound && !owner.resumePrompt
    && ["done", "failed", "canceled"].includes(owner.status);
}

export async function retireHistoricalReview(expected: TaskRow, source: TurnSource = { role: "single" },
  delivery?: ReviewDelivery, turnHeld = false): Promise<boolean> {
  if (delivery?.kind === "repair") return false;
  if (!expected.verifyRound && !expected.reviewOf && source.role !== "reviewer") return false;
  const candidate = await withTurnPreflight(expected.id, turnHeld, () => db.transaction(async (transaction) => {
    const scope = await activeReviewScope(transaction, expected, source);
    if (!scope) return;
    const evidence = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, scope.directory)))[0];
    if (closedHistoricalReview(expected, evidence, !!scope.run)) return;
    return !evidence?.targetIdentity && !evidence?.settlement?.target
      ? { ...scope, generation: evidence?.generation ?? null } : undefined;
  }, { behavior: "immediate" }));
  if (!candidate || (!turnHeld && !claimTurn(expected.id, source.role,
    source.role === "reviewer" && source.review !== "unbound" ? source.review : null))) return false;
  let retired = false;
  try {
    const owner = await db.transaction(async (transaction) => {
      await assertConclusionTask(transaction, expected);
      const current = (await transaction.select().from(tasks).where(eq(tasks.id, expected.id)))[0]!;
      const scope = await activeReviewScope(transaction, current, source);
      if (scope?.directory !== candidate.directory || current.resumePrompt !== expected.resumePrompt
        || current.resumePromptGeneration !== expected.resumePromptGeneration) return;
      const state = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, scope.directory)))[0];
      if (state?.targetIdentity || state?.settlement?.target || (state?.generation ?? null) !== candidate.generation) return;
      if (closedHistoricalReview(current, state, !!scope.run)) return;
      if (delivery && (delivery.generation !== (state?.generation ?? null)
        || (delivery.kind === "checkpoint" ? current.resumePrompt !== delivery.text
          || current.resumePromptGeneration !== delivery.promptGeneration
          : state?.continuation?.phase !== "delivery" || state.continuation.messageId !== delivery.messageId))) return;
      const freeRound = scope.run && (await transaction.select().from(freeReviewRounds)
        .where(and(eq(freeReviewRounds.runId, scope.run.id), eq(freeReviewRounds.round, scope.round))))[0];
      if (scope.run && freeRound?.status !== "reviewing") return;
      if (state?.settlement && (state.settlement.ownerTaskId !== current.id || state.settlement.round !== scope.round
        || state.settlement.freeRoundId !== freeRound?.id)) return;
      if (!state) await transaction.insert(regressionEvidence).values({ directory: scope.directory, taskId: scope.taskId,
        generation: randomUUID(), excludedMonitors: [], targetIdentity: null });
      const settlement = state?.settlement ?? { outcome: "failed" as const, conclusion: null,
        round: scope.round, ownerTaskId: current.id, pending: true, target: null,
        ...(freeRound ? { freeRoundId: freeRound.id } : {}),
      };
      const evidence = state ?? (await transaction.select().from(regressionEvidence)
        .where(eq(regressionEvidence.directory, scope.directory)))[0]!;
      const wait = await reviewWaitForExit(transaction, current, evidence);
      await transaction.update(regressionEvidence).set({ settlement: { ...settlement, pending: true },
        continuation: { ...state?.continuation, phase: "exited", wait } })
        .where(eq(regressionEvidence.directory, scope.directory));
      await clearReviewWait(transaction, current, evidence);
      const previous = taskStartStatus(current);
      const updated = await transaction.update(tasks).set({
        ...(current.reviewOf ? { status: settlement.outcome }
          : current.status === "queued" ? { status: previous === "queued" || previous === "running" ? "paused" : previous } : {}),
        updatedAt: now(),
      }).where(eq(tasks.id, current.id)).returning();
      return { task: updated[0]!, outcome: settlement.outcome };
    }, { behavior: "immediate" });
    if (!owner) return false;
    retired = true;
    await announceResumePrompt(owner.task.id);
    if (candidate.run) await (await import("./free-workflow.js")).handleFreeWorkflowSettlement(owner.task.id,
      owner.outcome, false, owner.outcome === "done", "reviewer");
    else if (owner.task.reviewOf) await (await import("./review-settlement.js")).finishReview(owner.task, owner.outcome);
    else await (await import("./review-settlement.js")).finishVerifyRound(owner.task, owner.outcome === "done");
    return true;
  } catch (error) {
    if (error instanceof RegressionConclusionRejected) return retired;
    retired = true;
    throw error;
  } finally {
    if (!turnHeld || retired) releaseTurn(expected.id);
  }
}

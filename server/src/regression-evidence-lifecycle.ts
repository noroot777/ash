import { randomUUID } from "node:crypto";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "./db/index.js";
import { monitors, projects, regressionEvidence, tasks } from "./db/schema.js";
import { regressionEvidenceReference } from "./regression-checks.js";
import { independentVerificationBasis, recheckIndependentBasis } from "./regression-conclusion-basis.js";
import { RegressionConclusionRejected } from "./regression-conclusion-errors.js";
import { REVIEWER_REGRESSION_CLAUSE } from "@ash/shared/free-workflow";
import type { IndependentVerificationBasis } from "./db/schema-regression-evidence.js";
import type { ConclusionTransaction } from "./regression-conclusion-commit.js";
import { reviewRoundDir } from "./review-evidence.js";
import { isTurnClaimed } from "./runs.js";
import { reviewTargetIdentity } from "./review-ownership.js";

/**
 * 这一轮审查的证据行（没有就建一个）。
 *
 * **新轮次不再写 `revoked`**（用户 2026-10-26 改口径）。原先的规则是：任务名下只要有过一条
 * 执行者回归登记，就把本轮标成 `revoked`，于是审查者上报 `verified` 必须附一份
 * `verificationBasis`（本轮自己 `start_monitor` 真实跑绿的 monitorIds）。那条闸的前提是
 * 「审查者本该独立重跑回归」；新口径恰好相反 —— 回归统一在验收时由验收前置命令跑，审查者
 * 一条都不跑，只核对执行者登记的结果。两者放在一起的直接后果是**审查者给不出通过结论**：
 * 执行者按新口径登记了自己新写的测试，`revoked` 就必然为真，而它又不许自己跑测试去凑
 * monitorIds。所以**只停掉写入**。
 *
 * **已经写进库的 `revoked=1` 仍然算数**，别把「以后不再写」读成「库里不可能有」—— 改口径
 * 那一刻线上有 167 行 revoked=1 且没依据，其中 1 条还属于正在跑的审查轮次（`TaESWHhrPOoa`
 * 的 free review 第 2 轮）。三层约束（本函数的预检、`regression-conclusion-commit` 的事务内
 * 提交、`completeRegressionSettlement` 的结算）因此都照旧读它：口径切换前开的旧轮次，结论
 * 仍要附一份本轮真实执行依据，不会被静默升级成「不用交了」。要的只是「依据」，**不是回归**
 * ——构建、接口冒烟、浏览器点检这些新口径下审查者本来就得做的执行都算，拒收文案也照这个
 * 口径写。于是 `revoked` 从一个活机制退化成**只读的祖父标记**：没有新的写入方，存量照旧生效。
 *
 * 新轮次这边，「通过结论得有真实执行依据」这条保证换了承载者：合并前由验收门禁
 * （`accept-gate`）真跑一遍项目的验收前置命令，比让每个审查者各自重跑更强。
 */
export async function evidenceState(taskId: string, directory: string, initialTarget?: typeof tasks.$inferSelect) {
  const existing = (await db.select().from(regressionEvidence).where(eq(regressionEvidence.directory, directory)))[0];
  if (existing) return existing;
  return db.transaction(async (transaction) => {
    const owners = [taskId, ...(await transaction.select({ id: tasks.id }).from(tasks).where(eq(tasks.reviewOf, taskId))).map((task) => task.id)];
    await transaction.insert(regressionEvidence).values({ directory, taskId, generation: randomUUID(),
      targetIdentity: initialTarget ? reviewTargetIdentity(initialTarget) : null, continuation: { phase: "running" },
      excludedMonitors: (await transaction.select({ id: monitors.id }).from(monitors).where(inArray(monitors.taskId, owners))).map((monitor) => monitor.id),
    }).onConflictDoNothing();
    return (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, directory)))[0]!;
  }, { behavior: "immediate" });
}

export async function restartRegressionEvidence(taskId: string, directory: string, transaction: ConclusionTransaction): Promise<void> {
  const target = (await transaction.select().from(tasks).where(eq(tasks.id, taskId)))[0];
  const owners = [taskId, ...(await transaction.select({ id: tasks.id }).from(tasks)
    .where(eq(tasks.reviewOf, taskId))).map((task) => task.id)];
  await transaction.update(regressionEvidence).set({ generation: randomUUID(), acceptedBasis: null, settlement: null, finalization: null,
    targetIdentity: target ? reviewTargetIdentity(target) : null, continuation: { phase: "running" },
    excludedMonitors: (await transaction.select({ id: monitors.id }).from(monitors)
      .where(inArray(monitors.taskId, owners))).map((monitor) => monitor.id),
  }).where(eq(regressionEvidence.directory, directory));
}

export async function refreshRegressionEvidence(taskId: string, directory: string, acceptedMerge = false) {
  await evidenceState(taskId, directory);
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0];
  const project = task && (await db.select().from(projects).where(eq(projects.id, task.projectId)))[0];
  let reference: string;
  try {
    if (!task) throw new Error("被审任务不存在");
    reference = await regressionEvidenceReference(task, project?.repoPath ?? "", directory, acceptedMerge);
    await db.update(regressionEvidence).set({ unavailable: reference.startsWith("回归证据清单不可用") ? reference : null })
      .where(eq(regressionEvidence.directory, directory));
  } catch (error) {
    const unavailable = error instanceof Error ? error.message : String(error);
    await db.update(regressionEvidence).set({ unavailable }).where(eq(regressionEvidence.directory, directory));
    // 清单读不出来时也得把口径说一遍：续跑那一路只有这一句在讲回归（扫描义务缩略版不带回归
    // 面），不说的话审查者拿不到「别自己跑」这条约束，只会自己补一轮测试。
    reference = `回归诊断清单不可用（不等于验证失败）：${unavailable}。` + REVIEWER_REGRESSION_CLAUSE;
  }
  return { reference };
}

export type CheckedConclusion = {
  directory: string;
  taskId: string;
  generation: string;
  stage: string;
  basis: IndependentVerificationBasis | null;
} | undefined;

export async function checkRegressionConclusion(taskId: string, directory: string, stage: string,
  basis?: unknown, settlement = false): Promise<CheckedConclusion> {
  if (stage !== "verified" && (stage !== "verify_failed" || settlement)) return;
  const state = await evidenceState(taskId, directory);
  const checked = { directory, taskId, generation: state.generation, stage, basis: null };
  if (stage === "verify_failed") return checked;
  // `basis`（report_stage 的 verificationBasis）在**新轮次**上没有任何门禁要求它。它还留着为三件
  // 事：口径切换前的旧轮次（`revoked=1`，见下）仍要交一份；**重放**旧回合落在 rollout 里、还没
  // 投递成功的 report_stage 调用（它可能带着当时那份 basis）；以及一旦带了就按原标准核验，不让
  // 一份糊的凭据被当成真的。它不是「审查者可以自己跑回归」的后门 —— 交的是本轮真实执行，不限回归。
  if (settlement && state.acceptedBasis) {
    await recheckIndependentBasis(state);
    return;
  }
  if (basis !== undefined) {
    const acceptedBasis = await independentVerificationBasis(state, basis);
    return { ...checked, basis: acceptedBasis };
  }
  // 祖父标记：口径切换前开的旧轮次（见本文件 `evidenceState` 的说明）。要一份依据，不是要回归。
  if (state.revoked) throw new RegressionConclusionRejected(`这是回归口径切换前开的旧审查轮次（generation=${state.generation}）：`
    + "通过结论要附一份**本轮真实执行**的依据，用 report_stage 的 verificationBasis 交 monitorIds。"
    + "构建、接口冒烟、浏览器点检这类你本来就要做的检查都算 —— **不要为此去跑回归**（回归统一在验收时由验收前置命令执行）；"
    + "慢的那条用 start_monitor 挂起来跑，它的 monitorId 就是依据。重试、补录、删清单或更新报告都不能代替一次真实执行");
  return settlement ? undefined : checked;
}

export async function latestPresetConclusionRound(task: typeof tasks.$inferSelect, query: Pick<typeof db, "select"> = db) {
  if (task.verifyRound) return { round: task.verifyRound, reviewTaskId: null };
  const review = (await query.select({ round: tasks.reviewRound, reviewTaskId: tasks.id }).from(tasks)
    .where(eq(tasks.reviewOf, task.id)).orderBy(desc(tasks.reviewRound)).limit(1))[0];
  return review?.round ? { round: review.round, reviewTaskId: review.reviewTaskId } : null;
}

export async function presetConclusionRound(task: typeof tasks.$inferSelect, query: Pick<typeof db, "select"> = db,
  sourceTaskId?: string) {
  if (task.verifyRound) return { round: task.verifyRound, reviewTaskId: null };
  if (sourceTaskId === task.id || (!sourceTaskId && isTurnClaimed(task.id))) return null;
  const reviews = await query.select().from(tasks).where(eq(tasks.reviewOf, task.id)).orderBy(desc(tasks.reviewRound));
  const review = reviews.find((candidate) => (!sourceTaskId || candidate.id === sourceTaskId) && candidate.reviewRound &&
    (["running", "queued", "paused"].includes(candidate.status) || isTurnClaimed(candidate.id)));
  return review ? { round: review.reviewRound!, reviewTaskId: review.id,
    turnToken: review.activeTurnToken, directionToken: review.activeDirectionToken,
    directionVersion: review.activeDirectionVersion, directionEpoch: review.directionEpoch } : null;
}

export async function checkPresetRegressionConclusion(taskId: string, stage: string, basis?: unknown): Promise<CheckedConclusion> {
  if (stage !== "verified" && stage !== "verify_failed") return;
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0];
  const scope = task && await presetConclusionRound(task);
  if (scope) return checkRegressionConclusion(taskId, reviewRoundDir(taskId, scope.round), stage, basis);
}

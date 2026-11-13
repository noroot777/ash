import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { projects, regressionEvidence, tasks } from "./db/schema.js";
import { regressionEvidenceReference, regressionManifestPath } from "./regression-checks.js";
import { REVIEWER_REGRESSION_CLAUSE, regressionManifestEntry } from "@ash/shared/free-workflow";
import type { ConclusionTransaction } from "./regression-conclusion-commit.js";
import { reviewRoundDir } from "./review-evidence.js";
import { isTurnClaimed } from "./runs.js";
import { reviewTargetIdentity } from "./review-ownership.js";

/**
 * 这一轮审查的证据行（没有就建一个）。
 *
 * `revoked` / `excluded_monitors` / `accepted_basis` 三列只服务 2026-10-26 回归改口径之前的
 * 「审查者交独立执行依据」那道闸，已经没有读取方（存量照旧留在库里）；「通过结论得有真实执行
 * 依据」由验收门禁（`accept-gate`）在合并前真跑验收前置命令来保证。
 */
export async function evidenceState(taskId: string, directory: string, initialTarget?: typeof tasks.$inferSelect) {
  const existing = (await db.select().from(regressionEvidence).where(eq(regressionEvidence.directory, directory)))[0];
  if (existing) return existing;
  return db.transaction(async (transaction) => {
    await transaction.insert(regressionEvidence).values({ directory, taskId, generation: randomUUID(),
      targetIdentity: initialTarget ? reviewTargetIdentity(initialTarget) : null, continuation: { phase: "running" },
      excludedMonitors: [],
    }).onConflictDoNothing();
    return (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, directory)))[0]!;
  }, { behavior: "immediate" });
}

/**
 * 换代次 —— **返回新的那一个**。调用方要它不是为了记日志:重跑那一笔换完代次之后,必须在
 * **同一段同步代码**里按新代次抢下派发认领(见 free-review-dispatch.ts 的
 * `supersedeReviewDispatch`),中间插进任何一次 await 就会开出「谁都没在负责」的窗口给对账收尸。
 */
export async function restartRegressionEvidence(taskId: string, directory: string, transaction: ConclusionTransaction): Promise<string> {
  const target = (await transaction.select().from(tasks).where(eq(tasks.id, taskId)))[0];
  const generation = randomUUID();
  await transaction.update(regressionEvidence).set({ generation, settlement: null, finalization: null,
    targetIdentity: target ? reviewTargetIdentity(target) : null, continuation: { phase: "running" },
  }).where(eq(regressionEvidence.directory, directory));
  return generation;
}

export async function refreshRegressionEvidence(
  taskId: string, directory: string, acceptedMerge = false,
  /** 见 `regressionEvidenceReference`：正文里已经有完整验证口径时传 false。 */
  restatePolicy = true,
) {
  await evidenceState(taskId, directory);
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0];
  const project = task && (await db.select().from(projects).where(eq(projects.id, task.projectId)))[0];
  let reference: string;
  try {
    if (!task) throw new Error("被审任务不存在");
    reference = await regressionEvidenceReference(task, project?.repoPath ?? "", directory, acceptedMerge, restatePolicy);
    await db.update(regressionEvidence).set({ unavailable: reference.startsWith("回归证据清单不可用") ? reference : null })
      .where(eq(regressionEvidence.directory, directory));
  } catch (error) {
    const unavailable = error instanceof Error ? error.message : String(error);
    await db.update(regressionEvidence).set({ unavailable }).where(eq(regressionEvidence.directory, directory));
    // 清单读不出来时也得把口径说一遍：续跑那一路只有这一句在讲回归（扫描义务缩略版不带回归
    // 面），不说的话审查者拿不到「别自己跑」这条约束，只会自己补一轮测试。
    reference = `回归诊断清单不可用（不等于验证失败）：${unavailable}。` + REVIEWER_REGRESSION_CLAUSE;
  }
  // 入口**构造出来**再比对，不从正文里反解：拼装层要判「这一句是不是正文里已有的那一句」，
  // 判据必须是整串相等。按「第一个句号」去切会在目录名含「。」时切出半条路径，于是两条
  // 不同路径被当成同一个入口（第 1 轮审查复现）。清单不可用那一路没有入口，返回 null ——
  // 没有入口就永远不参与去重，本轮的状态警告一定发得出去。
  const entry = regressionManifestEntry(regressionManifestPath(directory));
  return { reference, manifestEntry: reference.includes(entry) ? entry : null };
}

export type CheckedConclusion = {
  directory: string;
  taskId: string;
  generation: string;
  stage: string;
} | undefined;

export async function checkRegressionConclusion(taskId: string, directory: string, stage: string): Promise<CheckedConclusion> {
  if (stage !== "verified" && stage !== "verify_failed") return;
  const state = await evidenceState(taskId, directory);
  return { directory, taskId, generation: state.generation, stage };
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

export async function checkPresetRegressionConclusion(taskId: string, stage: string): Promise<CheckedConclusion> {
  if (stage !== "verified" && stage !== "verify_failed") return;
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0];
  const scope = task && await presetConclusionRound(task);
  if (scope) return checkRegressionConclusion(taskId, reviewRoundDir(taskId, scope.round), stage);
}

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "./db/index.js";
import { monitors, projects, regressionChecks, regressionEvidence, tasks } from "./db/schema.js";
import { regressionEvidenceReference } from "./regression-checks.js";
import { independentVerificationBasis, recheckIndependentBasis } from "./regression-conclusion-basis.js";
import { RegressionConclusionRejected } from "./regression-conclusion-errors.js";
import type { IndependentVerificationBasis } from "./db/schema-regression-evidence.js";
import type { ConclusionTransaction } from "./regression-conclusion-commit.js";
import { reviewRoundDir, safeRunDirectory } from "./review-evidence.js";
import { isTurnClaimed } from "./runs.js";
import { reviewTargetIdentity } from "./review-ownership.js";

async function manifestPermission(directory: string): Promise<"revoked" | "none"> {
  if (!(await safeRunDirectory(directory))) {
    try { await lstat(directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "none";
      throw error;
    }
    throw new Error("回归证据目录安全检查不通过");
  }
  try {
    const path = join(directory, "regression-evidence.json");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error("回归清单不是安全的普通文件");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) throw new Error("回归清单不是普通文件");
      const manifest = JSON.parse(await handle.readFile("utf8")) as { records?: Array<{ reusable?: boolean }> };
      return !Array.isArray(manifest.records) || manifest.records.some((record) => record.reusable === true) ? "revoked" : "none";
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "none";
    throw error;
  }
}

export async function evidenceState(taskId: string, directory: string, acceptedMerge: boolean, initialTarget?: typeof tasks.$inferSelect) {
  const existing = (await db.select().from(regressionEvidence).where(eq(regressionEvidence.directory, directory)))[0];
  if (existing) return existing;
  return db.transaction(async (transaction) => {
    const history = acceptedMerge ? [] : await transaction.select({ id: regressionChecks.monitorId }).from(regressionChecks)
      .where(eq(regressionChecks.taskId, taskId)).limit(1);
    const owners = [taskId, ...(await transaction.select({ id: tasks.id }).from(tasks).where(eq(tasks.reviewOf, taskId))).map((task) => task.id)];
    await transaction.insert(regressionEvidence).values({ directory, taskId, generation: randomUUID(), revoked: history.length > 0,
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

async function observeEvidence(taskId: string, directory: string, acceptedMerge: boolean) {
  await evidenceState(taskId, directory, acceptedMerge);
  let unavailable: string | null = null;
  let revoked = false;
  if (!acceptedMerge) {
    try { revoked = await manifestPermission(directory) === "revoked"; }
    catch (error) { unavailable = error instanceof Error ? error.message : String(error); }
  }
  if (revoked || unavailable) await db.update(regressionEvidence)
    .set({ ...(revoked ? { revoked: true } : {}), ...(unavailable ? { unavailable } : {}) })
    .where(eq(regressionEvidence.directory, directory));
  return (await db.select().from(regressionEvidence).where(eq(regressionEvidence.directory, directory)))[0]!;
}

export async function refreshRegressionEvidence(taskId: string, directory: string, acceptedMerge = false) {
  const state = await observeEvidence(taskId, directory, acceptedMerge);
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0];
  const project = task && (await db.select().from(projects).where(eq(projects.id, task.projectId)))[0];
  let reference: string;
  try {
    if (!task) throw new Error("被审任务不存在");
    reference = await regressionEvidenceReference(task, project?.repoPath ?? "", directory, acceptedMerge, {
      generation: state.generation, independentRequired: state.revoked,
      acceptedMonitorIds: state.acceptedBasis?.monitors.map((monitor) => monitor.id) ?? [],
    });
    await db.update(regressionEvidence).set({ unavailable: reference.startsWith("回归证据清单不可用") ? reference : null })
      .where(eq(regressionEvidence.directory, directory));
  } catch (error) {
    const unavailable = error instanceof Error ? error.message : String(error);
    await db.update(regressionEvidence).set({ unavailable }).where(eq(regressionEvidence.directory, directory));
    reference = `回归诊断清单不可用（不等于独立验证失败），禁止复用旧清单：${unavailable}`;
  }
  if (state.revoked) reference += `\n旧回归复用资格已撤销并持久保存。本轮独立验证 generation=${state.generation}；` +
    '通过 start_monitor 执行本轮必要检查（不设提前结束条件），正常退出后用 report_stage 的 verificationBasis=' +
    `{"kind":"independent","generation":"${state.generation}","monitorIds":["新执行的哨兵 id"]} 上报实际依据；重读或改写清单不能解除撤销。`;
  return { reference, revoked: state.revoked };
}

export type CheckedConclusion = {
  directory: string;
  taskId: string;
  generation: string;
  stage: string;
  basis: IndependentVerificationBasis | null;
} | undefined;

export async function checkRegressionConclusion(taskId: string, directory: string, stage: string, acceptedMerge = false,
  basis?: unknown, settlement = false): Promise<CheckedConclusion> {
  if (stage !== "verified" && (stage !== "verify_failed" || settlement)) return;
  const state = await observeEvidence(taskId, directory, acceptedMerge);
  const checked = { directory, taskId, generation: state.generation, stage, basis: null };
  if (stage === "verify_failed") return checked;
  if (settlement && state.acceptedBasis) {
    await recheckIndependentBasis(state);
    return;
  }
  if (basis !== undefined) {
    const acceptedBasis = await independentVerificationBasis(state, basis);
    return { ...checked, basis: acceptedBasis };
  }
  if (state.revoked) throw new RegressionConclusionRejected(`旧回归复用资格已撤销：generation=${state.generation}；` +
    "请独立执行本轮检查，以 verificationBasis 提交新执行的 monitorIds。重试、补录、清单删除或更新报告不能代替验证");
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
  if (scope) return checkRegressionConclusion(taskId, reviewRoundDir(taskId, scope.round), stage, false, basis);
}

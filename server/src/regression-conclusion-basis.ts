import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import { db } from "./db/index.js";
import { monitors, tasks } from "./db/schema.js";
import type { IndependentVerificationBasis, regressionEvidence } from "./db/schema-regression-evidence.js";
import { reviewRoundDir, safeRunDirectory } from "./review-evidence.js";
import { freeReviewEvidenceDir } from "./free-review-files.js";
import { RegressionConclusionRejected, RegressionEvidenceUnavailable } from "./regression-conclusion-errors.js";

type EvidenceState = typeof regressionEvidence.$inferSelect;
type Monitor = typeof monitors.$inferSelect;

function requireComplete(monitor: Monitor | undefined, state: EvidenceState): asserts monitor is Monitor & { unitToken: string } {
  if (!monitor || state.excludedMonitors.includes(monitor.id) || !monitor.unitToken
    || monitor.status !== "exited" || monitor.exitCode !== 0 || !monitor.endedAt || monitor.stopWhen) {
    throw new RegressionConclusionRejected(`独立验证 ${monitor?.id ?? "unknown"} 不存在、不是本代次的新执行、未完整通过或提前结束`);
  }
}

async function verificationDigest(path: string): Promise<string> {
  try {
    if (!(await safeRunDirectory(dirname(path)))) throw new Error("日志目录不可用或不安全");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) throw new Error("日志不是普通文件");
      const digest = createHash("sha256");
      for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
      return digest.digest("hex");
    } finally { await handle.close(); }
  } catch (error) {
    throw new RegressionEvidenceUnavailable(`独立验证日志暂不可用 ${path}：${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function independentVerificationBasis(state: EvidenceState, input: unknown): Promise<IndependentVerificationBasis> {
  const basis = input as { kind?: unknown; generation?: unknown; monitorIds?: unknown } | null;
  if (basis?.kind !== "independent" || basis.generation !== state.generation || !Array.isArray(basis.monitorIds)
    || !basis.monitorIds.length || basis.monitorIds.some((monitorId) => typeof monitorId !== "string")) {
    throw new RegressionConclusionRejected("独立验证依据无效：需要本轮 generation 和新执行的 monitorIds，不能以重读清单、重复请求或报告存在代替验证");
  }
  const receipts: IndependentVerificationBasis["monitors"] = [];
  for (const monitorId of new Set(basis.monitorIds as string[])) {
    const monitor = (await db.select().from(monitors).where(eq(monitors.id, monitorId)))[0];
    requireComplete(monitor, state);
    const owner = (await db.select().from(tasks).where(eq(tasks.id, monitor.taskId)))[0];
    const directory = monitor.sourceReviewRun && monitor.sourceReviewRound
      ? freeReviewEvidenceDir(state.taskId, monitor.sourceReviewRun, monitor.sourceReviewRound)
      : owner?.reviewOf === state.taskId && owner.reviewRound
        ? reviewRoundDir(state.taskId, owner.reviewRound)
        : owner?.id === state.taskId && owner.verifyRound
          ? reviewRoundDir(state.taskId, owner.verifyRound) : null;
    if (directory !== state.directory || (monitor.sourceReviewRun && monitor.sourceRole !== "reviewer")) {
      throw new RegressionConclusionRejected(`独立验证 ${monitorId} 不属于当前审查轮次`);
    }
    const digest = await verificationDigest(monitor.logPath);
    receipts.push({ id: monitorId, unitToken: monitor.unitToken, digest });
  }
  return { kind: "independent", generation: state.generation, monitors: receipts };
}

export async function recheckIndependentBasis(state: EvidenceState): Promise<void> {
  const accepted = state.acceptedBasis;
  if (!accepted) throw new RegressionConclusionRejected("没有独立验证依据");
  if (accepted.generation !== state.generation) throw new RegressionConclusionRejected("独立验证证据代次已变化");
  for (const receipt of accepted.monitors) {
    const monitor = (await db.select().from(monitors).where(eq(monitors.id, receipt.id)))[0];
    requireComplete(monitor, state);
    if (monitor.unitToken !== receipt.unitToken || await verificationDigest(monitor.logPath) !== receipt.digest) {
      throw new RegressionConclusionRejected("独立验证依据已变化，不能消费原通过结论");
    }
  }
}

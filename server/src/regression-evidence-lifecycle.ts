import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { desc, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";
import { regressionEvidenceReference } from "./regression-checks.js";
import { reviewRoundDir, safeRunDirectory } from "./review-evidence.js";

async function hadReusePermission(directory: string): Promise<boolean> {
  if (!(await safeRunDirectory(directory))) {
    try {
      await lstat(directory);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  }
  try {
    const path = join(directory, "regression-evidence.json");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) return true;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) return true;
      const manifest = JSON.parse(await handle.readFile("utf8")) as { records?: Array<{ reusable?: boolean }> };
      return !Array.isArray(manifest.records) || manifest.records.some((record) => record.reusable === true);
    } finally {
      await handle.close();
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

export async function refreshRegressionEvidence(taskId: string, directory: string, acceptedMerge = false): Promise<{
  reference: string;
  revoked: boolean;
}> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0];
  if (!task) return { reference: "被审任务不存在，回归证据不可用，禁止复用旧清单。", revoked: true };
  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId)))[0];
  const revoked = await hadReusePermission(directory);
  try {
    const reference = await regressionEvidenceReference(task, project?.repoPath ?? "", directory, acceptedMerge);
    return { reference, revoked: revoked || !(await safeRunDirectory(directory)) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { reference: `回归证据重新核验失败，禁止复用旧清单，请按缺口补跑：${message}`, revoked: true };
  }
}

export async function checkRegressionConclusion(taskId: string, directory: string, stage: string, acceptedMerge = false): Promise<void> {
  const { revoked } = await refreshRegressionEvidence(taskId, directory, acceptedMerge);
  if (stage === "verified" && revoked) {
    throw new Error(`旧回归复用资格已撤销：请重新读取 ${join(directory, "regression-evidence.json")}，补跑缺口、更新报告后再上报结论`);
  }
}

export async function checkPresetRegressionConclusion(taskId: string, stage: string): Promise<void> {
  if (stage !== "verified" && stage !== "verify_failed") return;
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0];
  const round = task?.verifyRound ?? (await db.select({ round: tasks.reviewRound }).from(tasks)
    .where(eq(tasks.reviewOf, taskId)).orderBy(desc(tasks.reviewRound)).limit(1))[0]?.round;
  if (round) await checkRegressionConclusion(taskId, reviewRoundDir(taskId, round), stage);
}

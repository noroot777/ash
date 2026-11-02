import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { desc, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { resolveAshDbFile } from "./db/path.js";
import { monitors, regressionChecks, tasks } from "./db/schema.js";
import {
  REGRESSION_MANIFEST_READING,
  REVIEWER_REGRESSION_CLAUSE,
  regressionManifestEntry,
} from "@ash/shared/free-workflow";
import { RUNS_DIR } from "./paths.js";
import { previewShell } from "./preview-shell.js";
import { taskWorkspace } from "./task-workspace.js";
import { replaceEvidenceFile, safeRunDirectory } from "./review-evidence.js";
import { regressionLogDigest } from "./regression-files.js";
import { regressionSnapshot } from "./regression-snapshot.js";
import { regressionInputIdentity, regressionInputRejection } from "./regression-input.js";

export type RegressionRecord = typeof regressionChecks.$inferSelect;

export async function prepareRegressionCommand(taskId: string, monitorId: string, command: string, cwd: string, role: string): Promise<string> {
  const directory = join(RUNS_DIR, taskId, "regression");
  if (!(await safeRunDirectory(directory, true))) throw new Error("回归证据目录安全检查不通过，拒绝登记");
  const shell = previewShell();
  if (!shell.expressible(process.execPath)) throw new Error("当前 Node 绝对路径无法安全传给系统 shell");
  const built = fileURLToPath(new URL("./regression-worker.js", import.meta.url));
  const worker = existsSync(built) ? built : fileURLToPath(new URL("./regression-worker.ts", import.meta.url));
  const loader = existsSync(built) ? [] : ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href];
  const script = `const result=require('node:child_process').spawnSync(${JSON.stringify(process.execPath)},` +
    `${JSON.stringify([...loader, worker, monitorId])},{stdio:'inherit',env:{...process.env,ASH_DB:${JSON.stringify(resolveAshDbFile())}}});process.exit(result.status??1)`;
  const encoded = Buffer.from(script).toString("base64");
  await db.insert(regressionChecks).values({
    taskId, monitorId, role, command, cwd, inputIdentity: regressionInputIdentity(),
    logPath: join(directory, `${monitorId}.log`), createdAt: new Date().toISOString(),
  });
  return `${shell.quote(process.execPath)} -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}

/**
 * 这份清单落在哪 —— 写它的人和「这一句入口是什么」的人共用这一处。
 *
 * 去重要拿**完整入口**整串比对（见 `turn-prompt.ts`），而完整入口 = 前缀 + 这个路径；
 * 两边各拼一次路径就会漂移，所以路径只在这里拼一次。
 */
export const regressionManifestPath = (evidenceDir: string): string =>
  join(evidenceDir, "regression-evidence.json");

export async function regressionEvidenceReference(
  task: typeof tasks.$inferSelect, repoPath: string, evidenceDir: string, acceptedMerge = false,
  // 同一条消息里已经有 `REVIEW_VALIDATION_REQUIREMENT`（派审正文、就地验证正文）时传 false：
  // 口径只讲一遍。每回合提醒那两条消息里没有它，仍然要由这份清单说明把口径带上。
  restatePolicy = true,
): Promise<string> {
  const clause = restatePolicy ? REVIEWER_REGRESSION_CLAUSE : "";
  if (acceptedMerge) return "合并结果审查没有执行者登记清单可核对，回归面整面留白。" + clause;
  if (!(await safeRunDirectory(evidenceDir, true))) return "回归证据清单不可用：目录安全检查不通过；把回归面写成留白，不要自己跑测试去填。";
  const rows = acceptedMerge ? [] : await db.select().from(regressionChecks).where(eq(regressionChecks.taskId, task.id))
    .orderBy(desc(regressionChecks.generation));
  const workspace = rows.length ? await taskWorkspace(task, repoPath).catch(() => null) : null;
  const snapshot = workspace ? regressionSnapshot(workspace.path) : null;
  const facts = new Map((await db.select().from(monitors).where(eq(monitors.taskId, task.id))).map((row) => [row.id, row]));
  const records: Array<RegressionRecord & { reusable: false; passed: boolean | null; reason: string; latest: boolean; supersededBy: string | null }> = [];
  const latestByCommand = new Map<string, string>();
  for (const record of rows) {
    const fact = facts.get(record.monitorId);
    if (!["single", "implementer"].includes(record.role) || !fact || fact.sourceRole === "reviewer" || fact.sourceReviewRun) continue;
    const completed = fact.status === "exited" && !!record.endedAt && record.exitCode !== null && fact.exitCode === record.exitCode && !record.error;
    const sameTree = !!snapshot && record.before?.tree === snapshot.tree && record.after?.tree === snapshot.tree;
    const location = workspace ? relative(resolve(workspace.path), resolve(record.cwd)) : "..";
    const sameWorkspace = !!workspace && location !== ".." && !location.startsWith(`..${sep}`) && !isAbsolute(location);
    const logged = !!record.logDigest && record.logDigest === await regressionLogDigest(record.logPath);
    const passed = completed ? record.exitCode === 0 : null;
    const result = !completed ? `未正常完成（exitCode=${record.exitCode}）` : `${passed ? "通过" : "失败"}（exitCode=${record.exitCode}）`;
    const reason = !sameTree ? "代码树已变或无法核实" : !sameWorkspace ? "工作目录不同" : !logged ? "日志缺失、损坏或目录不安全" : "测试前后与当前代码树一致";
    const key = JSON.stringify([record.command, record.cwd]);
    const supersededBy = latestByCommand.get(key) ?? null;
    latestByCommand.set(key, supersededBy ?? record.monitorId);
    records.push({ ...record, reusable: false, passed, latest: supersededBy === null, supersededBy,
      reason: `${result}；${reason}；${regressionInputRejection(record.inputIdentity)}` });
  }
  const path = regressionManifestPath(evidenceDir);
  if (!(await safeRunDirectory(evidenceDir))) return "回归证据清单不可用：写入前目录安全检查不通过；把回归面写成留白，不要自己跑测试去填。";
  await replaceEvidenceFile(path, JSON.stringify({ protocol: 2, inputPolicy: "immutable-closed-inputs-required",
    taskId: task.id, generatedAt: new Date().toISOString(), acceptedMerge, snapshot, records }, null, 2));
  // 「为什么 reusable 恒为 false」「generation 怎么分配」「后端凭什么说自己是权威」这些
  // **论证与实现说明**不进正文（它们是讲给维护者的，不是给模型的指令），留在本文件头与
  // `regression-evidence-lifecycle.ts`。正文只留读这份清单时用得上的几条判据。
  // 入口那一句（动态：路径随轮次变）和读法全文（静态判据）分开拼：每回合提醒里的这一份
  // 要不要去重，判据不一样 —— 读法正文讲过就够，入口与**本轮状态**必须跟着提醒走
  // （两者都在 `@ash/shared/free-workflow`，去重判据在 `turn-prompt.ts`）。
  return regressionManifestEntry(path) + clause + REGRESSION_MANIFEST_READING;
}

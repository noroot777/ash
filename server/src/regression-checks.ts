import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { desc, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { resolveAshDbFile } from "./db/path.js";
import { monitors, regressionChecks, tasks } from "./db/schema.js";
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
  const loader = existsSync(built) ? [] : ["--import", createRequire(import.meta.url).resolve("tsx/esm")];
  const script = `const result=require('node:child_process').spawnSync(${JSON.stringify(process.execPath)},` +
    `${JSON.stringify([...loader, worker, monitorId])},{stdio:'inherit',env:{...process.env,ASH_DB:${JSON.stringify(resolveAshDbFile())}}});process.exit(result.status??1)`;
  const encoded = Buffer.from(script).toString("base64");
  await db.insert(regressionChecks).values({
    taskId, monitorId, role, command, cwd, inputIdentity: regressionInputIdentity(),
    logPath: join(directory, `${monitorId}.log`), createdAt: new Date().toISOString(),
  });
  return `${shell.quote(process.execPath)} -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}

export async function regressionEvidenceReference(
  task: typeof tasks.$inferSelect, repoPath: string, evidenceDir: string, acceptedMerge = false,
): Promise<string> {
  if (!(await safeRunDirectory(evidenceDir, true))) return "回归证据清单不可用：目录安全检查不通过，禁止复用旧清单，请按缺口补跑。";
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
  const path = join(evidenceDir, "regression-evidence.json");
  if (!(await safeRunDirectory(evidenceDir))) return "回归证据清单不可用：写入前目录安全检查不通过，禁止复用旧清单，请按缺口补跑。";
  await replaceEvidenceFile(path, JSON.stringify({ protocol: 2, inputPolicy: "immutable-closed-inputs-required",
    taskId: task.id, generatedAt: new Date().toISOString(), acceptedMerge, snapshot, records }, null, 2));
  if (acceptedMerge) return "合并结果审查不得复用任务分支的回归结果，必须检查当前合并快照。";
  return `执行者回归证据清单：${path}。后端以数据库中的执行者身份、原始命令、真实退出码和代码树为权威，并校验完整日志摘要。` +
    "reusable=true 只表示证据可引用，不代表测试通过；通过必须同时满足 passed=true 且 exitCode=0，失败必须照实报告，不得给通过结论。" +
    "当前 runner 没有不可变且闭合的输入证明，所有记录均禁止自动复用；前后 Git 树相等不构成证明。" +
    "generation 是数据库分配的单调登记代次，latest 标记同命令/目录的最新登记，旧失败仍完整保留，未完成的新代次也不能回退到旧通过。" +
    "按 logPath 读取完整输出；清单为空或失效时按缺口补跑，不能用对话自述、被改写的 JSON 或旧审查结果代替。";
}

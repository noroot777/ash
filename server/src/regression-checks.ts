import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { monitors, tasks } from "./db/schema.js";
import { RUNS_DIR } from "./paths.js";
import { userShellLaunch } from "./platform.js";
import { taskWorkspace } from "./task-workspace.js";
import { replaceEvidenceFile } from "./review-evidence.js";
import { regressionSnapshot, type RegressionSnapshot } from "./regression-snapshot.js";

export type RegressionRecord = {
  monitorId: string; taskId: string; role: string; command: string; cwd: string; logPath: string;
  before: RegressionSnapshot | null; after: RegressionSnapshot | null;
  exitCode: number | null; startedAt: string | null; endedAt: string | null;
};

export function prepareRegressionCommand(taskId: string, monitorId: string, command: string, cwd: string): string {
  const directory = join(RUNS_DIR, taskId, "regression");
  mkdirSync(directory, { recursive: true });
  const recordPath = join(directory, `${monitorId}.json`);
  const record: RegressionRecord = {
    taskId, monitorId, role: "executor", command, cwd, logPath: join(directory, `${monitorId}.log`),
    before: null, after: null, exitCode: null, startedAt: null, endedAt: null,
  };
  writeFileSync(recordPath, JSON.stringify(record));
  const inputPath = join(directory, `${monitorId}.input.json`);
  writeFileSync(inputPath, JSON.stringify({ recordPath, launch: userShellLaunch(command) }));
  const built = fileURLToPath(new URL("./regression-worker.js", import.meta.url));
  const worker = existsSync(built) ? built : fileURLToPath(new URL("./regression-worker.ts", import.meta.url));
  const loader = existsSync(built) ? [] : ["--import", createRequire(import.meta.url).resolve("tsx/esm")];
  const script = `const result=require('node:child_process').spawnSync(${JSON.stringify(process.execPath)},` +
    `${JSON.stringify([...loader, worker, inputPath])},{stdio:'inherit'});process.exit(result.status??1)`;
  const encoded = Buffer.from(script).toString("base64");
  return `node -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}

export async function regressionEvidenceReference(
  task: typeof tasks.$inferSelect, repoPath: string, evidenceDir: string, acceptedMerge = false,
): Promise<string> {
  if (acceptedMerge) return "合并结果审查不得复用任务分支的回归结果，必须检查当前合并快照。";
  const directory = join(RUNS_DIR, task.id, "regression");
  const files = existsSync(directory) ? readdirSync(directory).filter((name) => /^[\w-]+\.json$/.test(name)) : [];
  const workspace = files.length ? await taskWorkspace(task, repoPath).catch(() => null) : null;
  const snapshot = workspace ? regressionSnapshot(workspace.path) : null;
  const rows = await db.select().from(monitors).where(eq(monitors.taskId, task.id));
  const facts = new Map(rows.map((row) => [row.id, row]));
  const records: Array<RegressionRecord & { reusable: boolean; reason: string }> = [];
  for (const file of files) {
    try {
      const record = JSON.parse(readFileSync(join(directory, file), "utf8")) as RegressionRecord;
      const fact = facts.get(record.monitorId);
      if (record.role !== "executor" || record.taskId !== task.id || fact?.sourceRole !== "single" || fact.sourceReviewRun) continue;
      const completed = fact.status === "exited" && record.endedAt && record.exitCode !== null && fact.exitCode === record.exitCode;
      const sameTree = !!snapshot && record.before?.tree === snapshot.tree && record.after?.tree === snapshot.tree;
      const location = workspace ? relative(resolve(workspace.path), resolve(record.cwd)) : "..";
      const sameWorkspace = !!workspace && location !== ".." && !location.startsWith(`..${sep}`) && !isAbsolute(location);
      const logged = record.logPath === join(directory, `${record.monitorId}.log`) && existsSync(record.logPath);
      const reusable = !!completed && sameTree && sameWorkspace && logged;
      records.push({ ...record, reusable,
        reason: !completed ? "未正常完成" : !sameTree ? "代码树已变或无法核实" : !sameWorkspace ? "工作目录不同" : !logged ? "日志缺失" : "执行者实跑，测试前后与当前代码树一致" });
    } catch { continue; }
  }
  records.sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""));
  const latest = records.filter((record, index) => !records.slice(0, index).some((previous) => previous.command === record.command && previous.cwd === record.cwd));
  const path = join(evidenceDir, "regression-evidence.json");
  await replaceEvidenceFile(path, JSON.stringify({ taskId: task.id, snapshot, records: latest }, null, 2));
  return `执行者回归证据清单：${path}。后端已按执行者身份、真实退出码、日志、测试前后与当前代码树判定 reusable；` +
    "只复用 reusable=true 的条目，按清单里的 logPath 读取完整输出；清单为空或条目标为失效时按缺口补跑，不能用对话自述或旧审查结果代替。";
}

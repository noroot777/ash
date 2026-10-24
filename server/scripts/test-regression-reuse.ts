import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  db, inTurnCaller, makeTask, monitors, projects, root, runs, schema, startMonitor,
  tasks, teardown, until,
} from "./monitors-fixture.js";

const { prepareRegressionCommand, regressionEvidenceReference } = await import("../src/regression-checks.js");
const { regressionSnapshot } = await import("../src/regression-snapshot.js");
const { freeReviewPrompt, freeReviewResumeMessage } = await import("../src/free-review-prompts.js");
const { verifyProtocolFor, verifyReminderFor, reviewReminderFor } = await import("../src/review-prompts.js");
const { freeReviewReminder } = await import("../src/free-workflow.js");
const { SWEEP_RULES } = await import("../src/review-sweep.js");
const { EXECUTOR_REGRESSION_RECORDING, REVIEW_VALIDATION_REQUIREMENT } = await import("@ash/shared/free-workflow");
const { ACCEPTANCE_REMINDER } = await import("../src/run-prompts.js");
const { MONITOR_DEFAULT_TIMEOUT_MS, MONITOR_MAX_TIMEOUT_MS } = await import("@ash/shared/monitor");
const { previewShell } = await import("../src/preview-shell.js");
const { userShellLaunch } = await import("../src/platform.js");

try {
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Regression Test");
  git("config", "user.email", "regression@example.test");
  writeFileSync(join(repo, "code.txt"), "base\n");
  git("add", ".");
  git("commit", "-m", "base");
  const taskId = await makeTask();
  await db.update(tasks).set({ useWorktree: false, workflowMode: "free" }).where(eq(tasks.id, taskId));
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
  await db.update(projects).set({ repoPath: repo }).where(eq(projects.id, task.projectId));
  assert.equal(runs.claimTurn(taskId, "single"), true);
  const caller = await inTurnCaller(taskId);
  const evidenceDir = join(root, "runs", taskId, "review", "round-1");
  mkdirSync(evidenceDir, { recursive: true });
  const manifest = () => JSON.parse(readFileSync(join(evidenceDir, "regression-evidence.json"), "utf8")) as {
    records: Array<{ reusable: boolean; passed: boolean | null; command: string; exitCode: number; logPath: string; reason: string; latest: boolean }>;
  };
  const command = `node -e "console.log('OUTPUT'.repeat(30000));process.exit(Number(process.env.ASH_TEST_REGRESSION_FAIL||0))"`;
  const runTest = async (originalCommand = command) => {
    const result = await startMonitor({ taskId, command: originalCommand, cwd: repo, regression: true, caller, timeoutMs: 30_000 });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) throw new Error(result.error);
    assert.equal(result.monitor.timeoutMs, 30_000, "显式回归时限优先于新缺省值");
    await until("回归命令真实退出并完成记录", async () =>
      (await db.select().from(monitors).where(eq(monitors.id, result.monitor.id)))[0]?.status === "exited");
    return result.monitor.id;
  };

  const first = await runTest();
  await regressionEvidenceReference(task, repo, evidenceDir);
  assert.equal(manifest().records[0]?.reusable, false, "相同 Git 树不能证明输入不可变，必须拒绝自动复用");
  assert.match(manifest().records[0]!.reason, /输入闭包未核实/);
  assert.equal(manifest().records[0]?.exitCode, 0);
  assert.equal(manifest().records[0]?.passed, true);
  assert.match(manifest().records[0]!.reason, /通过.*exitCode=0/);
  assert.equal(readFileSync(manifest().records[0]!.logPath, "utf8").length, 180001, "完整输出不经过对话裁剪");
  assert.equal(git("diff", "--cached"), "", "拍代码树不能污染真实 index");
  const firstRecord = (await db.select().from(schema.regressionChecks).where(eq(schema.regressionChecks.monitorId, first)))[0]!;
  writeFileSync(join(root, "runs", taskId, "regression", `${first}.json`), JSON.stringify({
    ...firstRecord, command: "npm run imaginary-full-suite", before: { tree: "forged" }, after: { tree: "forged" }, exitCode: 0,
  }));
  await regressionEvidenceReference(task, repo, evidenceDir);
  assert.equal(manifest().records[0]?.command, command, "伪造 JSON 不能覆盖数据库里的原始命令和代码树");
  assert.equal(manifest().records[0]?.reusable, false);
  const originalLog = readFileSync(firstRecord.logPath);
  writeFileSync(firstRecord.logPath, "ALL TESTS PASSED (forged)\n");
  await regressionEvidenceReference(task, repo, evidenceDir);
  assert.equal(manifest().records[0]?.reusable, false, "改写输出会与数据库日志摘要不符");
  writeFileSync(firstRecord.logPath, originalLog);
  const beforeCommit = regressionSnapshot(repo)!;
  git("commit", "--allow-empty", "-m", "same tree");
  const afterCommit = regressionSnapshot(repo)!;
  assert.notEqual(beforeCommit.commit, afterCommit.commit);
  assert.equal(beforeCommit.tree, afterCommit.tree);
  await regressionEvidenceReference(task, repo, evidenceDir);
  assert.equal(manifest().records[0]?.reusable, false, "只提交而未改代码树也不能补足输入证明");

  writeFileSync(join(repo, "code.txt"), "changed without commit\n");
  await regressionEvidenceReference(task, repo, evidenceDir);
  assert.equal(manifest().records[0]?.reusable, false, "同一 HEAD 下未提交的改动也会使旧结果失效");
  writeFileSync(join(repo, "code.txt"), "base\n");
  writeFileSync(join(repo, "new.txt"), "untracked\n");
  await regressionEvidenceReference(task, repo, evidenceDir);
  assert.equal(manifest().records[0]?.reusable, false, "未跟踪文件也纳入代码树");
  rmSync(join(repo, "new.txt"));

  await db.update(monitors).set({ sourceRole: "reviewer" }).where(eq(monitors.id, first));
  await regressionEvidenceReference(task, repo, evidenceDir);
  assert.equal(manifest().records.length, 0, "审查者结果不能冒充执行者结果");
  await db.update(monitors).set({ sourceRole: "single", sourceReviewRun: "old-review" }).where(eq(monitors.id, first));
  await regressionEvidenceReference(task, repo, evidenceDir);
  assert.equal(manifest().records.length, 0, "带旁路代次的记录也不能冒充执行者结果");
  await db.update(monitors).set({ sourceReviewRun: null }).where(eq(monitors.id, first));
  process.env.ASH_TEST_REGRESSION_FAIL = "1";
  await runTest();
  delete process.env.ASH_TEST_REGRESSION_FAIL;
  await regressionEvidenceReference(task, repo, evidenceDir);
  assert.equal(manifest().records.length, 2, "同一命令保留全部历史，不能吞掉失败");
  assert.equal(manifest().records[0]?.latest, true);
  assert.equal(manifest().records[1]?.latest, false);
  assert.equal(manifest().records[0]?.exitCode, 1, "后来的失败不能被旧绿结果盖掉");
  assert.equal(manifest().records[0]?.reusable, false, "失败如实展示，但缺少输入证明同样禁止自动复用");
  assert.equal(manifest().records[0]?.passed, false);
  assert.match(manifest().records[0]!.reason, /失败.*exitCode=1/);
  assert.match(await regressionEvidenceReference(task, repo, evidenceDir), /reusable=true 只表示证据可引用.*passed=true 且 exitCode=0/);
  rmSync(manifest().records[0]!.logPath);
  await regressionEvidenceReference(task, repo, evidenceDir);
  assert.equal(manifest().records[0]?.reusable, false, "缺少完整日志时不能复用");

  const mutatingCommand = `node -e "require('fs').writeFileSync('code.txt','during test')"`;
  await runTest(mutatingCommand);
  writeFileSync(join(repo, "code.txt"), "base\n");
  await regressionEvidenceReference(task, repo, evidenceDir);
  assert.equal(manifest().records.find((record) => record.command === mutatingCommand)?.reusable, false,
    "测试期间改动代码，即使之后恢复当前代码，也不能复用");

  const timed = await startMonitor({ taskId, command: "node -e \"console.log('default timeout')\"", cwd: repo, regression: true, caller });
  assert.equal(timed.ok, true);
  if (!timed.ok) throw new Error(timed.error);
  assert.equal(timed.monitor.timeoutMs, MONITOR_MAX_TIMEOUT_MS, "记录回归缺省给足上限，不再五分钟截断");
  await until("默认时限回归退出", async () => (await db.select().from(monitors).where(eq(monitors.id, timed.monitor.id)))[0]?.status === "exited");
  const ordinary = await startMonitor({ taskId, command: "node -e \"console.log('ordinary timeout')\"", cwd: repo, caller });
  assert.equal(ordinary.ok, true);
  if (!ordinary.ok) throw new Error(ordinary.error);
  assert.equal(ordinary.monitor.timeoutMs, MONITOR_DEFAULT_TIMEOUT_MS, "普通哨兵缺省时限不变");
  await until("普通哨兵退出", async () => (await db.select().from(monitors).where(eq(monitors.id, ordinary.monitor.id)))[0]?.status === "exited");
  const expired = await startMonitor({ taskId, command: "node -e \"setTimeout(()=>{},20000)\"", cwd: repo, regression: true, caller, timeoutMs: 1_000 });
  assert.equal(expired.ok, true);
  if (!expired.ok) throw new Error(expired.error);
  await until("显式短时限会终止回归", async () => (await db.select().from(monitors).where(eq(monitors.id, expired.monitor.id)))[0]?.status === "expired");
  await regressionEvidenceReference(task, repo, evidenceDir);
  const expiredRecord = manifest().records.find((record) => record.command.includes("setTimeout"))!;
  assert.equal(expiredRecord.reusable, false);
  assert.equal(expiredRecord.passed, null, "超时不能伪装成完整通过");

  const outside = join(root, "outside");
  mkdirSync(outside);
  const linkedTask = await makeTask();
  mkdirSync(join(root, "runs", linkedTask), { recursive: true });
  symlinkSync(outside, join(root, "runs", linkedTask, "regression"), "junction");
  await assert.rejects(prepareRegressionCommand(linkedTask, "unsafe-directory", command, repo, "single"), /安全检查/);
  assert.equal(runs.claimTurn(linkedTask, "single"), true);
  const unsafe = await startMonitor({ taskId: linkedTask, command, cwd: repo, regression: true, caller: await inTurnCaller(linkedTask) });
  assert.equal(unsafe.ok, false);
  if (!unsafe.ok) assert.match(unsafe.error, /安全检查/);
  runs.releaseTurn(linkedTask);
  const unsafeEvidence = join(root, "runs", taskId, "unsafe-evidence");
  symlinkSync(outside, unsafeEvidence, "junction");
  assert.match(await regressionEvidenceReference(task, repo, unsafeEvidence), /目录安全检查不通过/);
  assert.deepEqual(readdirSync(outside), [], "登记和证据清单都不能穿过祖先链接写到外面");
  const target = join(outside, "protected.log");
  writeFileSync(target, "untouched");
  const unsafeLogCommand = await prepareRegressionCommand(taskId, "unsafe-log", command, repo, "single");
  symlinkSync(target, join(root, "runs", taskId, "regression", "unsafe-log.log"));
  const unsafeLaunch = userShellLaunch(unsafeLogCommand);
  assert.throws(() => execFileSync(unsafeLaunch.file, unsafeLaunch.args, { cwd: repo, windowsVerbatimArguments: unsafeLaunch.windowsVerbatimArguments, timeout: 30_000 }));
  assert.equal(readFileSync(target, "utf8"), "untouched", "日志最终文件也不能跟随软链写出边界");
  const refusedLog = (await db.select().from(schema.regressionChecks).where(eq(schema.regressionChecks.monitorId, "unsafe-log")))[0]!;
  assert.equal(refusedLog.exitCode, null);
  assert.ok(refusedLog.error);

  const originalNode = process.execPath;
  const runtimeDirectory = join(root, "runtime with spaces");
  mkdirSync(runtimeDirectory);
  const runtime = join(runtimeDirectory, process.platform === "win32" ? "node.exe" : "node");
  symlinkSync(originalNode, runtime);
  Object.defineProperty(process, "execPath", { value: runtime, configurable: true });
  let prepared: string;
  try {
    prepared = await prepareRegressionCommand(taskId, "absolute-runtime", `${previewShell().quote(originalNode)} -e "console.log('ABSOLUTE_NODE_OK')"`, repo, "single");
  } finally {
    Object.defineProperty(process, "execPath", { value: originalNode, configurable: true });
  }
  assert.ok(prepared.startsWith(previewShell().quote(runtime)), "外层也引用 Node 绝对路径");
  const launch = userShellLaunch(prepared);
  execFileSync(launch.file, launch.args, { cwd: repo, windowsVerbatimArguments: launch.windowsVerbatimArguments, timeout: 30_000 });
  const absolute = (await db.select().from(schema.regressionChecks).where(eq(schema.regressionChecks.monitorId, "absolute-runtime")))[0]!;
  assert.equal(absolute.exitCode, 0);
  assert.match(readFileSync(absolute.logPath, "utf8"), /ABSOLUTE_NODE_OK/);

  const rejected = await startMonitor({ taskId, command, cwd: repo, regression: true, caller: { kind: "external" } });
  assert.equal(rejected.ok, false, "外部调用不能登记执行者回归");
  assert.equal((await startMonitor({ taskId, command, cwd: repo, regression: true, stopWhen: "DONE", caller })).ok, false);
  runs.releaseTurn(taskId);
  assert.equal(runs.claimTurn(taskId, "side"), true);
  const sideCaller = await inTurnCaller(taskId, "side-token");
  const side = await startMonitor({ taskId, command, cwd: repo, regression: true, caller: sideCaller });
  assert.equal(side.ok, false, "验证旁路不能登记执行者回归");
  runs.releaseTurn(taskId);

  await db.insert(schema.freeReviewRuns).values({
    id: "merge-review", taskId, reviewerName: "reviewer", agentType: "codex", checkMode: "logic",
    status: "reviewing", currentRound: 1, targetKind: "accepted_merge", targetBranch: "main",
    targetBaseCommit: beforeCommit.commit, targetCommit: afterCommit.commit,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const run = (await db.select().from(schema.freeReviewRuns).where(eq(schema.freeReviewRuns.id, "merge-review")))[0]!;
  const rule = SWEEP_RULES.find((entry) => entry.id === "执行者回归结果复用")!;
  for (const text of [await freeReviewPrompt(task, run, 1, repo), freeReviewResumeMessage(task, run, 1), await freeReviewReminder(taskId)]) {
    assert.equal(text.includes(rule.full), false, "合并后审查不携带任务分支复用协议");
    assert.equal(text.includes(rule.short!), false, "合并后审查续跑也不携带复用协议");
    assert.match(text, /合并结果审查.*不得复用|合并结果审查不得复用/);
  }

  const verification = await verifyProtocolFor({ ...task, workflowAt: "verify", workflow: JSON.stringify({
    workspace: "shared", steps: [{ id: "run", kind: "run", p: {}, fail: null }, { id: "verify", kind: "verify", fail: null,
      p: { executorId: null, model: null, reasoningEffort: null, checks: ["build", "tests", "browser"] } }],
  }) }, 1, repo);
  assert.match(verification, /仅「回归测试」可引用.*浏览器真实点检和其它勾选项必须实际执行/);
  assert.ok(verification.includes(REVIEW_VALIDATION_REQUIREMENT));
  for (const text of [await verifyReminderFor(taskId, 1), await reviewReminderFor({ id: "legacy", reviewOf: taskId, reviewRound: 1 })]) {
    assert.match(text, /不免除独立代码审查与必要的行为验证/);
  }
  const registered = new Map<string, { description?: string; inputSchema?: Record<string, unknown> }>();
  const server = { registerTool(name: string, configuration: never) { registered.set(name, configuration); } };
  const { registerTaskTurnTools } = await import("../../mcp/src/tools/task-turn.js");
  const { registerMonitorTools } = await import("../../mcp/src/tools/monitor.js");
  registerTaskTurnTools(server as never);
  registerMonitorTools(server as never);
  assert.ok(registered.get("report_stage")?.description?.includes(REVIEW_VALIDATION_REQUIREMENT), "MCP 与审查 prompt 共用验证口径");
  assert.ok(registered.get("start_monitor")?.inputSchema?.regression, "MCP 注册了实际可用的回归记录入口");
  assert.match((registered.get("start_monitor")!.inputSchema!.timeoutMs as { description: string }).description, /regression=true.*上限 60 分钟/);
  assert.match(EXECUTOR_REGRESSION_RECORDING, /未指定 timeoutMs.*60 分钟/);
  for (const [shared, free] of [[false, true], [false, false], [true, false]]) {
    assert.ok(ACCEPTANCE_REMINDER(taskId, shared!, false, free!).includes(EXECUTOR_REGRESSION_RECORDING));
  }
  assert.equal(existsSync(join(root, "runs", taskId, "regression", `${first}.input.json`)), false, "worker 不再信任可改写的输入 JSON");
  assert.equal((await db.select().from(schema.regressionChecks).where(eq(schema.regressionChecks.monitorId, first))).length, 1);
  console.log("✓ regression evidence: real command/output/exit, tree identity, provenance, failure, post-merge, prompts and MCP");
} finally {
  delete process.env.ASH_TEST_REGRESSION_FAIL;
  await teardown();
}

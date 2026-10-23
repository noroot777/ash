import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import {
  db, inTurnCaller, makeTask, monitors, projects, root, runs, schema, startMonitor,
  tasks, teardown, until,
} from "./monitors-fixture.js";

const { regressionLogDigest } = await import("../src/regression-files.js");
const { prepareRegressionCommand, regressionEvidenceReference } = await import("../src/regression-checks.js");

async function withoutPipeWait<Result>(path: string, pending: Promise<Result>): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("日志读取仍在等待 FIFO 写端")), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    const descriptor = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
    try {
      await pending;
    } finally {
      closeSync(descriptor);
    }
  }
}

try {
  const directory = join(root, "runs", "file-types");
  mkdirSync(directory, { recursive: true });
  const regular = join(directory, "regular.log");
  writeFileSync(regular, "real output\n");
  assert.equal(await regressionLogDigest(regular), createHash("sha256").update("real output\n").digest("hex"));
  assert.equal(await regressionLogDigest(join(directory, "missing.log")), null);
  const subdirectory = join(directory, "directory.log");
  mkdirSync(subdirectory);
  assert.equal(await regressionLogDigest(subdirectory), null);
  const linked = join(directory, "linked.log");
  symlinkSync(regular, linked);
  assert.equal(await regressionLogDigest(linked), null);

  if (process.platform !== "win32") {
    const fifo = join(directory, "pipe.log");
    execFileSync("mkfifo", [fifo]);
    assert.equal(await withoutPipeWait(fifo, regressionLogDigest(fifo)), null, "无写端的 FIFO 立即拒绝");

    const racing = join(directory, "racing.log");
    writeFileSync(racing, "regular before open\n");
    const originalOpen = fsPromises.open;
    let swapped = false;
    fsPromises.open = async (path, flags, mode) => {
      if (path === racing) {
        swapped = true;
        rmSync(racing);
        execFileSync("mkfifo", [racing]);
      }
      return originalOpen(path, flags, mode);
    };
    syncBuiltinESMExports();
    try {
      assert.equal(await withoutPipeWait(racing, regressionLogDigest(racing)), null,
        "路径预检之后被换成 FIFO，也不能挂住或把特殊文件当作日志");
      assert.equal(swapped, true);
    } finally {
      fsPromises.open = originalOpen;
      syncBuiltinESMExports();
    }

    const repo = join(root, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "-b", "main");
    git("config", "user.name", "Regression File Types");
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
    const result = await startMonitor({
      taskId, command: "node -e \"console.log('actual regression output')\"", cwd: repo,
      regression: true, caller, timeoutMs: 30_000,
    });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error(result.error);
    await until("回归真实退出", async () =>
      (await db.select().from(monitors).where(eq(monitors.id, result.monitor.id)))[0]?.status === "exited");
    const evidenceDir = join(root, "runs", taskId, "review", "round-1");
    const manifest = () => JSON.parse(readFileSync(join(evidenceDir, "regression-evidence.json"), "utf8")) as {
      records: Array<{ monitorId: string; logPath: string; reusable: boolean }>;
    };
    await regressionEvidenceReference(task, repo, evidenceDir);
    const record = manifest().records.find((item) => item.monitorId === result.monitor.id)!;
    assert.equal(record.reusable, true);
    rmSync(record.logPath);
    execFileSync("mkfifo", [record.logPath]);
    await withoutPipeWait(record.logPath, regressionEvidenceReference(task, repo, evidenceDir));
    assert.equal(manifest().records.find((item) => item.monitorId === result.monitor.id)?.reusable, false,
      "公共派审清单遇到 FIFO 能完成生成并拒绝复用");

    const monitorId = "preexisting-fifo";
    await prepareRegressionCommand(taskId, monitorId, "node -e \"console.log('must not run')\"", repo, "single");
    const workerLog = join(root, "runs", taskId, "regression", `${monitorId}.log`);
    execFileSync("mkfifo", [workerLog]);
    const worker = spawnSync(process.execPath, [
      "--import", createRequire(import.meta.url).resolve("tsx/esm"),
      fileURLToPath(new URL("../src/regression-worker.ts", import.meta.url)), monitorId,
    ], { cwd: repo, encoding: "utf8", timeout: 10_000 });
    assert.ifError(worker.error);
    assert.equal(worker.signal, null);
    assert.equal(worker.status, 1, worker.stdout + worker.stderr);
    const failed = (await db.select().from(schema.regressionChecks).where(eq(schema.regressionChecks.monitorId, monitorId)))[0]!;
    assert.ok(failed.startedAt);
    assert.ok(failed.endedAt, "日志创建失败也必须完成收尾落库");
    assert.match(failed.error!, /EEXIST/);
    assert.equal(failed.exitCode, null);
    assert.equal(failed.logDigest, null);
    assert.match(worker.stdout, /REGRESSION_FINISHED/);
    runs.releaseTurn(taskId);
    console.log("✓ regression FIFO: no writer, replacement race, manifest generation and worker failure cleanup");
  }
  console.log("✓ regression log file types: ordinary, missing, directory and symlink");
} finally {
  await teardown();
}

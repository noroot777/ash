// macOS 兼容监督下的**跨重启接管**（生产实现，不加载编排夹具）。
//
// 钉的是 GateConfinement.resume：兼容监督靠 250ms 一次的轮询，顺着 ppid 记下清掉了继承标记
// 的后代。起跑时那份轮询随旧 ash 一起没了 —— 新实例接管后不把它接回来，接管**之后**才冒出来
// 的这类后代就没人记，收尾时认不出它，测试转绿、它却还活着。这里专门造一个：接管之后才起、
// env 清空（没有标记）、自成一个进程组，只靠父进程还活着那会儿被观察到。
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate: () => boolean | Promise<boolean>, what: string, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error(`macOS takeover: ${what} timed out`);
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export async function testMacGateTakeover(directory: string): Promise<object> {
  assert.equal(process.platform, "darwin");
  assert.notEqual(process.env.ASH_ALLOW_REAL_AGENT, "1");
  mkdirSync(directory, { recursive: true });
  const repo = join(directory, "repo");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-b", "main", repo]);
  git("config", "user.name", "Mac Gate Test");
  git("config", "user.email", "gate@example.test");
  writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
  writeFileSync(join(repo, "seed.txt"), "seed");
  git("add", "-A");
  git("commit", "-m", "seed");
  const script = join(directory, "command.cjs");
  writeFileSync(script, `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const dir = ${JSON.stringify(directory)};
if (process.argv[2] === "child") {
  fs.writeFileSync(dir + "/escaped.pid", String(process.pid));
  setInterval(() => {}, 1000);
} else {
  const wait = (file, then) => { const t = setInterval(() => { if (fs.existsSync(file)) { clearInterval(t); then(); } }, 20); };
  wait(dir + "/spawn", () => {
    spawn(process.execPath, [__filename, "child"], { detached: true, stdio: "ignore", env: {} }).unref();
    wait(dir + "/release", () => process.exit(0));
  });
}
`);
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks, acceptGateRuns } = await import("../src/db/schema.js");
  const { prepareWorktree } = await import("../src/git.js");
  const { recoverAcceptGates, whenAcceptGateSettled, hasLiveAcceptGate } = await import("../src/accept-gate.js");
  const { readGateLaunch } = await import("../src/accept-gate-launch.js");
  let escaped = 0;
  try {
    await ensureSchema();
    const projectId = "gate-macos-takeover-project";
    const taskId = "gate-macos-takeover-task";
    const stamp = new Date().toISOString();
    const workspace = (await prepareWorktree(repo, taskId, "main")).path;
    writeFileSync(join(workspace, "task.txt"), "task");
    execFileSync("git", ["-C", workspace, "add", "-A"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "task"]);
    await db.insert(projects).values({ id: projectId, name: "macos-takeover", repoPath: repo,
      acceptGateCommand: `"${process.execPath}" "${script}"`, createdAt: stamp });
    await db.insert(tasks).values({ id: taskId, projectId, title: "macos-takeover", mode: "single", status: "done",
      stage: "verified", workflowMode: "free", useWorktree: true, worktreeBase: "main", mergeTargetBranch: "main",
      createdAt: stamp, updatedAt: stamp });
    // 旧 ash：另一个进程发起验收，命令放行后 SIGKILL 自己。
    const worker = spawn(process.execPath, ["--import", "tsx",
      fileURLToPath(new URL("./accept-gate-crash-worker.ts", import.meta.url)), taskId, "armed"],
    { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let diagnostic = "";
    worker.stderr?.on("data", chunk => { diagnostic += String(chunk); });
    const signal = await new Promise<string | null>(resolve => worker.once("exit", (_code, exitSignal) => resolve(exitSignal)));
    assert.equal(signal, "SIGKILL", diagnostic);
    const row = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId)))[0]!;
    assert.equal(row.status, "running");
    assert.equal(row.executionMode, "macos-observed");

    assert.equal((await recoverAcceptGates()).resumed, 1, "命令还在跑：接管");
    writeFileSync(join(directory, "spawn"), "spawn");
    await until(() => existsSync(join(directory, "escaped.pid")), "接管后起后代");
    escaped = Number(readFileSync(join(directory, "escaped.pid"), "utf8"));
    await sleep(1_000); // 父进程还活着的这段里，接回来的轮询要来得及记下它
    writeFileSync(join(directory, "release"), "release");
    let run = row;
    await until(async () => {
      run = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, row.id)))[0]!;
      return run.status !== "running";
    }, "按真实退出结算");
    await whenAcceptGateSettled(run.id);
    run = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, row.id)))[0]!;
    assert.equal(run.status, "passed", readFileSync(run.logPath, "utf8"));
    assert.equal(run.processPending, false);
    assert.equal(readGateLaunch(run.logPath)?.stoppedEvidence, "observed-empty");
    await until(() => !alive(escaped), "接管后观察到的无标记后代被收掉", 10_000);
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.stage, "accepted");
    assert.equal(hasLiveAcceptGate(taskId), false);
    return { mode: "macos-takeover", resumed: true, settledPassed: true, unmarkedDescendantAfterTakeoverStopped: true };
  } finally {
    if (escaped && alive(escaped)) process.kill(escaped, "SIGKILL");
    await releaseTmpDb();
  }
}

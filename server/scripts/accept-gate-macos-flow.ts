import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

export async function testMacGateFlow(directory: string): Promise<object> {
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
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks, acceptGateRuns } = await import("../src/db/schema.js");
  const { prepareWorktree } = await import("../src/git.js");
  const { acceptTask } = await import("../src/task-accept.js");
  const { hasLiveAcceptGate, acceptGateWouldRun, whenAcceptGateSettled } = await import("../src/accept-gate.js");
  const { acceptGateState } = await import("../src/accept-gate-state.js");
  const { readGateLaunch } = await import("../src/accept-gate-launch.js");
  try {
    await ensureSchema();
    const projectId = "gate-macos-project";
    const taskId = "gate-macos-task";
    const stamp = new Date().toISOString();
    const workspace = (await prepareWorktree(repo, taskId, "main")).path;
    writeFileSync(join(workspace, "task.txt"), "task");
    execFileSync("git", ["-C", workspace, "add", "-A"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "task"]);
    await db.insert(projects).values({ id: projectId, name: "macos", repoPath: repo,
      acceptGateCommand: "test -f task.txt && printf 'actually tested\\n' > tested.txt", createdAt: stamp });
    await db.insert(tasks).values({ id: taskId, projectId, title: "macos", mode: "single", status: "done",
      stage: "verified", workflowMode: "free", useWorktree: true, worktreeBase: "main", mergeTargetBranch: "main",
      createdAt: stamp, updatedAt: stamp });
    const current = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
    const project = (await db.select().from(projects).where(eq(projects.id, projectId)))[0]!;
    assert.equal(await acceptGateWouldRun(current, project), true);
    const before = await acceptGateState(taskId);
    assert.equal(before.unavailable, null);
    assert.match(before.executionNotice!, /macOS 兼容监督/);
    const started = await acceptTask(taskId);
    assert.equal(started.accepted, false);
    if (started.accepted || started.reason !== "accept_gate_running") throw new Error(JSON.stringify(started));
    const deadline = Date.now() + 30_000;
    let run = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId)))[0]!;
    while (run.status === "running") {
      if (Date.now() > deadline) throw new Error(readFileSync(run.logPath, "utf8"));
      await new Promise(resolve => setTimeout(resolve, 50));
      run = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId)))[0]!;
    }
    await whenAcceptGateSettled(run.id);
    assert.equal(run.status, "passed", readFileSync(run.logPath, "utf8"));
    assert.equal(run.processPending, false);
    assert.equal(run.executionMode, "macos-observed");
    assert.equal(readGateLaunch(run.logPath)?.stoppedEvidence, "observed-empty");
    assert.equal(readFileSync(join(run.cwd, "tested.txt"), "utf8"), "actually tested\n");
    assert.equal(existsSync(join(repo, "tested.txt")), false);
    const accepted = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
    assert.equal(accepted.stage, "accepted");
    assert.equal(accepted.acceptedGateMode, "passed");
    assert.equal(accepted.acceptedGateRunId, run.id);
    assert.equal(existsSync(workspace), false);
    assert.equal(git("show", "main:task.txt"), "task");
    assert.equal(hasLiveAcceptGate(taskId), false);
    const state = await acceptGateState(taskId);
    assert.match(state.basis?.run?.executionNotice!, /不具备 cgroup\/Job/);
    return { mode: "macos-production-flow", commandActuallyExecuted: true, autoAccepted: true,
      acceptedGateMode: accepted.acceptedGateMode, snapshotRetained: existsSync(run.cwd), processPending: false };
  } finally { await releaseTmpDb(); }
}

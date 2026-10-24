import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

export async function testGateRefusal(directory: string): Promise<object> {
  assert.equal(process.platform, "darwin");
  assert.notEqual(process.env.ASH_ALLOW_REAL_AGENT, "1");
  mkdirSync(directory, { recursive: true });
  const repo = join(directory, "repo");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-b", "main", repo]);
  git("config", "user.name", "Gate Refusal Test");
  git("config", "user.email", "gate@example.test");
  writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
  writeFileSync(join(repo, "seed.txt"), "seed");
  git("add", "-A");
  git("commit", "-m", "seed");
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks, acceptGateRuns } = await import("../src/db/schema.js");
  const { prepareWorktree } = await import("../src/git.js");
  const { acceptTask } = await import("../src/task-accept.js");
  const { hasLiveAcceptGate, whenAcceptGateSettled } = await import("../src/accept-gate.js");
  const { acceptGateState } = await import("../src/accept-gate-state.js");
  const { releaseTurn } = await import("../src/turn-lock.js");
  try {
    await ensureSchema();
    const projectId = "gate-refusal-project";
    const taskId = "gate-refusal-task";
    const marker = join(directory, "must-not-execute");
    const stamp = new Date().toISOString();
    const workspace = (await prepareWorktree(repo, taskId, "main")).path;
    writeFileSync(join(workspace, "task.txt"), "task");
    execFileSync("git", ["-C", workspace, "add", "-A"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "task"]);
    await db.insert(projects).values({ id: projectId, name: "refusal", repoPath: repo,
      acceptGateCommand: `touch "${marker}"`, createdAt: stamp });
    await db.insert(tasks).values({ id: taskId, projectId, title: "refusal", mode: "single", status: "done",
      stage: "verified", workflowMode: "free", useWorktree: true, worktreeBase: "main", mergeTargetBranch: "main",
      createdAt: stamp, updatedAt: stamp });
    assert.equal((await acceptTask(taskId)).accepted, false);
    const row = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId)))[0]!;
    await whenAcceptGateSettled(row.id);
    const fresh = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, row.id)))[0]!;
    assert.equal(fresh.status, "failed");
    assert.equal(fresh.failure, "spawn_failed");
    assert.equal(fresh.pid, null);
    assert.equal(fresh.processPending, false);
    assert.equal(hasLiveAcceptGate(taskId), false);
    assert.equal(existsSync(marker), false);
    assert.match(readFileSync(fresh.logPath, "utf8"), /macOS.*内核围栏/);
    assert.equal((await acceptGateState(taskId)).latest?.status, "failed");
    for (let attempt = 0; attempt < 200; attempt++) {
      const current = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
      if (current.status === "running") break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, taskId));
    releaseTurn(taskId);
    const skipped = await acceptTask(taskId, "human", { acceptGate: "skip" });
    assert.equal(skipped.accepted, true, JSON.stringify(skipped));
    const accepted = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
    assert.equal(accepted.acceptedGateMode, "skipped");
    assert.equal(existsSync(workspace), false);
    assert.equal(existsSync(marker), false);
    return { mode: "macos-production-refusal", statusPersisted: fresh.status, failure: fresh.failure,
      processPending: fresh.processPending, userCommandExecuted: false, hintPersisted: true,
      explicitSkipAccepted: skipped.accepted, acceptedGateMode: accepted.acceptedGateMode };
  } finally { await releaseTmpDb(); }
}

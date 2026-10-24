import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-gate-readonly-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
assert.notEqual(process.env.ASH_ALLOW_REAL_AGENT, "1");
const git = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { acceptGateRuns, projects, tasks } = await import("../src/db/schema.js");
  const { prepareWorktree, worktreeBranchName } = await import("../src/git.js");
  const { acceptTask } = await import("../src/task-accept.js");
  const { acceptGateWouldRun, whenAcceptGateSettled } = await import("../src/accept-gate.js");
  const { mountAcceptGateRoutes } = await import("../src/accept-gate-routes.js");
  const { existingTaskWorkspacePath } = await import("../src/task-workspace.js");
  await ensureSchema();
  const api = new Hono();
  mountAcceptGateRoutes(api);
  const createdAt = new Date().toISOString();
  const command = `"${process.execPath}" -e "process.exit(0)"`;
  const taskRow = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
  const projectRow = async (projectId: string) => (await db.select().from(projects).where(eq(projects.id, projectId)))[0]!;
  const runRow = async (taskId: string) => (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId)))[0]!;

  async function fixture(name: string) {
    const repo = join(root, name);
    execFileSync("git", ["init", "-b", "main", repo]);
    git(repo, "config", "user.name", "Gate Readonly Test");
    git(repo, "config", "user.email", "readonly@example.test");
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "seed");
    const projectId = `readonly-project-${name}`;
    const taskId = `readonly-task-${name}`;
    await db.insert(projects).values({ id: projectId, name, repoPath: repo, acceptGateCommand: command, createdAt });
    const workspace = (await prepareWorktree(repo, taskId, "main")).path;
    writeFileSync(join(workspace, "task.txt"), "task\n");
    git(workspace, "add", "-A");
    git(workspace, "commit", "-m", "task");
    await db.insert(tasks).values({ id: taskId, projectId, title: name, mode: "single", status: "done", stage: "verified",
      useWorktree: true, worktreeBase: "main", mergeTargetBranch: "main", workflowMode: "free", createdAt, updatedAt: createdAt });
    return { repo, projectId, taskId, workspace };
  }

  async function waitForAcceptance(taskId: string): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt++) {
      const run = await runRow(taskId);
      if (run && run.status !== "running") { await whenAcceptGateSettled(run.id); return; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("gate did not settle");
  }

  async function readWithoutWrites(sample: Awaited<ReturnType<typeof fixture>>, runId: string): Promise<void> {
    const { repo, taskId, workspace } = sample;
    const before = await taskRow(taskId);
    const branches = git(repo, "show-ref", "--heads");
    const worktrees = git(repo, "worktree", "list", "--porcelain");
    for (const suffix of ["", "/log", `/log?run=${runId}`, "", "/log"]) {
      const response = await api.request(`/tasks/${taskId}/accept-gate${suffix}`);
      assert.equal(response.status, 200, await response.text());
      assert.equal(existsSync(workspace), false, `${suffix || "state"} recreated a removed worktree`);
      assert.equal(git(repo, "show-ref", "--heads"), branches);
      assert.equal(git(repo, "worktree", "list", "--porcelain"), worktrees);
      assert.deepEqual(await taskRow(taskId), before);
    }
  }

  {
    const sample = await fixture("accepted");
    await acceptTask(sample.taskId);
    await waitForAcceptance(sample.taskId);
    const accepted = await taskRow(sample.taskId);
    assert.equal(accepted.stage, "accepted");
    assert.equal(existsSync(sample.workspace), false);
    const run = await runRow(sample.taskId);
    writeFileSync(join(sample.repo, "later.txt"), "later\n");
    git(sample.repo, "add", "-A");
    git(sample.repo, "commit", "-m", "later target commit");
    await readWithoutWrites(sample, run.id);
    const state = await (await api.request(`/tasks/${sample.taskId}/accept-gate`)).json();
    assert.equal(state.basis.run.id, run.id);
    assert.equal(state.basis.run.sourceCommit, accepted.acceptedSourceCommit);
    assert.equal(state.latest.stale, false);
    await db.update(tasks).set({ archived: true }).where(eq(tasks.id, sample.taskId));
    await readWithoutWrites(sample, run.id);
  }

  for (const archived of [false, true]) {
    const sample = await fixture(archived ? "archived" : "missing");
    const sourceCommit = git(sample.workspace, "rev-parse", "HEAD");
    const logPath = join(root, `${sample.taskId}.log`);
    writeFileSync(logPath, "historical gate output\n");
    const runId = `${sample.taskId}-run`;
    await db.insert(acceptGateRuns).values({ id: runId, taskId: sample.taskId, projectId: sample.projectId,
      command, cwd: sample.workspace, status: "passed", exitCode: 0, sourceCommit, logPath, startedAt: createdAt, finishedAt: createdAt });
    git(sample.repo, "worktree", "remove", sample.workspace);
    git(sample.repo, "branch", "-D", worktreeBranchName(sample.taskId));
    await db.update(tasks).set({ archived }).where(eq(tasks.id, sample.taskId));
    await readWithoutWrites(sample, runId);
    const beforePrecheck = await taskRow(sample.taskId);
    const branchesBeforePrecheck = git(sample.repo, "show-ref", "--heads");
    assert.equal(await acceptGateWouldRun(await taskRow(sample.taskId), await projectRow(sample.projectId)), true);
    assert.equal(existsSync(sample.workspace), false, "batch precheck recreated a worktree");
    assert.deepEqual(await taskRow(sample.taskId), beforePrecheck);
    assert.equal(git(sample.repo, "show-ref", "--heads"), branchesBeforePrecheck);
    const state = await (await api.request(`/tasks/${sample.taskId}/accept-gate`)).json();
    assert.equal(state.latest.stale, true);
    assert.equal(git(sample.repo, "branch", "--list", worktreeBranchName(sample.taskId)), "");
    assert.equal(readFileSync(logPath, "utf8"), "historical gate output\n");
  }

  {
    const sample = await fixture("ownership");
    await db.update(tasks).set({ mode: "team" }).where(eq(tasks.id, sample.taskId));
    const leader = await taskRow(sample.taskId);
    const sharedId = "readonly-shared-worker";
    await db.insert(tasks).values({ ...leader, id: sharedId, parentId: leader.id, mode: "single", useWorktree: false });
    assert.equal(await existingTaskWorkspacePath(await taskRow(sharedId), sample.repo), sample.workspace);
    const reviewerId = "readonly-reviewer";
    await db.insert(tasks).values({ ...leader, id: reviewerId, mode: "single", useWorktree: false, reviewOf: sharedId });
    assert.equal(await existingTaskWorkspacePath(await taskRow(reviewerId), sample.repo), sample.workspace);
    const isolatedId = "readonly-isolated-worker";
    await db.insert(tasks).values({ ...leader, id: isolatedId, parentId: leader.id, mode: "single" });
    const isolated = await taskRow(isolatedId);
    assert.equal(await existingTaskWorkspacePath(isolated, sample.repo), null);
    const missingPath = join(sample.repo, ".worktrees", isolatedId);
    assert.equal(existsSync(missingPath), false);
    mkdirSync(missingPath);
    assert.equal(await existingTaskWorkspacePath(isolated, sample.repo), null);
    assert.equal(await existingTaskWorkspacePath({ ...isolated, useWorktree: false, parentId: null }, sample.repo), sample.repo);
    const missingRepo = join(root, "absent-project");
    assert.equal(await existingTaskWorkspacePath({ ...isolated, useWorktree: false, parentId: null }, missingRepo), null);
    assert.equal(existsSync(missingRepo), false);
  }

  console.log(JSON.stringify({ platform: process.platform, acceptedReceipt: true, archivedReceipt: true,
    missingWorkspace: true, stateAndLogsReadonly: true, batchPrecheckReadonly: true, workspaceOwnership: true }));
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}

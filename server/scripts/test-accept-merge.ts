// Deterministic acceptance merge regression suite. Every case owns a temporary
// repository; no checkout or ref update can escape into the harness repo.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "harness-accept-merge-test-"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function hasRef(repo: string, branch: string): boolean {
  try {
    git(repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

function makeRepo(name: string): string {
  const repo = join(root, name);
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.name", "Harness Accept Test");
  git(repo, "config", "user.email", "accept@example.test");
  writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
  writeFileSync(join(repo, "shared.txt"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "seed");
  return repo;
}

try {
  const {
    cleanupAcceptedTask,
    mergeTaskBranch,
    prepareWorktree,
    worktreeBranchName,
  } = await import("../src/git.js");
  const { taskBranchDiff } = await import("../src/git-diff.js");

  // 1. Pure ref-only fast-forward, followed by worktree + `branch -d` cleanup.
  {
    const repo = makeRepo("fast-forward");
    const taskId = "acceptff0001";
    const ws = await prepareWorktree(repo, taskId, "main");
    writeFileSync(join(ws.path, "ff.txt"), "fast forward\n");
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-m", "task ff");
    git(repo, "checkout", "-b", "parking"); // release main without touching task branch

    const before = await taskBranchDiff(repo, taskId, "main");
    assert.equal(before.available, true);
    assert.deepEqual(before.files.map((file) => file.path), ["ff.txt"]);
    assert.match(before.diff, /fast forward/);
    const capped = await taskBranchDiff(repo, taskId, "main", 16);
    assert.equal(capped.truncated, true);
    assert.ok(Buffer.byteLength(capped.diff) <= 16);

    const merged = await mergeTaskBranch(repo, taskId, "main");
    assert.equal(merged.ok, true);
    if (!merged.ok) throw new Error(merged.message);
    assert.equal(merged.method, "fast_forward");
    assert.equal(git(repo, "rev-parse", "main"), git(repo, "rev-parse", worktreeBranchName(taskId)));

    const cleanup = await cleanupAcceptedTask(repo, taskId, "main");
    assert.equal(cleanup.ok, true);
    if (!cleanup.ok) throw new Error(cleanup.message);
    assert.equal(cleanup.worktreeRemoved, true);
    assert.equal(cleanup.branchDeleted, true);
    assert.equal(existsSync(ws.path), false);
    assert.equal(hasRef(repo, worktreeBranchName(taskId)), false);
  }

  // 2. Diverged histories: merge in a temporary target worktree with --no-ff.
  {
    const repo = makeRepo("no-fast-forward");
    const taskId = "acceptnf0002";
    const ws = await prepareWorktree(repo, taskId, "main");
    writeFileSync(join(ws.path, "source.txt"), "source side\n");
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-m", "source side");
    writeFileSync(join(repo, "target.txt"), "target side\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "target side");
    git(repo, "checkout", "-b", "parking");

    const merged = await mergeTaskBranch(repo, taskId, "main");
    assert.equal(merged.ok, true);
    if (!merged.ok) throw new Error(merged.message);
    assert.equal(merged.method, "merge_commit");
    assert.equal(git(repo, "rev-list", "--parents", "-n", "1", "main").split(" ").length, 3);
    assert.equal(git(repo, "show", "main:source.txt"), "source side");
    assert.equal(git(repo, "show", "main:target.txt"), "target side");
  }

  // 3. Conflict: collect files, abort, remove the temporary worktree, preserve refs.
  {
    const repo = makeRepo("conflict");
    const taskId = "acceptcf0003";
    const ws = await prepareWorktree(repo, taskId, "main");
    writeFileSync(join(ws.path, "shared.txt"), "source version\n");
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-m", "source conflict");
    writeFileSync(join(repo, "shared.txt"), "target version\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "target conflict");
    const targetBefore = git(repo, "rev-parse", "main");
    git(repo, "checkout", "-b", "parking");

    const merged = await mergeTaskBranch(repo, taskId, "main");
    assert.equal(merged.ok, false);
    if (merged.ok) throw new Error("conflict unexpectedly merged");
    assert.equal(merged.reason, "merge_conflict");
    assert.deepEqual(merged.conflictFiles, ["shared.txt"]);
    assert.equal(git(repo, "rev-parse", "main"), targetBefore, "target ref must remain unchanged");
    assert.equal(hasRef(repo, worktreeBranchName(taskId)), true);
    assert.equal(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 2);
  }

  // 4. Source is already an ancestor of target: skip merge and clean directly.
  {
    const repo = makeRepo("already-merged");
    const taskId = "acceptam0004";
    const ws = await prepareWorktree(repo, taskId, "main");
    writeFileSync(join(ws.path, "already.txt"), "merged earlier\n");
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-m", "already merged work");
    git(repo, "worktree", "remove", "--force", ws.path);
    const branchOnlyDiff = await taskBranchDiff(repo, taskId, "main");
    assert.equal(branchOnlyDiff.available, true, "worktree 目录没了但分支还在时仍应能出 diff");
    assert.deepEqual(branchOnlyDiff.files.map((file) => file.path), ["already.txt"]);
    git(repo, "checkout", "-b", "parking");
    git(repo, "branch", "-f", "main", worktreeBranchName(taskId));

    const merged = await mergeTaskBranch(repo, taskId, "main");
    assert.equal(merged.ok, true);
    if (!merged.ok) throw new Error(merged.message);
    assert.equal(merged.method, "already_merged");
    const cleanup = await cleanupAcceptedTask(repo, taskId, "main");
    assert.equal(cleanup.ok, true);
    assert.equal(existsSync(ws.path), false);
    assert.equal(hasRef(repo, worktreeBranchName(taskId)), false);
  }

  // 5. Target is checked out in the project directory and dirty: report only.
  {
    const repo = makeRepo("dirty-target");
    const taskId = "acceptdt0005";
    const ws = await prepareWorktree(repo, taskId, "main");
    writeFileSync(join(ws.path, "task.txt"), "task output\n");
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-m", "task output");
    const targetBefore = git(repo, "rev-parse", "main");
    writeFileSync(join(repo, "shared.txt"), "local dirty change\n");

    const merged = await mergeTaskBranch(repo, taskId, "main");
    assert.equal(merged.ok, false);
    if (merged.ok) throw new Error("dirty target unexpectedly merged");
    assert.equal(merged.reason, "target_dirty");
    assert.deepEqual(merged.dirtyFiles, ["shared.txt"]);
    assert.equal(git(repo, "rev-parse", "main"), targetBefore);
    assert.equal(existsSync(ws.path), true);
    assert.equal(hasRef(repo, worktreeBranchName(taskId)), true);
  }

  console.log("accept merge: ff / no-ff / conflict / already-merged / dirty-target 全部通过");
} finally {
  rmSync(root, { recursive: true, force: true });
}

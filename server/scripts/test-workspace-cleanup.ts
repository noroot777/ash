// 删除任务时的 worktree/分支去留（server/src/workspace-cleanup.ts）。
//
// 覆盖删除确认框依赖的全部事实：
//   1. 检测按两项分别报 —— 目录被手删过、分支还在（反过来也一样）都要如实说
//   2. 勾了「一起删」→ 目录和分支都真的没了
//   3. worktree 脏 / 分支未合并 → 默认路径**不删**，把 git 原话回给用户
//   4. force 是第二次点击才有的逃生口：--force / -D 才真的丢掉那些改动
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "harness-workspace-cleanup-"));
const repo = join(root, "repo");
process.env.HARNESS_DB = join(root, "harness.db");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const branchExists = (name: string) => {
  try {
    git(repo, "show-ref", "--verify", "--quiet", `refs/heads/${name}`);
    return true;
  } catch {
    return false;
  }
};

try {
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.name", "Harness Test");
  git(repo, "config", "user.email", "harness@example.test");
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "seed");

  const { prepareWorktree, worktreeBranchName } = await import("../src/git.js");
  const { detectTaskWorkspace, discardTaskWorkspace } = await import("../src/workspace-cleanup.js");

  // ── 1. 检测：目录和分支各报各的 ─────────────────────────────────────────
  {
    const taskId = "detect00001";
    assert.deepEqual(
      await detectTaskWorkspace(repo, taskId),
      { path: null, branch: null },
      "没跑过的任务不该报出任何残留",
    );

    const ws = await prepareWorktree(repo, taskId, "main");
    const both = await detectTaskWorkspace(repo, taskId);
    assert.equal(both.path, ws.path);
    assert.equal(both.branch, worktreeBranchName(taskId));

    // 用户自己 rm -rf 掉目录：分支还在，删除对话框仍要提示它。
    rmSync(ws.path, { recursive: true, force: true });
    const onlyBranch = await detectTaskWorkspace(repo, taskId);
    assert.equal(onlyBranch.path, null, "目录没了就该报 null");
    assert.equal(onlyBranch.branch, worktreeBranchName(taskId), "分支还在,不能一起漏掉");
  }

  // ── 2. 勾了「一起删」：干净的 worktree + 已合并分支 → 两样都没了 ─────────
  {
    const taskId = "cleandel002";
    const ws = await prepareWorktree(repo, taskId, "main");
    const branch = worktreeBranchName(taskId);
    const res = await discardTaskWorkspace(repo, taskId, { worktree: true, branch: true });
    assert.equal(res.worktreeRemoved, true, res.worktreeError ?? "worktree 应被删除");
    assert.equal(res.branchDeleted, true, res.branchError ?? "分支应被删除");
    assert.equal(existsSync(ws.path), false);
    assert.equal(branchExists(branch), false);
    assert.deepEqual(await detectTaskWorkspace(repo, taskId), { path: null, branch: null });
  }

  // ── 3. 脏 worktree / 未合并分支：默认一律不删，如实回 git 的原话 ─────────
  {
    const taskId = "dirtycase03";
    const ws = await prepareWorktree(repo, taskId, "main");
    const branch = worktreeBranchName(taskId);
    writeFileSync(join(ws.path, "agent-work.txt"), "未提交的产出\n");
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-m", "agent work"); // 未合并进 main
    writeFileSync(join(ws.path, "scratch.txt"), "还没提交\n"); // 且工作区是脏的

    const res = await discardTaskWorkspace(repo, taskId, { worktree: true, branch: true });
    assert.equal(res.worktreeRemoved, false, "脏 worktree 不该被默认删掉");
    assert.ok(res.worktreeError, "必须把 git 的拒绝理由带回去");
    // 这条报错是用户决定「要不要带 force 再点一次」的唯一依据：git 只说"有未跟踪文件"，
    // 不说是哪个——强删掉的是什么，得当场看得见。
    assert.ok(
      res.worktreeError?.includes("scratch.txt"),
      `拒绝理由要点名挡路的文件，实际是：${res.worktreeError}`,
    );
    assert.equal(existsSync(ws.path), true, "文件必须还在");
    assert.equal(res.branchDeleted, false, "目录还占着分支,分支也删不掉");
    assert.ok(res.branchError);
    assert.equal(branchExists(branch), true);

    // ── 4. 用户看过报错仍然要删 → force：--force + -D ────────────────────
    const forced = await discardTaskWorkspace(repo, taskId, { worktree: true, branch: true, force: true });
    assert.equal(forced.worktreeRemoved, true, forced.worktreeError ?? "--force 应删掉脏 worktree");
    assert.equal(forced.branchDeleted, true, forced.branchError ?? "-D 应删掉未合并分支");
    assert.equal(existsSync(ws.path), false);
    assert.equal(branchExists(branch), false);
  }

  // ── 5. 只删一项：没勾的那项必须原样留着 ─────────────────────────────────
  {
    const taskId = "onlybranch4";
    const ws = await prepareWorktree(repo, taskId, "main");
    const branch = worktreeBranchName(taskId);
    const res = await discardTaskWorkspace(repo, taskId, { worktree: true, branch: false });
    assert.equal(res.worktreeRemoved, true, res.worktreeError ?? "worktree 应被删除");
    assert.equal(res.branch, null, "没勾分支就不该去碰它");
    assert.equal(existsSync(ws.path), false);
    assert.equal(branchExists(branch), true, "分支必须留着");

    const rest = await detectTaskWorkspace(repo, taskId);
    assert.deepEqual(rest, { path: null, branch }, "剩下的东西要能被再问出来");
    // 什么都不勾时是纯 no-op（DELETE 不带参数走的就是这条）。
    const noop = await discardTaskWorkspace(repo, taskId, { worktree: false, branch: false });
    assert.deepEqual(noop, {
      path: null,
      branch: null,
      worktreeRemoved: false,
      branchDeleted: false,
      worktreeError: null,
      branchError: null,
    });
    assert.equal(branchExists(branch), true);
  }

  console.log("删除任务的 worktree/分支清理：全部通过");
} finally {
  rmSync(root, { recursive: true, force: true });
}

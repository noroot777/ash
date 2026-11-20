// 删除任务时的 worktree/分支去留（server/src/workspace-cleanup.ts）。
//
// 覆盖删除确认框依赖的全部事实：
//   1. 检测按两项分别报 —— 目录被手删过、分支还在（反过来也一样）都要如实说
//   2. 勾了「一起删」→ 目录和分支都真的没了
//   3. worktree 脏 / 分支未合并 → 默认路径**不删**，把 git 原话回给用户
//   4. force 是第二次点击才有的逃生口：--force / -D 才真的丢掉那些改动
//   6. 按提交删分支时不和别人检出它撞车：先占住再删
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTmpStage } from "./tmp-db.js";
import { raceShim } from "./git-race-shim.js";

const root = mkdtempSync(join(tmpdir(), "navi-workspace-cleanup-"));
const repo = join(root, "repo");
process.env.NAVI_DB = join(root, "ash.db");

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
  git(repo, "config", "user.name", "Navi Test");
  git(repo, "config", "user.email", "navi@example.test");
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

  // ── 6. 按提交删分支（forceBranchAt）与别人检出它撞在一起 ─────────────────
  // 原先先看一眼「没被检出」再 update-ref -d：两步之间项目目录 switch 到它，那份检出就停在一个不存在的分支上
  // （HEAD 悬空、所有文件都成了暂存的新增）。现在先用临时 worktree 占住再删：删的那一下切不过去；
  // 占之前已经被检出了就不删。夹具是 sh 写的 git 包装，Windows 上跳过。
  if (process.platform !== "win32") {
    const racing = raceShim(root);
    const prepare = async (taskId: string) => {
      const ws = await prepareWorktree(repo, taskId, "main");
      writeFileSync(join(ws.path, `${taskId}.txt`), "work\n");
      git(ws.path, "add", "-A");
      git(ws.path, "commit", "-m", "work");
      return { branch: worktreeBranchName(taskId), tip: git(ws.path, "rev-parse", "HEAD") };
    };

    { // 删的那一下有人 switch 过来：占着，git 拒掉，分支照删，项目目录还在 main 上、干净
      const taskId = "raceDelete6";
      const { branch, tip } = await prepare(taskId);
      const { value, switched, log } = await racing({ repo, branch, when: ["update-ref", "-d"] },
        () => discardTaskWorkspace(repo, taskId, { worktree: true, branch: true, forceBranchAt: tip }));
      assert.equal(switched, false, `删的时候切不过去（${log}）`);
      assert.match(log, /already (used by worktree|checked out)/, "是被占位挡下的");
      assert.equal(value.branchDeleted, true, value.branchError ?? "分支应被删除");
      assert.equal(branchExists(branch), false);
      assert.equal(git(repo, "symbolic-ref", "HEAD"), "refs/heads/main", "项目目录没被切到要删的分支上");
      assert.equal(git(repo, "status", "--porcelain"), "", "没有凭空多出的暂存");
      assert.equal(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1, "占位的临时 worktree 拆掉了");
    }
    { // 占之前就被检出了：占不住，不删，那份检出原样留着
      const taskId = "raceKeep006";
      const { branch, tip } = await prepare(taskId);
      const { value, switched } = await racing({ repo, branch, when: ["worktree", "add", "--no-checkout"] },
        () => discardTaskWorkspace(repo, taskId, { worktree: true, branch: true, forceBranchAt: tip }));
      assert.equal(switched, true, "前提：占位之前项目目录切到了它");
      assert.equal(value.worktreeRemoved, true);
      assert.equal(value.branchDeleted, false, "被检出着的分支不许删");
      assert.match(value.branchError ?? "", /检出/);
      assert.equal(git(repo, "rev-parse", branch), tip, "分支还在原处");
      assert.equal(git(repo, "rev-parse", "HEAD"), tip, "项目目录的检出完好");
      assert.equal(git(repo, "status", "--porcelain"), "");
      git(repo, "switch", "-q", "main");
    }
  }

  console.log("删除任务的 worktree/分支清理：全部通过");
} finally {
  await removeTmpStage(root);
}

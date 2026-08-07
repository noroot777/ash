// worktree 被删到一半留下空壳之后，还能不能收拾干净。
//
// 事故原型：`git worktree remove` 的收尾是「删注册项 → 递归删目录内容 → rmdir 顶层」。
// 顶层这一下并不保险 —— 被 .gitignore 掉的构建产物、删的同时还有后台进程往
// node_modules/.vite 里写缓存，都会让它撞上 "Directory not empty"。此时注册项和 `.git`
// 已经先没了，留下的就是一个 git 不再认识的空壳。空壳一旦形成：
//   · 验收清理每次重试都撞 "is not a working tree"，任务永远卡在 merged 验收不掉；
//   · prepareWorktree 看见目录还在就当活 worktree 复用，agent 的 git 命令一路上溯到主仓。
// 空壳怎么来的取决于时序，测试不去复现它，直接构造它留下的**状态**。
//
// 覆盖四条：
//   1. 正常删除：ignored 残渣一起清掉，注册项跟着没，分支原样留着
//   2. 已经是空壳 → 再删一次必须成功（幂等），注册项在不在都一样
//   3. 空壳被 prepareWorktree 撞见 → 恢复成真 worktree，之前的提交原样回来
//   4. 工作区真脏（tracked 文件有未提交改动）→ 不带 force 仍然必须被拒，目录留着
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "harness-worktree-leftover-"));
const repo = join(root, "repo");
process.env.HARNESS_DB = join(root, "harness.db");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

try {
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.name", "Harness Test");
  git(repo, "config", "user.email", "harness@example.test");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "seed");

  const { prepareWorktree, removeWorktree, worktreeBranchName } = await import("../src/git.js");

  // 一个跑过活的 worktree：有自己的提交，也有构建留下的、被忽略的一坨。
  const seedWorktree = async (taskId: string) => {
    const ws = await prepareWorktree(repo, taskId, "main");
    writeFileSync(join(ws.path, "agent-work.txt"), "agent output\n");
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-m", "agent work");
    mkdirSync(join(ws.path, "node_modules", ".vite"), { recursive: true });
    writeFileSync(join(ws.path, "node_modules", ".vite", "deps.json"), "{}\n");
    return ws;
  };

  // 把一个跑过活的 worktree 打成空壳：目录和 ignored 残渣留着，`.git` 没了。
  // unregister=true 再把注册项一起抹掉 —— 那正是线上报 "is not a working tree" 的那种。
  const wreck = (path: string, taskId: string, unregister: boolean) => {
    rmSync(join(path, ".git"), { force: true });
    if (unregister) rmSync(join(repo, ".git", "worktrees", taskId), { recursive: true, force: true });
    assert.equal(existsSync(path), true, "前置条件：空壳的目录还在");
    assert.equal(existsSync(join(path, "node_modules", ".vite", "deps.json")), true, "前置条件：残渣还在");
  };

  // ── 1. 正常删除：ignored 残渣一起清掉 ───────────────────────────────────
  {
    const taskId = "ignored00001";
    const ws = await seedWorktree(taskId);
    await removeWorktree(repo, ws.path, false);
    assert.equal(existsSync(ws.path), false, "被忽略的文件不该拦住验收清理");
    assert.equal(
      git(repo, "worktree", "list").includes(ws.path),
      false,
      "注册项也要跟着没掉，否则分支还被 git 当成 checked out",
    );
    // 分支必须原样留着：删分支是验收清理后面那一步的事，这里越权删了就再也找不回来。
    assert.match(git(repo, "branch", "--list", worktreeBranchName(taskId)), /harness\//);
  }

  // ── 2. 已经是空壳 → 再删一次必须成功 ────────────────────────────────────
  // taskId 的前 8 位就是分支名，各用例之间必须错开，否则会共用同一条分支。
  for (const [taskId, unregister] of [["shelgone0002", true], ["shelkeep0003", false]] as const) {
    const ws = await seedWorktree(taskId);
    wreck(ws.path, taskId, unregister);

    await removeWorktree(repo, ws.path, false);
    assert.equal(existsSync(ws.path), false, `空壳必须能被再删一次（注册项${unregister ? "已" : "未"}清），否则验收永远卡在 merged`);
    assert.equal(git(repo, "worktree", "list").includes(ws.path), false, "陈旧注册项要顺手 prune 掉");
    assert.match(git(repo, "branch", "--list", worktreeBranchName(taskId)), /harness\//, "分支不归这一步管");
  }

  // ── 3. 空壳被 prepareWorktree 撞见 → 恢复成真 worktree ──────────────────
  {
    const taskId = "reuseshell04";
    const ws = await seedWorktree(taskId);
    wreck(ws.path, taskId, true);

    const back = await prepareWorktree(repo, taskId, "main");
    assert.equal(existsSync(join(back.path, ".git")), true, "复用空壳等于让 agent 在主仓里提交");
    assert.equal(back.path, ws.path, "恢复要落回同一个路径");
    assert.equal(!!back.fresh, false, "分支还在，工作该原样接回来");
    assert.equal(existsSync(join(back.path, "agent-work.txt")), true, "之前的产出必须回来");
    assert.equal(git(back.path, "rev-parse", "--abbrev-ref", "HEAD"), worktreeBranchName(taskId));
  }

  // ── 4. 工作区真脏 → 仍然必须被拒 ────────────────────────────────────────
  {
    const taskId = "dirtyguard05";
    const ws = await seedWorktree(taskId);
    writeFileSync(join(ws.path, "agent-work.txt"), "还没提交的改动\n");

    await assert.rejects(
      () => removeWorktree(repo, ws.path, false),
      /modified or untracked|contains modified/,
      "有未提交改动时不带 force 必须被 git 拦下，把原话摆给用户",
    );
    assert.equal(existsSync(join(ws.path, ".git")), true, "被拒之后 worktree 要完好，不能删到一半");
    assert.match(git(ws.path, "status", "--porcelain"), /^M\s+agent-work\.txt$/, "改动一个字都不能少");

    // 用户看过报错、明确要求删掉时，force 依然管用。
    await removeWorktree(repo, ws.path, true);
    assert.equal(existsSync(ws.path), false);
  }

  console.log("worktree 残骸清理 / 幂等 / 复用防护 / 脏工作区拦截：全部通过");
} finally {
  rmSync(root, { recursive: true, force: true });
}

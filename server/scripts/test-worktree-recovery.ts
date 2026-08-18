// worktree 被删之后再动这个任务，会发生什么。
//
// 覆盖四条曾经出过问题的路径：
//   1. 分支还在、只是目录没了 → 必须「恢复」，文件和提交原样回来
//   2. 目录被 rm -rf、git 里仍注册着 → prune 之后同样能恢复
//   3. 目录和分支都没了 → 重建空壳，并且标记 fresh，让接回旧会话的调用方
//      有机会打断 agent 的记忆连续性
//   4. 登记的 base ref 已经不存在（验收合并后目标分支被删）→ 退回仓库当前 HEAD 重建，
//      并把降级如实带回给调用方，而不是整轮起不来
//   5. cwd 不存在时 spawn 的预检不能把任务卡死（历史事故：'error' 没人监听 →
//      uncaughtException 被兜底吞掉 → 任务永久 running、停不掉）
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "harness-worktree-recovery-"));
const repo = join(root, "repo");
process.env.HARNESS_DB = join(root, "harness.db");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

try {
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.name", "Harness Test");
  git(repo, "config", "user.email", "harness@example.test");
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "seed");

  const { prepareWorktree, worktreeBranchName } = await import("../src/git.js");

  // 每个用例先建一个 worktree，在里面留下 agent 的产出，再按各自的方式破坏它。
  const seedWorktree = async (taskId: string) => {
    const ws = await prepareWorktree(repo, taskId, "main");
    writeFileSync(join(ws.path, "agent-work.txt"), "agent output\n");
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-m", "agent work");
    assert.equal(ws.fresh, true, "第一次创建应标记为 fresh");
    return ws;
  };

  // ── 1. 分支还在，只是目录被正规移除 → 恢复 ──────────────────────────────
  {
    const taskId = "keepbranch01";
    const ws = await seedWorktree(taskId);
    git(repo, "worktree", "remove", "--force", ws.path);
    assert.equal(existsSync(ws.path), false);

    const back = await prepareWorktree(repo, taskId, "main");
    assert.equal(!!back.fresh, false, "分支还在时必须恢复，不能标记 fresh");
    assert.equal(existsSync(join(back.path, "agent-work.txt")), true, "文件必须回来");
    assert.match(git(back.path, "log", "--oneline"), /agent work/, "提交必须回来");
    assert.equal(git(back.path, "rev-parse", "--abbrev-ref", "HEAD"), worktreeBranchName(taskId));
  }

  // ── 2. 目录被 rm -rf、git 里仍注册 → prune 后同样恢复 ───────────────────
  {
    const taskId = "rmrfcase002";
    const ws = await seedWorktree(taskId);
    rmSync(ws.path, { recursive: true, force: true }); // 用户直接删文件夹

    const back = await prepareWorktree(repo, taskId, "main");
    assert.equal(!!back.fresh, false, "陈旧注册被 prune 掉后仍应恢复");
    assert.equal(existsSync(join(back.path, "agent-work.txt")), true, "文件必须回来");
  }

  // ── 3. 目录和分支都没了 → 重建空壳，标记 fresh ──────────────────────────
  {
    const taskId = "allgone0003";
    const ws = await seedWorktree(taskId);
    git(repo, "worktree", "remove", "--force", ws.path);
    git(repo, "branch", "-D", worktreeBranchName(taskId));

    const rebuilt = await prepareWorktree(repo, taskId, "main");
    assert.equal(rebuilt.fresh, true, "工作确实丢了，必须标记 fresh 让调用方警告 agent");
    assert.equal(existsSync(join(rebuilt.path, "agent-work.txt")), false, "空壳里不该有旧文件");
    assert.equal(existsSync(join(rebuilt.path, "seed.txt")), true, "应从 base 拉出干净副本");
  }

  // ── 4. 登记的 base 分支已被删 → 退回仓库当前 HEAD，并如实交代 ────────────
  // 现场：任务验收合并之后目标分支被删，几天后用户又在这个任务里发了句话。老做法是
  // `git worktree add ... <已删的 base>` 当场抛 invalid reference，整轮起不来，而用户
  // 侧一点反馈都没有（实测任务 gsppwUacwZnn）。
  {
    const taskId = "basegone004";
    git(repo, "branch", "feat/temp-base");
    const ws = await prepareWorktree(repo, taskId, "feat/temp-base");
    git(repo, "worktree", "remove", "--force", ws.path);
    git(repo, "branch", "-D", worktreeBranchName(taskId));
    git(repo, "branch", "-D", "feat/temp-base"); // 合并后被删

    const rebuilt = await prepareWorktree(repo, taskId, "feat/temp-base");
    assert.equal(existsSync(join(rebuilt.path, "seed.txt")), true, "base 没了也必须建得出来");
    assert.equal(rebuilt.baseFallback?.requested, "feat/temp-base", "要说清原本想用哪个 base");
    assert.ok(rebuilt.baseFallback?.used, "要说清实际按什么起的");
  }

  // ── 5. cwd 不存在时，预检必须干净地失败，而不是卡死 ─────────────────────
  {
    const { spawnAgent } = await import("../src/executors/spawn.js");
    const child = spawnAgent({ kind: "local" }, join(root, "does-not-exist"), "claude", [], "hi");
    const message = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("预检的 error 事件没有送达 —— 任务会卡死")), 3000);
      // 监听器故意晚一拍才挂上，模拟惰性 async generator 的真实时序。
      setImmediate(() => {
        child.on("error", (err: Error) => {
          clearTimeout(timer);
          resolve(err.message);
        });
      });
    });
    assert.match(message, /工作目录不存在/, "报错要说清是 cwd 的问题");
  }

  console.log("worktree 恢复 / 重建 / 预检失败：全部通过");
} finally {
  rmSync(root, { recursive: true, force: true });
}

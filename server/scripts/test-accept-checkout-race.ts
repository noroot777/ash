// 验收合并在「目标分支就检出在项目目录」时的竞态（git-checkout-land.ts）：锁外核完干净、目标检出在这里之后，
// 另一个终端切了分支 —— 原先的 `git merge` 对的是「届时的 HEAD」，合并就落进了那个分支。现在合并在旁边的
// 临时检出里合，持 index.lock 核过 HEAD 才落进来：切走了就什么都不动；持锁期间想切，git 当场拒。
//
// 用 PATH 上的 git 包装（git-race-shim.ts）在关键那条命令前后插一次 `git switch side`。每个用例自带临时仓库。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTmpStage } from "./tmp-db.js";
import { raceShim } from "./git-race-shim.js";

const root = mkdtempSync(join(tmpdir(), "navi-accept-checkout-race-"));
process.env.NAVI_DB = join(root, "navi.db");
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

try {
  if (process.platform === "win32") {
    console.log("accept checkout race: 夹具是 sh 写的 git 包装，Windows 上跳过");
  } else {
    const { prepareWorktree } = await import("../src/git.js");
    const { mergeTaskBranch } = await import("../src/git-accept.js");
    const racing = raceShim(root);

    /** 项目目录检出着 main；任务分支一个提交；`diverge` 时 main 上也多一个提交（不能快进）。另有一个 side 停在 main 上。 */
    const stage = async (name: string, diverge: boolean) => {
      const repo = join(root, name);
      execFileSync("git", ["init", "-q", "-b", "main", repo]);
      git(repo, "config", "user.name", "Navi Race Test");
      git(repo, "config", "user.email", "race@example.test");
      writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
      writeFileSync(join(repo, "shared.txt"), "seed\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "seed");
      const taskId = `race${name.replace(/[^a-z]/g, "").slice(0, 8).padEnd(8, "x")}`;
      const ws = await prepareWorktree(repo, taskId, "main");
      writeFileSync(join(ws.path, "task.txt"), "task\n");
      git(ws.path, "add", "-A");
      git(ws.path, "commit", "-q", "-m", "task");
      if (diverge) {
        writeFileSync(join(repo, "target.txt"), "target\n");
        git(repo, "add", "-A");
        git(repo, "commit", "-q", "-m", "target");
      }
      git(repo, "branch", "side");
      return { repo, taskId, main: git(repo, "rev-parse", "main"), side: git(repo, "rev-parse", "side") };
    };
    const clean = (repo: string, what: string) => {
      assert.equal(git(repo, "status", "--porcelain"), "", `${what}：项目目录没有凭空多出的暂存或改动`);
      assert.equal(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 2, `${what}：临时合并 worktree 拆掉了`);
    };

    // 1. 锁外那道「工作区干净」（git status）看完之后、真正动手之前，另一个终端把项目目录切到了 side。
    //    四种落法都钉：普通合并、squash、合并后不提交、快进。哪种都不许落进 side，main 也不动。
    const cases: { name: string; strategy: "safe" | "squash"; commit: boolean; diverge: boolean }[] = [
      { name: "merge-commit", strategy: "safe", commit: true, diverge: true },
      { name: "squash", strategy: "squash", commit: true, diverge: false },
      { name: "no-commit", strategy: "safe", commit: false, diverge: false },
      { name: "fast-forward", strategy: "safe", commit: true, diverge: false },
    ];
    for (const c of cases) {
      const s = await stage(c.name, c.diverge);
      const { value, switched, log } = await racing({ repo: s.repo, branch: "side", when: ["status", "--porcelain"], after: true },
        () => mergeTaskBranch(s.repo, s.taskId, "main", c.strategy, { commit: c.commit }));
      assert.equal(switched, true, `${c.name}：前提 —— 核完干净之后确实切走了（${log}）`);
      assert.equal(value.ok, false, `${c.name}：项目目录已经不在 main 上，这次不该算合并成功`);
      if (!value.ok) assert.match(value.message, /切到了分支 side/, `${c.name}：要说清是切走了`);
      assert.equal(git(s.repo, "rev-parse", "--abbrev-ref", "HEAD"), "side", `${c.name}：项目目录停在用户切去的分支上`);
      assert.equal(git(s.repo, "rev-parse", "side"), s.side, `${c.name}：合并没有落进 side`);
      assert.equal(git(s.repo, "rev-parse", "main"), s.main, `${c.name}：main 也没动`);
      clean(s.repo, c.name);
    }

    // 2. 持锁期间（落进项目目录之前那次演练）另一个终端想切：拿不到 index.lock，被 git 当场拒；合并照常落进 main。
    for (const c of cases) {
      const s = await stage(`${c.name}-held`, c.diverge);
      const { value, switched, log } = await racing({ repo: s.repo, branch: "side", when: ["read-tree", "-n"] },
        () => mergeTaskBranch(s.repo, s.taskId, "main", c.strategy, { commit: c.commit }));
      assert.equal(switched, false, `${c.name}：持锁期间切不走（${log}）`);
      assert.match(log, /index\.lock/, `${c.name}：是被锁挡下的`);
      assert.equal(value.ok, true, value.ok ? "" : `${c.name}：${value.message}`);
      assert.equal(git(s.repo, "rev-parse", "--abbrev-ref", "HEAD"), "main", `${c.name}：项目目录还在 main 上`);
      assert.equal(git(s.repo, "rev-parse", "side"), s.side, `${c.name}：side 没被碰`);
      if (c.commit) {
        assert.equal(git(s.repo, "show", "main:task.txt"), "task", `${c.name}：合并落进了 main`);
        clean(s.repo, c.name);
      } else {
        assert.equal(git(s.repo, "rev-parse", "main"), s.main, "不提交那一档 main 不动");
        assert.equal(git(s.repo, "diff", "--cached", "--name-only"), "task.txt", "改动暂存在项目目录里");
        assert.equal(value.ok && value.stagedTree, git(s.repo, "write-tree"), "记下的指纹就是项目目录里暂存的那棵");
      }
      if (c.name === "merge-commit") {
        assert.equal(git(s.repo, "log", "-1", "--format=%s", "main"), `Merge branch '${git(s.repo, "branch", "--list", "navi/*", "--format=%(refname:short)")}' into main`,
          "游离的临时检出里合，提交说明照样写明合进的是 main（不是 into HEAD）");
      }
    }

    // 3. 不受竞态影响时，项目目录里的合并结果和原来就地合一样：文件写进来、索引对齐。
    {
      const s = await stage("plain", true);
      const merged = await mergeTaskBranch(s.repo, s.taskId, "main");
      assert.equal(merged.ok, true, merged.ok ? "" : merged.message);
      if (merged.ok) assert.equal(merged.method, "merge_commit");
      assert.equal(git(s.repo, "rev-parse", "HEAD"), git(s.repo, "rev-parse", "main"));
      assert.equal(git(s.repo, "rev-list", "--parents", "-n", "1", "main").split(" ").length, 3);
      assert.equal(execFileSync("cat", [join(s.repo, "task.txt")], { encoding: "utf8" }), "task\n", "文件写进了项目目录");
      clean(s.repo, "无竞态");
    }

    // 4. 冲突照旧交回：在旁边的临时检出里撞上，项目目录和 main 一个字节都不动。
    {
      const s = await stage("conflict", false);
      const ws = join(s.repo, ".worktrees", s.taskId);
      writeFileSync(join(ws, "shared.txt"), "source\n");
      git(ws, "commit", "-q", "-am", "source side");
      writeFileSync(join(s.repo, "shared.txt"), "target\n");
      git(s.repo, "commit", "-q", "-am", "target side");
      const before = git(s.repo, "rev-parse", "main");
      const merged = await mergeTaskBranch(s.repo, s.taskId, "main");
      assert.equal(merged.ok, false);
      if (!merged.ok) {
        assert.equal(merged.reason, "merge_conflict");
        assert.deepEqual(merged.conflictFiles, ["shared.txt"]);
      }
      assert.equal(git(s.repo, "rev-parse", "main"), before);
      clean(s.repo, "冲突");
    }

    // 5. 合并预览档的发布（git-accept-publish.ts sealedMove）同样在拿到锁之后核 HEAD：调用方在锁外看的是
    //    「检出在被测的提交上」，那之后切到了同一提交上的 side，文件就不许写进 side 的检出。
    {
      const { sealedMove } = await import("../src/git-accept-publish.js");
      const { checkoutSettings } = await import("../src/accept-gate-preview.js");
      const s = await stage("sealed", false);
      const to = git(s.repo, "rev-parse", `${git(s.repo, "branch", "--list", "navi/*", "--format=%(refname:short)")}^{tree}`);
      git(s.repo, "switch", "-q", "side");
      let published = false;
      const moved = await sealedMove(s.repo, await checkoutSettings(s.repo), "main", s.main, to, to, async () => { published = true; return null; });
      assert.equal(moved.ok, false, "项目目录不在 main 上，不该发布");
      if (!moved.ok) {
        assert.equal(moved.stage, "blocked");
        assert.match(moved.message, /不在 main/);
      }
      assert.equal(published, false, "分支没挪");
      assert.equal(git(s.repo, "rev-parse", "main"), s.main);
      assert.equal(git(s.repo, "status", "--porcelain"), "", "side 的检出没被写");
    }

    console.log("accept checkout race: 核完再切走不落错分支 / 持锁期间切不走 / 无竞态照常落地 / 冲突照旧交回 / 预览档发布持锁核 HEAD 全部通过");
  }
} finally {
  await removeTmpStage(root);
}

// 验收往「检出在项目目录的目标分支」上写时的竞态（git-merge-locked.ts）：锁外核完干净、目标检出在这里之后，
// 另一个终端切了分支 —— 原先的 `git merge` 对的是「届时的 HEAD」，合并就落进了那个分支。现在持着 index.lock
// 和 HEAD.lock、经指着目标分支的私有 HEAD 就地合：核之前切走了就什么都不动；持住期间切已有分支、`switch -c`
// 新建分支都被 git 当场拒；写的只有目标分支，别的分支（包括被拒的 `switch -c` 留下的那个）一个字节都不动。
// 钩子照旧在项目目录里跑、看到的是目标分支。合并预览档的发布走同一层（holdCheckout）。
//
// 用 PATH 上的 git 包装（git-race-shim.ts）在关键那条命令前后插一次 `git switch`。每个用例自带临时仓库。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
      assert.equal(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 2, `${what}：没有遗留多余的 worktree`);
      assert.equal(existsSync(join(repo, ".git", "index.lock")), false, `${what}：索引锁放了`);
      assert.equal(existsSync(join(repo, ".git", "HEAD.lock")), false, `${what}：HEAD 锁放了`);
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
      if (!value.ok) assert.match(value.message, /不在 main 上了（现在是分支 side）/, `${c.name}：要说清是切走了`);
      assert.equal(git(s.repo, "rev-parse", "--abbrev-ref", "HEAD"), "side", `${c.name}：项目目录停在用户切去的分支上`);
      assert.equal(git(s.repo, "rev-parse", "side"), s.side, `${c.name}：合并没有落进 side`);
      assert.equal(git(s.repo, "rev-parse", "main"), s.main, `${c.name}：main 也没动`);
      clean(s.repo, c.name);
    }

    // 2. 持锁期间（开合的那一下）另一个终端想切：拿不到 index.lock，被 git 当场拒；合并照常落进 main。
    for (const c of cases) {
      const s = await stage(`${c.name}-held`, c.diverge);
      const { value, switched, log } = await racing({ repo: s.repo, branch: "side", when: ["merge"] },
        () => mergeTaskBranch(s.repo, s.taskId, "main", c.strategy, { commit: c.commit }));
      assert.equal(switched, false, `${c.name}：持锁期间切不走（${log}）`);
      assert.match(log, /(index|HEAD)\.lock/, `${c.name}：是被锁挡下的`);
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
        assert.ok(existsSync(join(s.repo, ".git", "SQUASH_MSG")), "默认提交说明留在项目目录里，手动提交时照样有");
      }
      // 就地合的副产物照旧：合并前的位置记在项目目录的 ORIG_HEAD 上（squash 那一档的 git commit 不写它）。
      if (c.commit && c.strategy !== "squash") assert.equal(git(s.repo, "rev-parse", "ORIG_HEAD"), s.main, `${c.name}：ORIG_HEAD 指着合并之前`);
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

    // 4. 冲突照旧交回：撞上之后中止，项目目录和 main 一个字节都不动。
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

    // 5. 持住检出的那一层（holdCheckout，合并预览档的发布也走它）：HEAD 不在目标分支上就在动任何东西之前拒；
    //    持住期间别的终端切已有分支、`switch -c` 新建分支都被拒。
    {
      const { holdCheckout } = await import("../src/git-merge-locked.js");
      const s = await stage("hold", false);
      git(s.repo, "switch", "-q", "side");
      let called = false;
      const refused = await holdCheckout(s.repo, "main", s.main, async () => { called = true; });
      assert.equal(refused.held, false, "项目目录不在 main 上，持不住");
      if (!refused.held) assert.equal(refused.stage, "moved");
      assert.equal(called, false, "什么都没做");
      git(s.repo, "switch", "-q", "main");
      const other = (...args: string[]) => {
        try { execFileSync("git", ["-C", s.repo, ...args], { stdio: ["ignore", "pipe", "pipe"] }); return "ok"; }
        catch (error) { return String((error as { stderr?: Buffer }).stderr ?? error); }
      };
      const held = await holdCheckout(s.repo, "main", s.main, async () => [other("switch", "-q", "side"), other("switch", "-q", "-c", "fresh")]);
      assert.equal(held.held, true);
      if (held.held) {
        assert.match(held.value[0], /index\.lock|HEAD\.lock/, "持住期间切不到已有分支");
        assert.match(held.value[1], /HEAD\.lock/, "持住期间 switch -c 也换不了 HEAD");
      }
      assert.equal(git(s.repo, "symbolic-ref", "HEAD"), "refs/heads/main");
      clean(s.repo, "持住检出");
    }

    // 6. 不拿索引锁的 `switch -c` 在动手前、写完目标之后抢进来（审查第 2 轮 F1）：HEAD.lock 在我们手里，
    //    它换不了 HEAD；合并只落进 main，那个分支（git 先建好分支才去改 HEAD）停在它起步的提交上、没被写进任何东西。
    for (const when of ["before", "after"] as const) {
      for (const c of cases) {
        const s = await stage(`${c.name}-create-${when}`, c.diverge);
        const trigger = when === "after" && c.strategy === "squash" && c.commit ? ["commit"] : c.commit ? ["merge"] : ["merge", "--squash"];
        const { value, switched, log } = await racing({ repo: s.repo, branch: "fresh", create: true, after: when === "after", when: trigger },
          () => mergeTaskBranch(s.repo, s.taskId, "main", c.strategy, { commit: c.commit }));
        const what = `${c.name}（switch -c ${when}）`;
        assert.equal(switched, false, `${what}：switch -c 换不了 HEAD（${log}）`);
        assert.match(log, /HEAD\.lock/, `${what}：是被 HEAD 锁挡下的`);
        assert.equal(value.ok, true, value.ok ? "" : `${what}：${value.message}`);
        assert.equal(git(s.repo, "symbolic-ref", "HEAD"), "refs/heads/main", `${what}：项目目录还在 main 上`);
        const fresh = execFileSync("git", ["-C", s.repo, "rev-parse", "--verify", "--quiet", "refs/heads/fresh"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        if (c.commit) {
          assert.equal(git(s.repo, "show", "main:task.txt"), "task", `${what}：合进了 main`);
          assert.equal(fresh, when === "before" ? s.main : git(s.repo, "rev-parse", "main"), `${what}：fresh 停在它起步的那个提交上，没被合进任何东西`);
          assert.equal(readFileSync(join(s.repo, "task.txt"), "utf8"), "task\n", `${what}：文件在磁盘上`);
          clean(s.repo, what);
        } else {
          assert.equal(fresh, s.main, `${what}：fresh 没动`);
          assert.equal(git(s.repo, "rev-parse", "main"), s.main, `${what}：不提交那一档 main 不动`);
          assert.equal(git(s.repo, "diff", "--cached", "--name-only"), "task.txt", `${what}：改动暂存在 main 的检出里`);
        }
      }
    }

    // 8. 钩子照旧在项目目录里跑（审查第 1 轮 F3）：看得到项目里被忽略的本地依赖，合并后钩子也在这里。
    for (const c of cases.filter((c) => c.commit && c.name !== "fast-forward")) {
      const s = await stage(`${c.name}-hooks`, c.diverge);
      writeFileSync(join(s.repo, ".git", "info", "exclude"), "local-ready\n");
      writeFileSync(join(s.repo, "local-ready"), "installed\n");
      const ran = join(s.repo, ".git", "navi-test-hooks.log");
      for (const hook of ["pre-merge-commit", "pre-commit", "post-merge", "post-commit"]) {
        writeFileSync(join(s.repo, ".git", "hooks", hook),
          `#!/bin/sh\necho "${hook} $(git symbolic-ref -q HEAD) $(pwd -P)" >> "${ran}"\n[ -e local-ready ] || { echo "local dependency missing" >&2; exit 1; }\n`);
        chmodSync(join(s.repo, ".git", "hooks", hook), 0o755);
      }
      const merged = await mergeTaskBranch(s.repo, s.taskId, "main", c.strategy);
      assert.equal(merged.ok, true, merged.ok ? "" : `${c.name}：${merged.message}`);
      const log = readFileSync(ran, "utf8");
      const real = execFileSync("sh", ["-c", `cd "${s.repo}" && pwd -P`], { encoding: "utf8" }).trim();
      assert.ok(log.trim().split("\n").every((line) => line.endsWith(` ${real}`)), `${c.name}：钩子都在项目目录里跑（${log}）`);
      assert.match(log, c.strategy === "squash" ? /^pre-commit /m : /^post-merge /m, `${c.name}：该跑的钩子跑了`);
      assert.ok(log.trim().split("\n").every((line) => line.includes(" refs/heads/main ")), `${c.name}：钩子看到的是目标分支（${log}）`);
      clean(s.repo, `${c.name}-hooks`);
    }

    console.log("accept checkout race: 核完再切走不落错分支 / 持锁期间切不走 / 无竞态照常落地 / 冲突照旧交回 / 持住检出时切不走 / switch -c 换不了 HEAD、只写目标分支 / 钩子在项目目录 全部通过");
  }
} finally {
  await removeTmpStage(root);
}

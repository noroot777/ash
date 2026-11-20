// 验收合并在「目标分支就检出在项目目录」时的竞态（git-merge-locked.ts）：锁外核完干净、目标检出在这里之后，
// 另一个终端切了分支 —— 原先的 `git merge` 对的是「届时的 HEAD」，合并就落进了那个分支。现在持着 index.lock
// 核过 HEAD 再用临时索引就地合：核之前切走了就什么都不动；持锁期间想切，git 当场拒；不拿锁的 `switch -c`
// 抢进来时，按合完的真实状态回报，不把没落进目标的合并说成成功、也不留下对不上的索引。钩子照旧在项目目录里跑。
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

    // 2. 持锁期间（开合的那一下）另一个终端想切：拿不到 index.lock，被 git 当场拒；合并照常落进 main。
    for (const c of cases) {
      const s = await stage(`${c.name}-held`, c.diverge);
      const { value, switched, log } = await racing({ repo: s.repo, branch: "side", when: ["merge"] },
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

    // 6. 不拿索引锁的 `switch -c` 在开合之前抢进来（HEAD 换成同一提交上的新分支）：合并落在了新分支上，
    //    不许说成合进了 main；索引是 git 按那次合并维护的，换上之后项目目录对得上，不凭空多出暂存。
    for (const c of cases) {
      const s = await stage(`${c.name}-create-before`, c.diverge);
      const { value, switched, log } = await racing({ repo: s.repo, branch: "fresh", create: true, when: ["merge"] },
        () => mergeTaskBranch(s.repo, s.taskId, "main", c.strategy, { commit: c.commit }));
      assert.equal(switched, true, `${c.name}：前提 —— switch -c 不拿索引锁，抢进来了（${log}）`);
      assert.equal(value.ok, false, `${c.name}：合并没落进 main，不该算成功`);
      if (!value.ok) assert.match(value.message, /被切到了分支 fresh/, `${c.name}：要说清落在了哪儿`);
      assert.equal(git(s.repo, "rev-parse", "main"), s.main, `${c.name}：main 没动`);
      assert.equal(git(s.repo, "rev-parse", "--abbrev-ref", "HEAD"), "fresh");
      if (c.commit) clean(s.repo, `${c.name}-create-before`);
      else assert.equal(git(s.repo, "diff", "--cached", "--name-only"), "task.txt", "不提交那一档：改动暂存在了 fresh 的检出里，与它的文件对得上");
    }

    // 7. `switch -c` 在目标分支已经挪到合并结果之后抢进来（审查第 1 轮 F2 那一幕）：新分支从合并结果起，
    //    main 也确实合进去了 —— 算成功，而且项目目录的文件和索引就是合并结果，不留暂存删除。
    for (const c of cases.filter((c) => c.commit)) {
      const s = await stage(`${c.name}-create-after`, c.diverge);
      const { value, switched, log } = await racing({ repo: s.repo, branch: "fresh", create: true, after: true,
        when: c.strategy === "squash" ? ["commit"] : ["merge"] },
      () => mergeTaskBranch(s.repo, s.taskId, "main", c.strategy, { commit: c.commit }));
      assert.equal(switched, true, `${c.name}：前提 —— 挪完之后切走了（${log}）`);
      assert.equal(value.ok, true, value.ok ? "" : `${c.name}：${value.message}`);
      assert.equal(git(s.repo, "show", "main:task.txt"), "task", `${c.name}：合进了 main`);
      assert.equal(git(s.repo, "rev-parse", "fresh"), git(s.repo, "rev-parse", "main"), `${c.name}：新分支从合并结果起`);
      assert.equal(readFileSync(join(s.repo, "task.txt"), "utf8"), "task\n", `${c.name}：文件在磁盘上`);
      clean(s.repo, `${c.name}-create-after`);
    }

    // 8. 钩子照旧在项目目录里跑（审查第 1 轮 F3）：看得到项目里被忽略的本地依赖，合并后钩子也在这里。
    for (const c of cases.filter((c) => c.commit && c.name !== "fast-forward")) {
      const s = await stage(`${c.name}-hooks`, c.diverge);
      writeFileSync(join(s.repo, ".git", "info", "exclude"), "local-ready\n");
      writeFileSync(join(s.repo, "local-ready"), "installed\n");
      const ran = join(s.repo, ".git", "navi-test-hooks.log");
      for (const hook of ["pre-merge-commit", "pre-commit", "post-merge", "post-commit"]) {
        writeFileSync(join(s.repo, ".git", "hooks", hook),
          `#!/bin/sh\necho "${hook} $(pwd -P)" >> "${ran}"\n[ -e local-ready ] || { echo "local dependency missing" >&2; exit 1; }\n`);
        chmodSync(join(s.repo, ".git", "hooks", hook), 0o755);
      }
      const merged = await mergeTaskBranch(s.repo, s.taskId, "main", c.strategy);
      assert.equal(merged.ok, true, merged.ok ? "" : `${c.name}：${merged.message}`);
      const log = readFileSync(ran, "utf8");
      const real = execFileSync("sh", ["-c", `cd "${s.repo}" && pwd -P`], { encoding: "utf8" }).trim();
      assert.ok(log.trim().split("\n").every((line) => line.endsWith(` ${real}`)), `${c.name}：钩子都在项目目录里跑（${log}）`);
      assert.match(log, c.strategy === "squash" ? /^pre-commit /m : /^post-merge /m, `${c.name}：该跑的钩子跑了`);
      clean(s.repo, `${c.name}-hooks`);
    }

    console.log("accept checkout race: 核完再切走不落错分支 / 持锁期间切不走 / 无竞态照常落地 / 冲突照旧交回 / 预览档发布持锁核 HEAD / switch -c 抢进来如实回报 / 钩子在项目目录 全部通过");
  }
} finally {
  await removeTmpStage(root);
}

// 验收往「检出在项目目录的目标分支」上写时的竞态（git-accept-checkout.ts）：锁外核完干净、目标检出在这里之后，
// 另一个终端切了分支 —— 原先的 `git merge` 对的是「届时的 HEAD」，合并悄悄落进那个分支、回执却是成功。现在
// 合并前紧贴着再核一次（已经切走的什么都不动），合完再核一次：被切走时合并落在了别处就不报成功、说清落在哪；
// 目标分支已经收到了合并、之后才切走的照常算成功。钩子、配置都是原生 `git merge` 那一套，在项目目录里跑。
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
    const { prepareWorktree, worktreeBranchName } = await import("../src/git.js");
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

    // 2. 核完之后、git 读 HEAD 之前切走（切到已有的 side / `switch -c` 新建 fresh）：合并落在了那里，不报成功、
    //    说清落在哪，目标分支没动。不替用户复位：落下的就留在那个分支上。
    for (const to of [{ branch: "side", create: false }, { branch: "fresh", create: true }]) {
      for (const c of cases) {
        const s = await stage(`${c.name}-to-${to.branch}`, c.diverge);
        const { value, switched, log } = await racing({ repo: s.repo, branch: to.branch, create: to.create, when: ["merge"] },
          () => mergeTaskBranch(s.repo, s.taskId, "main", c.strategy, { commit: c.commit }));
        const what = `${c.name}（切到 ${to.branch}）`;
        assert.equal(switched, true, `${what}：前提 —— 合并之前确实切走了（${log}）`);
        assert.equal(value.ok, false, `${what}：合并没落在 main 上，不算成功`);
        if (!value.ok) assert.match(value.message, new RegExp(c.commit ? `没法确认这次合并落在了 main 上[^]*现在是分支 ${to.branch}` : `被切过（现在是分支 ${to.branch}），暂存的改动跟着到了那里`), what);
        assert.equal(git(s.repo, "rev-parse", "main"), s.main, `${what}：main 没动`);
        assert.equal(git(s.repo, "symbolic-ref", "HEAD"), `refs/heads/${to.branch}`, `${what}：项目目录停在用户切去的分支上`);
        if (c.commit) assert.equal(git(s.repo, "show", `${to.branch}:task.txt`), "task", `${what}：说的那一下确实落在 ${to.branch} 上`);
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

    // 5. 合并已经落进 main 之后才 `switch -c`：目标分支收到了这次合并，照常算成功；之后切走是用户自己的事。
    //    不提交那一档的改动还在暂存区里，跟着切走了就不在 main 的检出里，不算成功。
    for (const c of cases) {
      const s = await stage(`${c.name}-create-after`, c.diverge);
      const trigger = c.strategy === "squash" && c.commit ? ["commit"] : c.commit ? ["merge"] : ["merge", "--squash"];
      const { value, switched, log } = await racing({ repo: s.repo, branch: "fresh", create: true, after: true, when: trigger },
        () => mergeTaskBranch(s.repo, s.taskId, "main", c.strategy, { commit: c.commit }));
      const what = `${c.name}（合完再 switch -c）`;
      assert.equal(switched, true, `${what}：前提 —— 合完之后切走了（${log}）`);
      assert.equal(git(s.repo, "symbolic-ref", "HEAD"), "refs/heads/fresh");
      if (c.commit) {
        assert.equal(value.ok, true, value.ok ? "" : `${what}：${value.message}`);
        assert.equal(git(s.repo, "show", "main:task.txt"), "task", `${what}：合进了 main`);
      } else {
        assert.equal(value.ok, false, `${what}：暂存的改动不在 main 的检出里了`);
        if (!value.ok) assert.match(value.message, /被切过（现在是分支 fresh），暂存的改动跟着到了那里/);
        assert.equal(git(s.repo, "rev-parse", "main"), s.main);
      }
    }

    // 7. 成功只认实证（审查第 4 轮 F1）：合并前切到 side、合完又切回 main（HEAD 又是 main 了）/ 切到一个已经含任务
    //    改动的分支（squash 在那里得出「已经合入」）/ 合并落在 side 的同时别人往 main 上加了一个无关提交（main 动了）——
    //    main 都没收到这次合并，一律不报成功，也不替用户复位。
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    /** 第一条 `git <sub>`（默认 merge；squash 落提交的是 commit）跑之前先跑 `before`、跑完再跑 `after`（只一次）。 */
    const aroundMerge = async <T>(name: string, before: string, after: string, run: () => Promise<T>, sub = "merge") => {
      const bin = join(root, `${name}-bin`);
      execFileSync("mkdir", ["-p", bin]);
      const mark = join(bin, "fired");
      writeFileSync(join(bin, "git"), `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = ${sub} ] && hit=1; done\n`
        + `if [ ! -e '${mark}' ] && [ -n "$hit" ]; then\n  : > '${mark}'; ${before}\n`
        + `  '${realGit}' "$@"; rc=$?; ${after}; exit $rc\nfi\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
      const path = process.env.PATH;
      process.env.PATH = `${bin}:${path}`;
      try { return await run(); } finally {
        process.env.PATH = path;
        assert.ok(existsSync(mark), `${name}：前提 —— 包装真的插在了 git ${sub} 前后`);
      }
    };
    const shell = (repo: string, ...args: string[]) => `'${realGit}' -C '${repo}' ${args.join(" ")}`;
    for (const c of cases.filter((c) => c.commit)) {
      const s = await stage(`${c.name}-aba`, c.diverge);
      const value = await aroundMerge(`${c.name}-aba`, shell(s.repo, "switch", "-q", "side"), shell(s.repo, "switch", "-q", "main"),
        () => mergeTaskBranch(s.repo, s.taskId, "main", c.strategy), c.strategy === "squash" ? "commit" : "merge");
      const what = `${c.name}（切走再切回）`;
      assert.equal(git(s.repo, "symbolic-ref", "HEAD"), "refs/heads/main", `${what}：前提 —— HEAD 又回到了 main`);
      assert.equal(value.ok, false, `${what}：main 没收到合并，不算成功`);
      if (!value.ok) assert.match(value.message, /没法确认这次合并落在了 main 上/, what);
      assert.equal(git(s.repo, "rev-parse", "main"), s.main, `${what}：main 没动`);
    }
    {
      const s = await stage("already-elsewhere", false);
      git(s.repo, "branch", "-f", "side", `${worktreeBranchName(s.taskId)}`);
      const value = await aroundMerge("already-elsewhere", shell(s.repo, "switch", "-q", "side"), ":",
        () => mergeTaskBranch(s.repo, s.taskId, "main", "squash"));
      assert.equal(value.ok, false, "在 side 上得出的「已经合入」不能当成 main 已经合入");
      if (!value.ok) assert.match(value.message, /没法确认这次合并落在了 main 上/);
      assert.equal(git(s.repo, "rev-parse", "main"), s.main);
    }
    for (const c of cases.filter((c) => c.commit)) {
      const s = await stage(`${c.name}-unrelated`, c.diverge);
      const value = await aroundMerge(`${c.name}-unrelated`, shell(s.repo, "switch", "-q", "side"),
        `c=$(${shell(s.repo, "commit-tree", "main^{tree}", "-p", "main", "-m", "unrelated")}) && ${shell(s.repo, "update-ref", "refs/heads/main", '"$c"')}`,
        () => mergeTaskBranch(s.repo, s.taskId, "main", c.strategy), c.strategy === "squash" ? "commit" : "merge");
      const what = `${c.name}（main 同时多了无关提交）`;
      assert.equal(git(s.repo, "log", "-1", "--format=%s", "main"), "unrelated", `${what}：前提 —— main 动了`);
      assert.equal(value.ok, false, `${what}：main 动了但没收到合并，不算成功`);
      if (!value.ok) assert.match(value.message, /没法确认这次合并落在了 main 上/, what);
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

    console.log("accept checkout race: 核完再切走什么都不动 / 合并前被切走如实报落在哪 / 无竞态照常落地 / 冲突照旧交回 / 合完再切走照常成功 / 成功只认实证 / 钩子在项目目录 全部通过");
  }
} finally {
  await removeTmpStage(root);
}

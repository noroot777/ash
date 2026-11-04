// 合并预览档「快照忠实代表合进去之后那份」与「最终落下的就是测过的那份」的回归（第 4 轮审查）。
// 样本与驱动和 test-accept-gate-baseline.ts 共用（accept-gate-baseline-fixture.ts）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { releaseTmpDb } from "./tmp-db.js";

const { baselineHarness } = await import("./accept-gate-baseline-fixture.js");
const { root, git, passesOn, acceptTask, acceptGateState, previewMerge, mergeTaskBranch, runs, taskRow, wouldRun,
  commitOnMain, fixture, settled, testedPhysical } = await baselineHarness("ash-gate-landing-");

/** 一次带全部落地约束的最终合并（像验收那样：被测的目标提交、预演出来的树、测过的物理内容）。 */
const landGuarded = async (sample: { repo: string; cwd: string; taskId: string }, afterTest?: () => void,
  extra: { commit?: boolean } = {}) => {
  const tested = git(sample.repo, "rev-parse", "main");
  const source = git(sample.cwd, "rev-parse", "HEAD");
  const merged = await previewMerge(sample.repo, tested, source);
  assert.ok("tree" in merged, JSON.stringify(merged));
  const expectedTree = "tree" in merged ? merged.tree : "";
  const expectedPhysical = await testedPhysical(sample.repo, tested, expectedTree);
  afterTest?.();
  return { tested, expectedTree, landed: await mergeTaskBranch(sample.repo, sample.taskId, "main", "safe",
    { sourceCommit: source, expectedTree, expectedTarget: tested, expectedPhysical, ...extra }) };
};

// 只在最终合并那一下生效的 git 包装：命令行里出现 `trigger` 时先（或后）跑一段 shell，只跑一次。
const wrapGit = (name: string, trigger: string, script: string, after = false) => {
  const bin = join(root, `${name}-bin`);
  mkdirSync(bin);
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const once = join(bin, "fired");
  const hook = `[ -e '${once}' ] || { touch '${once}'; ${script.replaceAll("GIT", `'${realGit}'`)}; }`;
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *"${trigger}"*) `
    + (after ? `'${realGit}' "$@"; rc=$?; ${hook}; exit $rc ;; esac\n` : `${hook} ;; esac\n`)
    + `exec '${realGit}' "$@"\n`, { mode: 0o755 });
  return bin;
};
const withPath = async <T>(bin: string, run: (arm: () => void) => Promise<T>) => {
  const path = process.env.PATH;
  try { return await run(() => { process.env.PATH = `${bin}:${path}`; }); } finally { process.env.PATH = path; }
};

const refusedBeforeGate = async (sample: { taskId: string; projectId: string }, pattern: RegExp) => {
  assert.match((await acceptGateState(sample.taskId)).baselineBlock ?? "", pattern);
  assert.equal(await wouldRun(sample), false);
  const refused = await acceptTask(sample.taskId);
  assert.equal(refused.accepted, false);
  if (!refused.accepted) assert.equal(refused.reason, "accept_gate_preview_unavailable");
  assert.equal((await runs(sample.taskId)).length, 0);
};

try {
  // ㉖ 主检出 core.symlinks=false（F1）：链接在那里检出成写着目标路径的普通文件。快照照同一份语义检出，
  // 门禁读到的与合进去之后读到的是同一份 —— 这里两边都红，而不是「快照绿、合进去红」。
  {
    const sample = await fixture("preview-symlinks-off", { baseline: "merge_preview" });
    writeFileSync(join(sample.repo, "payload.txt"), "OK\n");
    symlinkSync("payload.txt", join(sample.repo, "alias"));
    writeFileSync(join(sample.repo, "use-alias.js"),
      "if (require('node:fs').readFileSync(__dirname + '/alias', 'utf8') !== 'OK\\n') throw new Error('alias is not a link');\n");
    git(sample.repo, "add", "-A");
    git(sample.repo, "commit", "-m", "main adds a link read by the check");
    git(sample.cwd, "merge", "--no-edit", "main");
    git(sample.repo, "config", "core.symlinks", "false");
    rmSync(join(sample.repo, "alias"));
    git(sample.repo, "checkout", "--", "alias");
    commitOnMain(sample.repo, "later.txt", "later\n", "main moves on");
    assert.equal((await acceptGateState(sample.taskId)).baselineBlock, null);
    await acceptTask(sample.taskId);
    await settled(sample.taskId);
    const [row] = await runs(sample.taskId);
    assert.equal(row!.status, "failed", "快照里的 alias 也是普通文件，同一条命令同样红");
    assert.notEqual((await taskRow(sample.taskId)).stage, "accepted");
    assert.equal(passesOn(sample.repo), false);
    git(sample.repo, "config", "--unset", "core.symlinks");
  }

  // ㉗ 主检出与任务工作区的换行配置不同（extensions.worktreeConfig，F3）：快照照目标检出（主检出）那份
  // 建，凭据与下一次判定是同一份 —— 绿了一次就验收完，不会无休止地重跑。
  {
    const sample = await fixture("preview-worktree-config", { baseline: "merge_preview" });
    git(sample.repo, "config", "extensions.worktreeConfig", "true");
    git(sample.repo, "config", "core.autocrlf", "false");
    git(sample.cwd, "config", "--worktree", "core.autocrlf", "true");
    await acceptTask(sample.taskId);
    await settled(sample.taskId);
    await settled(sample.taskId);
    const all = await runs(sample.taskId);
    assert.equal(all.length, 1, JSON.stringify(all.map(row => row.status)));
    assert.equal(all[0]!.status, "passed", all[0]!.failure ?? "");
    assert.equal((await taskRow(sample.taskId)).stage, "accepted");
  }

  // ㉘ 最终合并 · 门禁核对之后目标分支被另一个终端挪回了任务分支的祖先（F2）：原本三方合并的变成快进，
  // 落下的不是测过的那棵。带着被测的目标提交与树的落地一律拒，目标分支不动；没动过时照常合进测过的那棵。
  {
    const sample = await fixture("landing-target-moved", { baseline: "merge_preview" });
    const tested = git(sample.repo, "rev-parse", "main");
    const source = git(sample.cwd, "rev-parse", "HEAD");
    const merged = await previewMerge(sample.repo, tested, source);
    assert.ok("tree" in merged, JSON.stringify(merged));
    const expectedTree = "tree" in merged ? merged.tree : "";
    git(sample.repo, "reset", "--hard", "HEAD~1");
    const moved = git(sample.repo, "rev-parse", "main");
    const refused = await mergeTaskBranch(sample.repo, sample.taskId, "main", "safe",
      { sourceCommit: source, expectedTree, expectedTarget: tested });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.message, /在门禁测过之后动了/);
    assert.equal(git(sample.repo, "rev-parse", "main"), moved, "目标分支没动");
    git(sample.repo, "reset", "--hard", tested);
    const landed = await mergeTaskBranch(sample.repo, sample.taskId, "main", "safe",
      { sourceCommit: source, expectedTree, expectedTarget: tested, expectedPhysical: await testedPhysical(sample.repo, tested, expectedTree) });
    assert.equal(landed.ok, true, JSON.stringify(landed));
    assert.equal(git(sample.repo, "rev-parse", "main^{tree}"), expectedTree);
  }

  // ㉙ 合并预览 · 依赖根经过的**父目录**链被目标分支改了指向（vendor -> links/deps，links -> pool-a 改成
  // pool-b，F4）：借进来的还是 pool-a 那份，合进去之后读的是 pool-b，门禁之前就拒。
  {
    const sample = await fixture("preview-parent-link", { baseline: "merge_preview" });
    for (const pool of ["pool-a", "pool-b"]) {
      mkdirSync(join(sample.repo, pool, "deps"), { recursive: true });
      writeFileSync(join(sample.repo, pool, "deps", "value.txt"), `${pool}\n`);
    }
    symlinkSync("pool-a", join(sample.repo, "links"));
    symlinkSync("links/deps", join(sample.repo, "vendor"));
    git(sample.repo, "add", "-A");
    git(sample.repo, "commit", "-m", "main commits vendor -> links/deps -> pool-a/deps");
    git(sample.cwd, "merge", "--no-edit", "main");
    rmSync(join(sample.repo, "links"));
    symlinkSync("pool-b", join(sample.repo, "links"));
    git(sample.repo, "add", "-A");
    git(sample.repo, "commit", "-m", "main repoints links");
    await refusedBeforeGate(sample, /依赖内容（[^）]*links/);
  }

  // ㉚ 合并预览 · 主检出开了 sparse checkout：平时只写出一部分文件，快照写整棵树，复现不了，门禁之前就拒。
  {
    const sample = await fixture("preview-sparse", { baseline: "merge_preview" });
    git(sample.repo, "config", "core.sparseCheckout", "true");
    await refusedBeforeGate(sample, /sparse checkout/);
    git(sample.repo, "config", "--unset", "core.sparseCheckout");
  }

  // ㉛ 合并预览 · 主检出改了换行设置却没重新检出（第 4 轮复审 F2）：树、配置身份都对得上，磁盘上没被
  // 这次合并改到的文件还是 LF，快照里是新写的 CRLF —— 门禁不跑，落成起不来并说清楚，不验收。
  {
    const sample = await fixture("preview-physical-drift", { baseline: "merge_preview" });
    git(sample.repo, "config", "core.autocrlf", "true");
    await acceptTask(sample.taskId);
    await settled(sample.taskId);
    const [row] = await runs(sample.taskId);
    assert.equal(row!.status, "failed");
    assert.equal(row!.failure, "spawn_failed");
    assert.match(readFileSync(row!.logPath, "utf8"), /合并预览这次没有跑[^\n]*api\.js/);
    assert.notEqual((await taskRow(sample.taskId)).stage, "accepted");
    git(sample.repo, "config", "--unset", "core.autocrlf");
  }

  // ㉜ 合并预览 · 依赖经过名字里带反斜杠的目录（POSIX 上那只是普通字符，F3）：路径照平台切分，
  // vendor -> pool\name/deps 被目标分支改指向时照样认得出来，门禁之前就拒。
  {
    const sample = await fixture("preview-backslash-dep", { baseline: "merge_preview" });
    for (const pool of ["pool\\name", "pool-b"]) {
      mkdirSync(join(sample.repo, pool, "deps"), { recursive: true });
      writeFileSync(join(sample.repo, pool, "deps", "value.txt"), `${pool}\n`);
    }
    symlinkSync("pool\\name/deps", join(sample.repo, "vendor"));
    git(sample.repo, "add", "-A");
    git(sample.repo, "commit", "-m", "main commits vendor -> pool\\name/deps");
    git(sample.cwd, "merge", "--no-edit", "main");
    rmSync(join(sample.repo, "vendor"));
    symlinkSync("pool-b/deps", join(sample.repo, "vendor"));
    git(sample.repo, "add", "-A");
    git(sample.repo, "commit", "-m", "main repoints vendor");
    await refusedBeforeGate(sample, /依赖内容/);
  }

  // ㉝ 最终合并 · 带落地约束的「合并后不提交」：暂存的正是测过的那棵，HEAD 不动、不落提交。
  {
    const sample = await fixture("landing-no-commit", { baseline: "merge_preview" });
    const tested = git(sample.repo, "rev-parse", "main");
    const source = git(sample.cwd, "rev-parse", "HEAD");
    const merged = await previewMerge(sample.repo, tested, source);
    assert.ok("tree" in merged, JSON.stringify(merged));
    const expectedTree = "tree" in merged ? merged.tree : "";
    const staged = await mergeTaskBranch(sample.repo, sample.taskId, "main", "safe",
      { sourceCommit: source, expectedTree, expectedTarget: tested, commit: false,
        expectedPhysical: await testedPhysical(sample.repo, tested, expectedTree) });
    assert.equal(staged.ok, true, JSON.stringify(staged));
    if (staged.ok) assert.equal(staged.method, "no_commit");
    assert.equal(git(sample.repo, "write-tree"), expectedTree);
    assert.equal(git(sample.repo, "rev-parse", "HEAD"), tested, "没落提交");
    git(sample.repo, "reset", "--hard", "-q");
  }

  // ㉞ 最终合并 · 目标分支哪儿都没检出（主检出 detach 了）：带旧值挪 ref，落下的是测过的那棵。
  {
    const sample = await fixture("landing-ref-only", { baseline: "merge_preview" });
    const tested = git(sample.repo, "rev-parse", "main");
    const source = git(sample.cwd, "rev-parse", "HEAD");
    const merged = await previewMerge(sample.repo, tested, source);
    assert.ok("tree" in merged, JSON.stringify(merged));
    const expectedTree = "tree" in merged ? merged.tree : "";
    git(sample.repo, "checkout", "-q", "--detach");
    const landed = await mergeTaskBranch(sample.repo, sample.taskId, "main", "safe",
      { sourceCommit: source, expectedTree, expectedTarget: tested });
    assert.equal(landed.ok, true, JSON.stringify(landed));
    assert.equal(git(sample.repo, "rev-parse", "main^{tree}"), expectedTree);
    assert.equal(git(sample.repo, "rev-parse", "main^1"), tested);
    assert.equal(git(sample.repo, "rev-parse", "HEAD"), tested, "detach 的检出没被碰");
  }

  // ㉟ 最终合并 · 项目配了 post-merge 钩子（在合并之后再改文件、再落一个提交，第 5 轮复审 F1）：受保护的
  // 发布不调用户钩子，落下的就是测过的那棵，钩子一行都没跑。
  {
    const sample = await fixture("landing-hook", { baseline: "merge_preview" });
    const marker = join(root, "hook-ran");
    writeFileSync(join(sample.repo, ".git", "hooks", "post-merge"),
      `#!/bin/sh\ntouch '${marker}'\necho UNTESTED > api.js\ngit add api.js && git commit -qm untested\n`, { mode: 0o755 });
    const { tested, expectedTree, landed } = await landGuarded(sample);
    assert.equal(landed.ok, true, JSON.stringify(landed));
    assert.equal(git(sample.repo, "rev-parse", "main^{tree}"), expectedTree);
    assert.equal(git(sample.repo, "rev-parse", "main^1"), tested);
    assert.equal(existsSync(marker), false, "受保护的发布不调用户钩子");
    rmSync(join(sample.repo, ".git", "hooks", "post-merge"));
  }

  // ㊱ 最终合并 · 分支刚挪到测过的结果、另一个终端紧跟着往目标分支提交（发布的后置条件，第 5 轮复审 F1）：
  // 不报成功，那个外部提交原样留着。外部提交由一个 git 包装在真正的 update-ref 之后插进来。
  {
    const sample = await fixture("landing-after-race", { baseline: "merge_preview" });
    const bin = join(root, "after-race-bin");
    mkdirSync(bin);
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const real = `'${realGit}' -C '${sample.repo}'`;
    writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" update-ref -m ash accept"*) '${realGit}' "$@"; rc=$?\n`
      + `  c=$(${real} commit-tree main^{tree} -p main -m external) && ${real} update-ref refs/heads/main "$c"; exit $rc ;; esac\n`
      + `exec '${realGit}' "$@"\n`, { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    let outcome: Awaited<ReturnType<typeof landGuarded>>;
    try { outcome = await landGuarded(sample); } finally { process.env.PATH = path; }
    assert.equal(outcome.landed.ok, false, JSON.stringify(outcome.landed));
    if (!outcome.landed.ok) assert.match(outcome.landed.message, /不在刚发布的测过的结果/);
    assert.equal(git(sample.repo, "log", "-1", "--format=%s", "main"), "external", "外部提交原样留着");
    assert.equal(git(sample.repo, "rev-parse", "main~1^{tree}"), outcome.expectedTree);
  }

  // ㊳ 最终合并 · 测过之后目标检出里一个这次合并不改的脚本被改成 0654（拥有者没了执行权限，第 5 轮复审
  // 第 2 轮 F1）：只记「有没有执行位」时两者是同一个值；现在按各自的读 / 执行位记，发布前就拒。
  {
    const sample = await fixture("landing-owner-exec", { baseline: "merge_preview" });
    writeFileSync(join(sample.repo, "check.sh"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
    git(sample.repo, "add", "check.sh");
    git(sample.repo, "commit", "-qm", "main adds an executable check");
    const before = git(sample.repo, "rev-parse", "main");
    const { landed } = await landGuarded(sample, () => chmodSync(join(sample.repo, "check.sh"), 0o654));
    assert.equal(landed.ok, false, JSON.stringify(landed));
    if (!landed.ok) assert.match(landed.message, /这次合并不会重写的文件/);
    assert.equal(git(sample.repo, "rev-parse", "main"), before, "目标分支没动");
  }

  // ㊴ 最终合并 · 目标分支早已包含任务分支（「已经合入」那个成功出口，第 5 轮复审第 2 轮 F1）：树对上了
  // 还要核检出里的字节与权限；没变照常算已合入，变了就不算验收通过。
  {
    const sample = await fixture("landing-already-merged", { baseline: "merge_preview" });
    git(sample.repo, "merge", "--no-edit", "-q", git(sample.cwd, "rev-parse", "HEAD"));
    const tested = git(sample.repo, "rev-parse", "main");
    const expectedTree = git(sample.repo, "rev-parse", "main^{tree}");
    const options = { sourceCommit: git(sample.cwd, "rev-parse", "HEAD"), expectedTree, expectedTarget: tested,
      expectedPhysical: await testedPhysical(sample.repo, tested, expectedTree) };
    const same = await mergeTaskBranch(sample.repo, sample.taskId, "main", "safe", options);
    assert.equal(same.ok && same.method, "already_merged", JSON.stringify(same));
    chmodSync(join(sample.repo, "use-b.js"), 0o600);
    const drifted = await mergeTaskBranch(sample.repo, sample.taskId, "main", "safe", options);
    assert.equal(drifted.ok, false, JSON.stringify(drifted));
    if (!drifted.ok) assert.match(drifted.message, /已经包含任务分支、树也是测过的那棵，但/);
  }

  // ㊵ 最终合并 · 门禁核对之后另一个窗口给仓库配了过滤器（树里早有 `*.txt filter=late`，那时没定义驱动，
  // 第 5 轮复审第 2 轮 F2）：最终发布在封好的环境里写文件，仓库此刻的配置一项都不读 —— 那段程序一次都
  // 没跑，写出来的就是测过的那份字节。
  {
    const sample = await fixture("landing-late-filter", { baseline: "merge_preview" });
    writeFileSync(join(sample.repo, ".gitattributes"), "*.txt filter=late\n");
    git(sample.repo, "add", ".gitattributes");
    git(sample.repo, "commit", "-qm", "main tags txt files with a filter that has no driver yet");
    writeFileSync(join(sample.cwd, "added.txt"), "added\n");
    git(sample.cwd, "add", "added.txt");
    git(sample.cwd, "commit", "-qm", "task adds a txt file");
    const marker = join(root, "late-filter-ran");
    const { landed, expectedTree } = await landGuarded(sample, () => {
      for (const side of ["smudge", "clean"]) git(sample.repo, "config", `filter.late.${side}`, `touch '${marker}'; cat`);
    });
    assert.equal(landed.ok, true, JSON.stringify(landed));
    assert.equal(existsSync(marker), false, "核对之后才配的过滤器一次都没跑");
    assert.equal(git(sample.repo, "rev-parse", "main^{tree}"), expectedTree);
    assert.equal(readFileSync(join(sample.repo, "added.txt"), "utf8"), "added\n");
    git(sample.repo, "config", "--remove-section", "filter.late");
  }

  // ㊶ 最终合并 · 写文件写到一半失败（第 6 轮审查 F1：写的时候一个目录没有写权限，`a.txt` 已经写成新的、
  // `locked/z.txt` 写不进去）。不放回、不删任何东西（用户 2026-11-04 拍板，git-accept-publish.ts 文件头），
  // 回执照实说检出现在的样子：提交那一档分支已经挪了、索引换成测过那棵，`git status` 显示的正是没写成的
  // 那个，`git checkout HEAD -- <它>` 补齐；不提交那一档分支和索引都没动，交付已经写下的那些。
  for (const commit of [true, false]) {
    const sample = await fixture(`landing-partial-write-${commit ? "commit" : "stage"}`, { baseline: "merge_preview" });
    mkdirSync(join(sample.repo, "locked"));
    for (const file of ["a.txt", "locked/z.txt", "locked/gone.txt"]) writeFileSync(join(sample.repo, file), "old\n");
    git(sample.repo, "add", "a.txt", "locked");
    git(sample.repo, "commit", "-qm", "main adds three files");
    git(sample.cwd, "merge", "-q", "--no-edit", "main");
    for (const file of ["a.txt", "locked/z.txt"]) writeFileSync(join(sample.cwd, file), "new\n");
    git(sample.cwd, "rm", "-q", "locked/gone.txt");
    git(sample.cwd, "commit", "-qam", "task rewrites two and deletes one");
    const before = git(sample.repo, "rev-parse", "main");
    // 核对（含目录能不能写）和两树合并的演练（`read-tree -n`）都过了之后、真正写文件的那一刻才把目录锁上。
    const bin = wrapGit(`partial-write-${commit}`, " read-tree -m -u ", `chmod 555 '${join(sample.repo, "locked")}'`);
    let outcome: Awaited<ReturnType<typeof landGuarded>>;
    try {
      outcome = await withPath(bin, arm => landGuarded(sample, arm, { commit }));
    } finally { chmodSync(join(sample.repo, "locked"), 0o755); }
    assert.ok(existsSync(join(bin, "fired")), "目录真的在写的那一刻锁上了");
    assert.equal(outcome.landed.ok, false, JSON.stringify(outcome.landed));
    const message = outcome.landed.ok ? "" : outcome.landed.message;
    assert.match(message, /写进 [^]*时失败了[^]*没有自动放回、也没有删任何东西/);
    assert.equal(readFileSync(join(sample.repo, "a.txt"), "utf8"), "new\n", "已经写下的留着");
    assert.equal(readFileSync(join(sample.repo, "locked/z.txt"), "utf8"), "old\n");
    // 该删的 `locked/gone.txt` 也没删成：测过的那棵里没有它，它成了未跟踪文件，checkout 取不到，回执要说手动删
    // （第 6 轮审查第 6 轮 N1）。照回执一步步做，检出就干净了。
    if (commit) {
      assert.match(message, /已经挪到测过的结果[^]*索引已经是测过的那棵。还有 2 个不是测过的那份 —— 还是合并之前那份的：locked\/gone\.txt、locked\/z\.txt。/);
      assert.match(message, /用 `git checkout HEAD -- <路径>` 取回 locked\/z\.txt，核对后手动删掉 locked\/gone\.txt（测过的那棵里没有它们）/);
      assert.notEqual(git(sample.repo, "rev-parse", "main"), before, "分支已经挪了");
      assert.equal(git(sample.repo, "rev-parse", "main^{tree}"), outcome.expectedTree, "挪到的是测过的那棵");
      assert.equal(git(sample.repo, "write-tree"), outcome.expectedTree, "索引换成了测过的那棵");
      assert.equal(git(sample.repo, "status", "--porcelain"), "M locked/z.txt\n?? locked/gone.txt", "git status 显示的正是没写成的那些");
      git(sample.repo, "checkout", "HEAD", "--", "locked/z.txt");
      rmSync(join(sample.repo, "locked/gone.txt"));
    } else {
      assert.match(message, /目标分支和索引都没动。动过的有 2 个 —— 已经是测过那份的：a\.txt、use-b\.js。/);
      assert.match(message, /用 `git checkout HEAD -- <路径>` 取回 a\.txt，核对后手动删掉 use-b\.js（合并之前没有它们）/);
      assert.equal(git(sample.repo, "rev-parse", "main"), before, "目标分支没动");
      assert.equal(git(sample.repo, "status", "--porcelain"), "M a.txt\n?? use-b.js", "索引没动，git status 显示的正是动过的那些");
      git(sample.repo, "checkout", "HEAD", "--", "a.txt");
      rmSync(join(sample.repo, "use-b.js"));
    }
    assert.equal(git(sample.repo, "status", "--porcelain"), "", "照回执收拾之后就干净了");
  }

  // ㊿ 最终合并 · 核过「工作区干净」之后，另一个终端在这次合并要新增的路径上放了一个未跟踪文件：两树合并
  // 在挪分支之前先演一遍（`read-tree -n`），git 在演的时候就拒 —— 分支没挪、那个文件原样留着，用不着放回。
  {
    const sample = await fixture("landing-dry-run", { baseline: "merge_preview" });
    const before = git(sample.repo, "rev-parse", "main");
    const theirs = join(sample.repo, "use-b.js");
    // 插在最后一道「未跟踪文件」查询**之后**：那道核对看不到它，只剩两树合并自己的核对。
    const bin = wrapGit("dry-run", " ls-files --others ", `printf 'their draft\\n' > '${theirs}'`, true);
    const { landed } = await withPath(bin, arm => landGuarded(sample, arm));
    assert.ok(existsSync(join(bin, "fired")), "未跟踪文件真的在核对之后出现了");
    assert.equal(landed.ok, false, JSON.stringify(landed));
    if (!landed.ok) assert.match(landed.message, /would be overwritten[^]*失败在写任何文件之前：目标分支没动/);
    assert.equal(git(sample.repo, "rev-parse", "main"), before, "目标分支没动");
    assert.equal(readFileSync(theirs, "utf8"), "their draft\n", "别人的文件原样留着");
    rmSync(theirs);
    assert.equal(git(sample.repo, "status", "--porcelain"), "");
  }

  // (52) 最终合并 · 写的那一刻一个目录成了 0600（进不去），里面的文件读不了：核不出来，不能当成「不在了」
  // 或「还是原样」，要单独列出来（第 6 轮审查第 6 轮 F1 同类）。照回执收拾就干净了。
  {
    const sample = await fixture("landing-unreadable", { baseline: "merge_preview" });
    mkdirSync(join(sample.repo, "locked"));
    for (const file of ["locked/z.txt", "locked/gone.txt"]) writeFileSync(join(sample.repo, file), "old\n");
    git(sample.repo, "add", "locked");
    git(sample.repo, "commit", "-qm", "main adds two files");
    git(sample.cwd, "merge", "-q", "--no-edit", "main");
    writeFileSync(join(sample.cwd, "locked/z.txt"), "new\n");
    git(sample.cwd, "rm", "-q", "locked/gone.txt");
    git(sample.cwd, "commit", "-qam", "task rewrites one and deletes one");
    const bin = wrapGit("unreadable", " read-tree -m -u ", `chmod 600 '${join(sample.repo, "locked")}'`);
    let outcome: Awaited<ReturnType<typeof landGuarded>>;
    try {
      outcome = await withPath(bin, arm => landGuarded(sample, arm));
    } finally { chmodSync(join(sample.repo, "locked"), 0o755); }
    assert.equal(outcome.landed.ok, false, JSON.stringify(outcome.landed));
    const message = outcome.landed.ok ? "" : outcome.landed.message;
    assert.match(message, /读不了、核不出来的：locked\/gone\.txt、locked\/z\.txt/);
    assert.doesNotMatch(message, /都已经是测过的那份/);
    const fetch = /取回 ([^，。（]+)/.exec(message)?.[1]?.split("、") ?? [];
    const drop = /手动删掉 ([^（]+)（/.exec(message)?.[1]?.split("、") ?? [];
    git(sample.repo, "checkout", "HEAD", "--", ...fetch);
    for (const path of drop) rmSync(join(sample.repo, path), { force: true });
    assert.equal(git(sample.repo, "status", "--porcelain"), "", "照回执收拾之后就干净了");
  }

  // (51) 最终合并 · 写文件的那条 git 被文件大小上限截断（第 6 轮审查第 6 轮 F1：文件只写了一半，回执却说
  // 「一个都还没写」）。每个路径对照合并之前和测过的两份分开报，写了一半的单独列出来；照回执收拾就干净了。
  for (const commit of [true, false]) {
    const sample = await fixture(`landing-truncated-${commit ? "commit" : "stage"}`, { baseline: "merge_preview" });
    const large = join(sample.repo, "large.txt");
    writeFileSync(large, "original\n");
    git(sample.repo, "add", "large.txt");
    git(sample.repo, "commit", "-qm", "main adds a file");
    git(sample.cwd, "merge", "-q", "--no-edit", "main");
    const tested = "tested content\n".repeat(4000);
    writeFileSync(join(sample.cwd, "large.txt"), tested);
    git(sample.cwd, "commit", "-qam", "task grows the file");
    const bin = wrapGit(`truncated-${commit}`, " read-tree -m -u ", "ulimit -f 1");
    const outcome = await withPath(bin, arm => landGuarded(sample, arm, { commit }));
    assert.ok(existsSync(join(bin, "fired")), "写文件那一下真的受了大小上限");
    assert.equal(outcome.landed.ok, false, JSON.stringify(outcome.landed));
    const message = outcome.landed.ok ? "" : outcome.landed.message;
    const now = readFileSync(large, "utf8");
    assert.ok(now !== "original\n" && now !== tested, `真的写了一半（${now.length} 字节）`);
    assert.match(message, /写了一半（既不是原来那份也不是测过那份）的：large\.txt/);
    assert.doesNotMatch(message, /都还是合并之前那份|都已经是测过的那份/);
    const fetch = /取回 ([^，。（]+)/.exec(message)?.[1]?.split("、") ?? [];
    const drop = /手动删掉 ([^（]+)（/.exec(message)?.[1]?.split("、") ?? [];
    assert.ok(fetch.includes("large.txt"), message);
    // 照回执一条条做：取回的 checkout、该删的删掉。
    git(sample.repo, "checkout", "HEAD", "--", ...fetch);
    for (const path of drop) rmSync(join(sample.repo, path));
    assert.equal(readFileSync(large, "utf8"), commit ? tested : "original\n", "照回执取回的是该有的那份");
    assert.equal(git(sample.repo, "status", "--porcelain"), "", "照回执收拾之后就干净了");
  }

  // ㊼ 合并预览 · 目标分支把一个普通目录 `src` 换成指向 `alternate` 的链（第 6 轮审查第 3 轮 F1）：任务
  // 工作区里装着的 `src/vendor` 借进快照后落在链的新位置上，合进去之后那里根本没有它。改的是借用读取
  // 路径的**祖先**，同样算目标分支改了借用的依赖，门禁之前就拒。
  {
    const sample = await fixture("preview-dep-parent", { baseline: "merge_preview" });
    writeFileSync(join(sample.repo, ".gitignore"), ".worktrees/\nvendor/\n");
    for (const dir of ["src", "alternate"]) mkdirSync(join(sample.repo, dir));
    writeFileSync(join(sample.repo, "src", "go.mod"), "module sample\n");
    writeFileSync(join(sample.repo, "alternate", "marker.txt"), "alternate\n");
    git(sample.repo, "add", "-A");
    git(sample.repo, "commit", "-qm", "main adds a go module");
    git(sample.cwd, "merge", "-q", "--no-edit", "main");
    mkdirSync(join(sample.cwd, "src", "vendor"));
    writeFileSync(join(sample.cwd, "src", "vendor", "lib.txt"), "installed\n");
    git(sample.repo, "rm", "-rq", "src");
    symlinkSync("alternate", join(sample.repo, "src"));
    git(sample.repo, "add", "src");
    git(sample.repo, "commit", "-qm", "main replaces src with a link");
    await refusedBeforeGate(sample, /依赖内容（[^）]*src\/vendor/);
  }

  // ㊽ 最终合并 · 测过之后目标检出里一个这次合并不碰的脚本被加了「禁止执行」的访问控制（第 6 轮审查
  // 第 3 轮 F2，macOS ACL）：权限位一个没变，但跑不起来了 —— 物理身份记实际能不能执行，发布前就拒。
  if (process.platform === "darwin") {
    const sample = await fixture("landing-acl-exec", { baseline: "merge_preview" });
    writeFileSync(join(sample.repo, "check.sh"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
    git(sample.repo, "add", "check.sh");
    git(sample.repo, "commit", "-qm", "main adds an executable check");
    const before = git(sample.repo, "rev-parse", "main");
    const script = join(sample.repo, "check.sh");
    const { landed } = await landGuarded(sample, () => execFileSync("chmod", ["+a", `user:${userInfo().username} deny execute`, script]));
    assert.equal(landed.ok, false, JSON.stringify(landed));
    if (!landed.ok) assert.match(landed.message, /这次合并不会重写的文件/);
    assert.equal(git(sample.repo, "rev-parse", "main"), before, "目标分支没动");
    execFileSync("chmod", ["-N", script]);
  }

  // ㊾ 最终合并 · 挪分支时被拒（另一个终端抢先提交，第 6 轮审查第 3 轮 F3）：挪分支在写任何文件之前，
  // 被拒就一个文件都没写 —— 原先禁止执行的访问控制还在（macOS）、也没有新建目录，什么都不用放回。
  {
    const sample = await fixture("landing-restore-whole", { baseline: "merge_preview" });
    const tool = join(sample.repo, "tool.sh");
    writeFileSync(tool, "#!/bin/sh\necho base\n", { mode: 0o755 });
    git(sample.repo, "add", "tool.sh");
    git(sample.repo, "commit", "-qm", "main adds a tool");
    git(sample.cwd, "merge", "-q", "--no-edit", "main");
    writeFileSync(join(sample.cwd, "tool.sh"), "#!/bin/sh\necho task\n");
    mkdirSync(join(sample.cwd, "created"));
    writeFileSync(join(sample.cwd, "created", "new.txt"), "new\n");
    git(sample.cwd, "add", "-A");
    git(sample.cwd, "commit", "-qm", "task edits the tool and adds a directory");
    const acl = process.platform === "darwin";
    if (acl) execFileSync("chmod", ["+a", `user:${userInfo().username} deny execute`, tool]);
    const real = `GIT -C '${sample.repo}'`;
    const bin = wrapGit("restore-whole", " update-ref -m ash accept",
      `c=$(${real} commit-tree main^{tree} -p main -m external) && ${real} update-ref refs/heads/main "$c"`);
    const { landed } = await withPath(bin, arm => landGuarded(sample, arm));
    assert.equal(landed.ok, false, JSON.stringify(landed));
    if (!landed.ok) assert.match(landed.message, /在门禁测过之后动了[^]*检出里的文件也一个都没动/);
    assert.equal(readFileSync(tool, "utf8"), "#!/bin/sh\necho base\n");
    assert.equal(existsSync(join(sample.repo, "created")), false, "没有新建目录");
    if (acl) {
      assert.match(execFileSync("ls", ["-le", tool], { encoding: "utf8" }), /deny execute/, "访问控制还在");
      assert.throws(() => execFileSync(tool), /EACCES/, "原先跑不起来的照样跑不起来");
      execFileSync("chmod", ["-N", tool]);
    }
  }

  // ㊷ 最终合并 · 测过之后目标检出里一个这次合并不碰的源码目录改成 0111（第 6 轮审查 F1）：文件照样按路径
  // 读得到，目录却列不出来 —— 物理身份连目录能不能读 / 进一起记，发布前就拒。
  {
    const sample = await fixture("landing-dir-access", { baseline: "merge_preview" });
    mkdirSync(join(sample.repo, "restricted"));
    writeFileSync(join(sample.repo, "restricted", "kept.js"), "module.exports = 1;\n");
    git(sample.repo, "add", "restricted");
    git(sample.repo, "commit", "-qm", "main adds a source directory");
    const before = git(sample.repo, "rev-parse", "main");
    let outcome: Awaited<ReturnType<typeof landGuarded>>;
    try {
      outcome = await landGuarded(sample, () => chmodSync(join(sample.repo, "restricted"), 0o111));
    } finally { chmodSync(join(sample.repo, "restricted"), 0o755); }
    assert.equal(outcome.landed.ok, false, JSON.stringify(outcome.landed));
    if (!outcome.landed.ok) assert.match(outcome.landed.message, /这次合并不会重写的文件/);
    assert.equal(git(sample.repo, "rev-parse", "main"), before, "目标分支没动");
  }

  // ㊸ 最终合并 · 「工作区干净」核过之后、拿到索引锁之前，另一个终端 `git add` 了一份改动、再把文件改回
  // 原样（第 6 轮审查 F2）：工作区与物理摘要都看不出来，但换上测过的索引会抹掉那份暂存 —— 持锁后核真实
  // 索引，对不上就拒，那份暂存原样留着。包装在最后一道「未跟踪文件」查询那一刻插进这次暂存。
  {
    const sample = await fixture("landing-index-race", { baseline: "merge_preview" });
    writeFileSync(join(sample.repo, "other.txt"), "old\n");
    git(sample.repo, "add", "other.txt");
    git(sample.repo, "commit", "-qm", "main adds other.txt");
    const before = git(sample.repo, "rev-parse", "main");
    const file = join(sample.repo, "other.txt");
    const bin = wrapGit("index-race", " ls-files --others ",
      `printf 'user-staged-only\\n' > '${file}' && GIT -C '${sample.repo}' add other.txt && printf 'old\\n' > '${file}'`);
    const { landed } = await withPath(bin, arm => landGuarded(sample, arm));
    assert.ok(existsSync(join(bin, "fired")), "暂存真的插进去了");
    assert.equal(landed.ok, false, JSON.stringify(landed));
    if (!landed.ok) assert.match(landed.message, /暂存区在核对之后有了别的内容（other\.txt）[^]*目标分支没动/);
    assert.equal(git(sample.repo, "rev-parse", "main"), before, "目标分支没动");
    assert.equal(git(sample.repo, "show", ":other.txt"), "user-staged-only", "那份暂存原样留着");
    assert.equal(readFileSync(file, "utf8"), "old\n");
    git(sample.repo, "reset", "-q");
  }

  // ㊹ 最终合并 · 分支已经挪到测过的结果、文件也写下了，之后清理临时发布目录失败（第 6 轮审查 F3）：清理
  // 是发布之后的事，它失败不能把回执改成「目标分支没动」—— 照常算合进去了。包装在真正写文件的那条
  // `read-tree -m -u` 之后把那个临时目录改成 0555，删它时就是真实的 EACCES。
  {
    const sample = await fixture("landing-cleanup-after-publish", { baseline: "merge_preview" });
    const stuck = join(root, "stuck-publish-dir");
    const bin = wrapGit("cleanup-after", " read-tree -m -u ",
      `d=$(ls -dt "\${TMPDIR:-/tmp}"/ash-publish-* | head -n 1) && printf '%s' "$d" > '${stuck}' && chmod 555 "$d"`, true);
    const { landed, expectedTree } = await withPath(bin, arm => landGuarded(sample, arm));
    assert.ok(existsSync(stuck), "临时发布目录真的锁住了");
    const dir = readFileSync(stuck, "utf8");
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
    assert.equal(landed.ok, true, JSON.stringify(landed));
    assert.equal(git(sample.repo, "rev-parse", "main^{tree}"), expectedTree, "测过的那棵落下了");
    assert.equal(git(sample.repo, "status", "--porcelain"), "");
  }

  // ㊺ 最终合并 · 测过之后一个这次合并不碰的源码目录改成 0555（第 6 轮审查第 2 轮 F1）：能读能进、不能写，
  // 快照里构建往里写缓存成功、合进去之后同一条命令报 EACCES —— 物理身份也记能不能写，发布前就拒。
  {
    const sample = await fixture("landing-dir-write", { baseline: "merge_preview" });
    mkdirSync(join(sample.repo, "build-inputs"));
    writeFileSync(join(sample.repo, "build-inputs", "entry.js"), "module.exports = 1;\n");
    git(sample.repo, "add", "build-inputs");
    git(sample.repo, "commit", "-qm", "main adds build inputs");
    const before = git(sample.repo, "rev-parse", "main");
    let outcome: Awaited<ReturnType<typeof landGuarded>>;
    try {
      outcome = await landGuarded(sample, () => chmodSync(join(sample.repo, "build-inputs"), 0o555));
    } finally { chmodSync(join(sample.repo, "build-inputs"), 0o755); }
    assert.equal(outcome.landed.ok, false, JSON.stringify(outcome.landed));
    if (!outcome.landed.ok) assert.match(outcome.landed.message, /这次合并不会重写的文件/);
    assert.equal(git(sample.repo, "rev-parse", "main"), before, "目标分支没动");
  }

  // ㊻ 最终合并 · 目标检出开了拆分索引（第 6 轮审查第 2 轮 F2）：主索引文件靠扩展引用旁边的共享索引，
  // 持锁后读真实索引时连它一起拷 —— 干净的检出照常合进去，不被当成「暂存区多了东西」。
  {
    const sample = await fixture("landing-split-index", { baseline: "merge_preview" });
    const { landed, expectedTree } = await landGuarded(sample, () => {
      git(sample.repo, "update-index", "--split-index");
      assert.notEqual(git(sample.repo, "rev-parse", "--shared-index-path"), "");
    });
    assert.equal(landed.ok, true, JSON.stringify(landed));
    assert.equal(git(sample.repo, "rev-parse", "main^{tree}"), expectedTree);
    assert.equal(git(sample.repo, "status", "--porcelain"), "");
  }

  // ㊲ 合并预览 · 门禁跑着的时候，目标检出里一个这次合并不改的文件被存成另一种换行再暂存（第 5 轮
  // 复审 F2）：树、配置、`git status` 都没变，但字节不是测过的那份 —— 旧绿不拿来合，验收不通过。
  {
    const sample = await fixture("preview-drift-during-gate", { baseline: "merge_preview", delay: 500 });
    git(sample.repo, "config", "core.autocrlf", "true");
    git(sample.repo, "rm", "--cached", "-r", "-q", ".");
    git(sample.repo, "reset", "--hard", "-q");
    assert.match(readFileSync(join(sample.repo, "api.js"), "utf8"), /\r\n$/);
    const before = git(sample.repo, "rev-parse", "main");
    await acceptTask(sample.taskId);
    writeFileSync(join(sample.repo, "api.js"), "exports.onDelivered = () => 'ok';\n");
    git(sample.repo, "add", "api.js");
    assert.equal(git(sample.repo, "status", "--porcelain"), "");
    await settled(sample.taskId);
    await settled(sample.taskId, (await runs(sample.taskId)).length);
    const all = await runs(sample.taskId);
    assert.equal(all[0]!.status, "passed", "快照里那份照样绿");
    assert.notEqual((await taskRow(sample.taskId)).stage, "accepted", JSON.stringify(all.map(row => row.status)));
    assert.equal(git(sample.repo, "rev-parse", "main"), before, "没有合并");
    assert.equal((await acceptGateState(sample.taskId)).latest?.stale ?? true, true);
    assert.equal(await wouldRun(sample), true);
    git(sample.repo, "config", "--unset", "core.autocrlf");
  }

  console.log(JSON.stringify({ symlinksOff: true, worktreeConfig: true, targetMoved: true, parentLink: true, sparse: true,
    physicalDrift: true, backslashDep: true, guardedNoCommit: true, refOnly: true,
    hookSkipped: true, afterRace: true, driftDuringGate: true, ownerExec: true, alreadyMerged: true, lateFilter: true, partialWrite: true,
    dirAccess: true, indexRace: true, cleanupAfterPublish: true, dirWrite: true, splitIndex: true,
    depParent: true, aclExec: true, refusedUntouched: true, dryRun: true, truncated: true, unreadable: true }));
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}

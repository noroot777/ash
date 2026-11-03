// 合并预览档「快照忠实代表合进去之后那份」与「最终落下的就是测过的那份」的回归（第 4 轮审查）。
// 样本与驱动和 test-accept-gate-baseline.ts 共用（accept-gate-baseline-fixture.ts）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { releaseTmpDb } from "./tmp-db.js";

const { baselineHarness } = await import("./accept-gate-baseline-fixture.js");
const { root, git, passesOn, acceptTask, acceptGateState, previewMerge, mergeTaskBranch, runs, taskRow, wouldRun,
  commitOnMain, fixture, settled, testedPhysical } = await baselineHarness("ash-gate-landing-");

/** 一次带全部落地约束的最终合并（像验收那样：被测的目标提交、预演出来的树、测过的物理内容）。 */
const landGuarded = async (sample: { repo: string; cwd: string; taskId: string }, afterTest?: () => void) => {
  const tested = git(sample.repo, "rev-parse", "main");
  const source = git(sample.cwd, "rev-parse", "HEAD");
  const merged = await previewMerge(sample.repo, tested, source);
  assert.ok("tree" in merged, JSON.stringify(merged));
  const expectedTree = "tree" in merged ? merged.tree : "";
  const expectedPhysical = await testedPhysical(sample.repo, tested, expectedTree);
  afterTest?.();
  return { tested, expectedTree, landed: await mergeTaskBranch(sample.repo, sample.taskId, "main", "safe",
    { sourceCommit: source, expectedTree, expectedTarget: tested, expectedPhysical }) };
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
    hookSkipped: true, afterRace: true, driftDuringGate: true, ownerExec: true, alreadyMerged: true, lateFilter: true }));
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}

// 合并预览档「快照忠实代表合进去之后那份」与「最终落下的就是测过的那份」的回归（第 4 轮审查）。
// 样本与驱动和 test-accept-gate-baseline.ts 共用（accept-gate-baseline-fixture.ts）。
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { releaseTmpDb } from "./tmp-db.js";

const { baselineHarness } = await import("./accept-gate-baseline-fixture.js");
const { root, git, passesOn, acceptTask, acceptGateState, previewMerge, mergeTaskBranch, runs, taskRow, wouldRun,
  commitOnMain, fixture, settled } = await baselineHarness("ash-gate-landing-");

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
      { sourceCommit: source, expectedTree, expectedTarget: tested });
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

  console.log(JSON.stringify({ symlinksOff: true, worktreeConfig: true, targetMoved: true, parentLink: true, sparse: true }));
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}

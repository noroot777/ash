// 审查结论的「内容锚点」回归：工作区内容指纹，以及「部分驳回 → 用户维持意见」之后修复照常放行。
//
// 现场（2026-11-07 EZk_VTsu4Lzb）：执行者改完不提交，审查在脏工作区上跑；它按驳回工具的要求
// 先改掉认下的 7 条、再驳剩下 1 条；用户裁定「接着改」，系统却报「审查意见针对的代码已变化」
// 拒绝发起修复——锚点只比 HEAD + 干净，这条路每一次都走不通。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-free-review-anchor-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

// 夹具仓库的 git 一律不继承外层的 GIT_* 环境（外层若在 hook / bisect 里跑，GIT_DIR 会漏进来改到别的仓库）。
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv }).trim();

function makeRepo(name: string): string {
  const repo = join(root, name);
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, ".gitignore"), "ignored.log\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  return repo;
}

let failure: unknown = null;
try {
  const { workspaceSnapshot } = await import("../src/workspace-fingerprint.js");

  // ── ① 指纹本身 ──
  const repo = makeRepo("fp");
  const clean = await workspaceSnapshot(repo);
  assert.equal(clean.dirty, false);
  assert.ok(clean.head && clean.fingerprint, "干净仓库也有指纹");
  assert.equal((await workspaceSnapshot(repo)).fingerprint, clean.fingerprint, "同一份内容指纹稳定");

  writeFileSync(join(repo, "a.txt"), "two\n");
  const edited = await workspaceSnapshot(repo);
  assert.equal(edited.dirty, true);
  assert.notEqual(edited.fingerprint, clean.fingerprint, "改了已跟踪文件，指纹要变");
  // 内容一样、只换了 mtime：要重新算哈希，但结果不变（缓存不能让 stat 变化冒充内容变化）。
  utimesSync(join(repo, "a.txt"), new Date(2001, 1, 1), new Date(2001, 1, 1));
  assert.equal((await workspaceSnapshot(repo)).fingerprint, edited.fingerprint, "只动 mtime 不算改代码");
  // 同一个文件在缓存之后又改了内容：大小相同也必须看出来。
  writeFileSync(join(repo, "a.txt"), "tw0\n");
  const reEdited = await workspaceSnapshot(repo);
  assert.notEqual(reEdited.fingerprint, edited.fingerprint, "缓存过的文件内容再变，指纹也要变");

  writeFileSync(join(repo, "new.txt"), "x\n");
  const untracked = await workspaceSnapshot(repo);
  assert.notEqual(untracked.fingerprint, reEdited.fingerprint, "新增未跟踪文件算改动");
  writeFileSync(join(repo, "new.txt"), "y\n");
  assert.notEqual((await workspaceSnapshot(repo)).fingerprint, untracked.fingerprint, "未跟踪文件的内容也要算进去");
  rmSync(join(repo, "new.txt"));
  assert.equal((await workspaceSnapshot(repo)).fingerprint, reEdited.fingerprint, "删回去就回到原来那一版");

  // 被忽略的文件、ash 自己的 .worktrees、软链进来的 node_modules 都不是这个项目的改动。
  writeFileSync(join(repo, "ignored.log"), "noise\n");
  mkdirSync(join(repo, ".worktrees", "t1"), { recursive: true });
  writeFileSync(join(repo, ".worktrees", "t1", "f"), "x\n");
  symlinkSync(root, join(repo, "node_modules"));
  assert.equal((await workspaceSnapshot(repo)).fingerprint, reEdited.fingerprint, "与 workspaceDirty 同一套过滤口径");

  rmSync(join(repo, "a.txt"));
  assert.notEqual((await workspaceSnapshot(repo)).fingerprint, reEdited.fingerprint, "删掉已跟踪文件算改动");

  const plain = join(root, "not-git");
  mkdirSync(plain);
  assert.deepEqual(await workspaceSnapshot(plain), { head: null, dirty: null, fingerprint: null }, "不是 git 目录一律未知");

  // 保留 mtime 的等长原位改写：拿去授权的 verify 每次重读字节；显示用的缓存也靠 ctime 看得出来。
  const kept = makeRepo("kept-mtime");
  const keptFile = join(kept, "a.txt");
  const pinned = new Date(2020, 0, 1);
  writeFileSync(keptFile, "AAAA\n");
  utimesSync(keptFile, pinned, pinned);
  const keptBefore = await workspaceSnapshot(kept, { verify: true });
  assert.equal((await workspaceSnapshot(kept)).fingerprint, keptBefore.fingerprint, "缓存与重读同一份内容结果一致");
  writeFileSync(keptFile, "BBBB\n");
  utimesSync(keptFile, pinned, pinned);
  assert.notEqual((await workspaceSnapshot(kept, { verify: true })).fingerprint, keptBefore.fingerprint,
    "大小、mtime、inode 都被保持住的改写，授权用的指纹也要变");
  assert.notEqual((await workspaceSnapshot(kept)).fingerprint, keptBefore.fingerprint, "显示用的缓存靠 ctime 也要认出来");

  // 子模块里未提交的改动再变：父仓那一行一直是「M module」，指纹必须跟着里面的内容走。
  const subSource = makeRepo("sub-src");
  const parent = makeRepo("with-sub");
  git(parent, "-c", "protocol.file.allow=always", "submodule", "add", "-q", subSource, "module");
  git(parent, "commit", "-qm", "add sub");
  writeFileSync(join(parent, "module", "a.txt"), "dirty 1\n");
  const subBefore = await workspaceSnapshot(parent, { verify: true });
  assert.ok(subBefore.fingerprint, "子模块可读时有指纹");
  writeFileSync(join(parent, "module", "a.txt"), "dirty 2\n");
  assert.notEqual((await workspaceSnapshot(parent, { verify: true })).fingerprint, subBefore.fingerprint,
    "子模块里继续改代码，指纹要变");

  // 子模块丢了仓库标记（目录里的 .git 没了）：git status 一个字都不报，里面怎么改都看不见——证明不了。
  rmSync(join(parent, "module", ".git"));
  assert.equal((await workspaceSnapshot(parent, { verify: true })).fingerprint, null, "看不见的子模块内容不能算没变");
  assert.equal((await workspaceSnapshot(parent)).fingerprint, null, "显示路径同一个判据");
  // 没初始化的子模块（空目录）照常有指纹。
  rmSync(join(parent, "module"), { recursive: true });
  mkdirSync(join(parent, "module"));
  assert.ok((await workspaceSnapshot(parent, { verify: true })).fingerprint, "空的 gitlink 目录不挡指纹");

  // 未跟踪的嵌套仓库同理。
  const host = makeRepo("host");
  const nested = makeRepo("host/nested");
  writeFileSync(join(nested, "a.txt"), "nested 1\n");
  const hostBefore = await workspaceSnapshot(host, { verify: true });
  assert.ok(hostBefore.fingerprint);
  writeFileSync(join(nested, "a.txt"), "nested 2\n");
  assert.notEqual((await workspaceSnapshot(host, { verify: true })).fingerprint, hostBefore.fingerprint,
    "嵌套仓库里的改动要算进去");

  // 已跟踪文件改成同名目录：从那个目录跑 git 会找到父仓，不能当成嵌套仓库递归（曾无限递归卡死）。
  const retyped = makeRepo("retyped");
  rmSync(join(retyped, "a.txt"));
  mkdirSync(join(retyped, "a.txt"));
  writeFileSync(join(retyped, "a.txt", "child.txt"), "c1\n");
  const retypedBefore = await workspaceSnapshot(retyped, { verify: true });
  assert.ok(retypedBefore.fingerprint, "文件改目录照常出指纹，不卡住");
  assert.equal((await workspaceSnapshot(retyped)).fingerprint, retypedBefore.fingerprint, "显示路径同样能算完");
  writeFileSync(join(retyped, "a.txt", "child.txt"), "c2\n");
  assert.notEqual((await workspaceSnapshot(retyped, { verify: true })).fingerprint, retypedBefore.fingerprint,
    "目录里的文件由 status 逐个列出，内容变了指纹要变");

  // 带换行的文件名（--stdin-paths 切不开，单独算）也按内容算。Windows 文件系统根本建不出这种名字。
  if (process.platform !== "win32") {
    writeFileSync(join(host, "odd\nname.txt"), "1\n");
    const oddBefore = await workspaceSnapshot(host, { verify: true });
    assert.ok(oddBefore.fingerprint);
    writeFileSync(join(host, "odd\nname.txt"), "2\n");
    assert.notEqual((await workspaceSnapshot(host, { verify: true })).fingerprint, oddBefore.fingerprint,
      "带换行的文件名也按内容算，不按 stat");
  }

  // 读不到 ≠ 删掉了：权限挡住的文件让整份指纹变未知，不能生成一个能反复匹配的串。
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const locked = makeRepo("locked");
    mkdirSync(join(locked, "locked"));
    writeFileSync(join(locked, "locked", "a.txt"), "x\n");
    git(locked, "add", "-A");
    chmodSync(join(locked, "locked"), 0o000);
    try {
      const blocked = await workspaceSnapshot(locked, { verify: true });
      assert.equal(blocked.dirty, true, "git 仍看得见这处改动");
      assert.equal(blocked.fingerprint, null, "读不到的文件不能被当成已删除");
    } finally {
      chmodSync(join(locked, "locked"), 0o755);
    }
  }

  // ── ② 部分驳回 → 维持意见 → 修复放行 ──
  const { ensureSchema, db } = await import("../src/db/index.js");
  const { agents, freeReviewRounds, freeReviewRuns, projects, reviewerProfiles } = await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const { claimTurn } = await import("../src/runs.js");
  const { disputeFreeReview, resolveFreeReviewDispute } = await import("../src/free-review-dispute.js");
  const { freeWorkflowState, startManualFreeReviewRepair } = await import("../src/free-workflow.js");

  await ensureSchema();
  const at = new Date().toISOString();
  await db.insert(agents).values({ id: "ex", name: "codex@test", type: "codex", model: "gpt-test", isDefault: true });
  await db.insert(reviewerProfiles).values({
    id: "reviewer", name: "审查者", agentType: "codex", executorId: "ex", createdAt: at, updatedAt: at,
  });

  /** 一个任务 + 自己的仓库，工作区带着没提交的改动时被审出未通过（锚点照真实写入点的形态记）。 */
  async function seedDirtyReview(id: string): Promise<{ repo: string; runId: string; roundId: string }> {
    const repo = makeRepo(`repo-${id}`);
    writeFileSync(join(repo, "a.txt"), "uncommitted work\n");
    await db.insert(projects).values({ id: `p-${id}`, name: id, repoPath: repo, createdAt: at });
    await createTasks([{
      id, projectId: `p-${id}`, title: id, body: "test", mode: "single", status: "done",
      agentType: "codex", executorId: "ex", autoTitle: false, workflowMode: "free",
      useWorktree: false, createdAt: at, updatedAt: at,
    }]);
    const runId = `${id}-run`;
    await db.insert(freeReviewRuns).values({
      id: runId, taskId: id, reviewerId: "reviewer", reviewerName: "审查者", agentType: "codex",
      executorId: "ex", checkMode: "logic", retryLimit: 1, currentRound: 1,
      status: "stopped", createdAt: at, updatedAt: at, finishedAt: at,
    });
    const anchor = await workspaceSnapshot(repo);
    const roundId = `${runId}-round`;
    await db.insert(freeReviewRounds).values({
      id: roundId, runId, round: 1, status: "failed", conclusion: "verify_failed",
      reviewedCommit: anchor.head, reviewedFingerprint: anchor.fingerprint, startedAt: at, endedAt: at,
    });
    const reportDir = join(root, "runs", id, "free-review", runId, "round-1");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, "report.md"), "1. 并发锁缺失\n2. 将要发布没有数据来源\n");
    return { repo, runId, roundId };
  }
  const roundRow = (roundId: string) => db.select().from(freeReviewRounds)
    .where(eq(freeReviewRounds.id, roundId)).then((rows) => rows[0]!);
  // 每个任务全程占着回合：修复放行后会排一个「回合空闲就投递」的回调，回合空着它会当场
  // 起真执行器。占着它就只排队不起跑——这里要断的只是放不放行。
  const occupy = (id: string) => assert.equal(claimTurn(id, "single"), true);

  // 在脏工作区上审出来的结论，内容没变就是新鲜的：老按钮「按意见修复」直接能用。
  const fresh = await seedDirtyReview("a-fresh");
  occupy("a-fresh");
  const freshState = await freeWorkflowState("a-fresh");
  assert.ok(freshState.workspaceFingerprint, "状态快照带出当前内容指纹");
  assert.equal(freshState.reviews[0]?.rounds[0]?.reviewedFingerprint, (await roundRow(fresh.roundId)).reviewedFingerprint,
    "状态快照带出这一轮的内容锚点（前端判新鲜度用）");
  await startManualFreeReviewRepair("a-fresh");

  // 部分驳回：执行者先改掉认下的那条，再驳剩下的。
  const partial = await seedDirtyReview("a-partial");
  writeFileSync(join(partial.repo, "a.txt"), "uncommitted work + lock fix\n");
  occupy("a-partial");
  await disputeFreeReview("a-partial", { summary: "第 2 条该单开任务", reason: "", deferReason: "第 2 条要真实提交定时作品" });
  const disputed = await roundRow(partial.roundId);
  assert.ok(disputed.disputedFingerprint, "驳回那一刻的内容指纹要落库");
  assert.notEqual(disputed.disputedFingerprint, disputed.reviewedFingerprint, "部分驳回时代码必然已不同于审查那一版");
  // 回合占着，裁定里那次自动修复（holdTurn）占不到回合、如实回报；放行判据用不占回合的入口断。
  await resolveFreeReviewDispute("a-partial", "upheld", "做了吧", { runId: partial.runId, round: 1 });
  assert.equal((await roundRow(partial.roundId)).disputeResolution, "upheld");
  await startManualFreeReviewRepair("a-partial", { target: { runId: partial.runId, round: 1 } });

  // 驳回之后又有人改了代码：照旧拦下，要求再派一轮审查。
  const moved = await seedDirtyReview("a-moved");
  writeFileSync(join(moved.repo, "a.txt"), "uncommitted work + lock fix\n");
  occupy("a-moved");
  await disputeFreeReview("a-moved", { summary: "第 2 条该单开任务", reason: "", deferReason: "第 2 条要真实提交定时作品" });
  await resolveFreeReviewDispute("a-moved", "upheld", null, { runId: moved.runId, round: 1 });
  writeFileSync(join(moved.repo, "later.txt"), "someone else\n");
  await assert.rejects(
    () => startManualFreeReviewRepair("a-moved", { target: { runId: moved.runId, round: 1 } }),
    /代码已变化/, "驳回之后代码又变了，旧意见不能照发");

  // 老数据（只有 HEAD 锚点）：仍是「HEAD 相同且干净」才放行。
  const legacy = await seedDirtyReview("a-legacy");
  occupy("a-legacy");
  await db.update(freeReviewRounds).set({ reviewedFingerprint: null }).where(eq(freeReviewRounds.id, legacy.roundId));
  await assert.rejects(() => startManualFreeReviewRepair("a-legacy"), /代码已变化/, "没有内容锚点的老数据照旧口径");

  // 新审查采集失败（锚点记成 UNKNOWN_FINGERPRINT）：哪怕 HEAD 相同、工作区干净，也不能冒充老数据放行。
  const { reviewAnchorMatches, UNKNOWN_FINGERPRINT } = await import("@ash/shared/free-workflow");
  const unknown = await seedDirtyReview("a-unknown");
  occupy("a-unknown");
  git(unknown.repo, "checkout", "--", "a.txt");
  await db.update(freeReviewRounds).set({ reviewedFingerprint: UNKNOWN_FINGERPRINT })
    .where(eq(freeReviewRounds.id, unknown.roundId));
  await assert.rejects(() => startManualFreeReviewRepair("a-unknown"), /无法确认/,
    "审查时证明不了内容，之后也证明不了意见还对得上");
  // 审查者现场：子模块丢了仓库标记时打锚点，之后改了里面的代码——共用判据必须给未知，不是 true。
  const lostSource = makeRepo("lost-src");
  const lost = makeRepo("lost-parent");
  git(lost, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lostSource, "module");
  git(lost, "commit", "-qm", "add sub");
  rmSync(join(lost, "module", ".git"));
  const reviewedAt = await workspaceSnapshot(lost, { verify: true });
  assert.equal(reviewedAt.fingerprint, null);
  writeFileSync(join(lost, "module", "a.txt"), "changed later\n");
  const now = await workspaceSnapshot(lost, { verify: true });
  assert.equal(reviewAnchorMatches({
    reviewedCommit: reviewedAt.head, reviewedFingerprint: reviewedAt.fingerprint ?? UNKNOWN_FINGERPRINT,
    disputedFingerprint: null,
  }, now), null, "采集失败的新审查永远判未知");
} catch (error) {
  failure = error;
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
console.log("free review anchor ok");
process.exit(0);

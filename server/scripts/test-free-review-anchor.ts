// 审查结论的「内容锚点」回归：工作区内容指纹，以及「部分驳回 → 用户维持意见」之后修复照常放行。
//
// 现场（2026-11-07 EZk_VTsu4Lzb）：执行者改完不提交，审查在脏工作区上跑；它按驳回工具的要求
// 先改掉认下的 7 条、再驳剩下 1 条；用户裁定「接着改」，系统却报「审查意见针对的代码已变化」
// 拒绝发起修复——锚点只比 HEAD + 干净，这条路每一次都走不通。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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

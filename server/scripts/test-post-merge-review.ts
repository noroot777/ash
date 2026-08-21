import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-post-merge-review-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

try {
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.name", "Ash Test");
  git(repo, "config", "user.email", "ash@example.test");
  writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
  writeFileSync(join(repo, "feature.txt"), "before\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "base");
  const baseCommit = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "feature.txt"), "after merge\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "accepted merge");
  const mergeCommit = git(repo, "rev-parse", "HEAD");

  const { ensureSchema, db } = await import("../src/db/index.js");
  const { freeReviewRounds, freeReviewRuns, projects, tasks } = await import("../src/db/schema.js");
  const { acceptedCommitDiff } = await import("../src/git-diff.js");
  const { handleFreeWorkflowSettlement } = await import("../src/free-workflow.js");
  const { cleanupAcceptedMergeRun, reopenFailedFreeReview } = await import("../src/free-review-round.js");
  const { createPostMergeRepairTask, startPostMergeReview } = await import("../src/post-merge-review.js");
  const {
    postMergeReviewWorktreePath,
    preparePostMergeReviewWorktree,
  } = await import("../src/post-merge-review-worktree.js");
  const { createTasks } = await import("../src/task-store.js");
  const { claimTurn } = await import("../src/runs.js");
  await ensureSchema();
  await db.insert(projects).values({ id: "p", name: "project", repoPath: repo, createdAt: new Date().toISOString() });

  const at = new Date().toISOString();
  await createTasks([{
    id: "accepted-task", projectId: "p", groupId: null, parentId: null,
    title: "accepted feature", body: "implement", mode: "single", status: "done", stage: "accepted",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: null, model: null, reasoningEffort: null, autoTitle: false,
    createdAt: at, updatedAt: at, useWorktree: true, worktreeBase: "main",
    originTaskId: null, workflowMode: "free",
    acceptedTargetBranch: "main", acceptedBaseCommit: baseCommit, acceptedMergeCommit: mergeCommit,
  }]);
  await createTasks([{
    id: "unfinished-task", projectId: "p", groupId: null, parentId: null,
    title: "unfinished", body: "implement", mode: "single", status: "done",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: null, model: null, reasoningEffort: null, autoTitle: false,
    createdAt: at, updatedAt: at, useWorktree: true, worktreeBase: "main",
    originTaskId: null, workflowMode: "free",
  }]);

  const dispatch = { reviewerId: "missing", checkMode: "logic" as const, retryLimit: 3 };
  await assert.rejects(startPostMergeReview("unfinished-task", dispatch), /尚未完成验收/);
  await db.update(tasks).set({ stage: "accepted" }).where(eq(tasks.id, "unfinished-task"));
  await assert.rejects(startPostMergeReview("unfinished-task", dispatch), /没有完整的合并快照/);
  git(repo, "reset", "--hard", baseCommit);
  await assert.rejects(startPostMergeReview("accepted-task", dispatch), /已不在 main 上/);
  git(repo, "reset", "--hard", mergeCommit);

  const diff = await acceptedCommitDiff(repo, "main", baseCommit, mergeCommit);
  assert.equal(diff.available, true);
  assert.equal(diff.sourceBranch, `main@${baseCommit.slice(0, 8)}`);
  assert.equal(diff.targetBranch, `main@${mergeCommit.slice(0, 8)}`);
  assert.deepEqual(diff.files.map((file) => file.path), ["feature.txt"]);
  assert.match(diff.diff, /after merge/);

  const runId = "post-merge-run";
  const worktree = await preparePostMergeReviewWorktree(repo, "accepted-task", runId, mergeCommit);
  assert.equal(git(worktree, "rev-parse", "HEAD"), mergeCommit, "临时 worktree 必须钉在验收 merge commit");
  assert.equal(git(worktree, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD", "临时 worktree 必须 detached");
  await db.insert(freeReviewRuns).values({
    id: runId, taskId: "accepted-task", reviewerId: null, reviewerName: "Codex review",
    agentType: "codex", executorId: null, model: null, reasoningEffort: null,
    checkMode: "logic", note: null, targetKind: "accepted_merge", targetBranch: "main",
    targetBaseCommit: baseCommit, targetCommit: mergeCommit, repairTaskId: null,
    retryLimit: 0, currentRound: 1, status: "reviewing", createdAt: at, updatedAt: at, finishedAt: null,
  });
  await db.insert(freeReviewRounds).values({
    id: "post-merge-round", runId, round: 1, status: "reviewing", conclusion: "verify_failed",
    reviewedCommit: mergeCommit, startedAt: at, endedAt: null,
  });
  const evidence = join(root, "runs", "accepted-task", "free-review", runId, "round-1");
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, "report.md"), "# 未通过\n\n合并后的入口状态不符合预期。\n");

  await handleFreeWorkflowSettlement("accepted-task", "done", false, true, "reviewer");
  const [settledRun, sourceAfter] = await Promise.all([
    db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, runId)).then((rows) => rows.at(0)),
    db.select().from(tasks).where(eq(tasks.id, "accepted-task")).then((rows) => rows.at(0)),
  ]);
  assert.equal(settledRun?.status, "stopped");
  assert.equal(sourceAfter?.stage, "accepted", "未通过不得重开原任务");
  assert.equal(existsSync(postMergeReviewWorktreePath(repo, "accepted-task", runId)), false, "结算后必须清理临时 worktree");

  const repair = await createPostMergeRepairTask("accepted-task", runId);
  assert.equal(repair.status, "backlog");
  assert.equal(repair.workflowMode, "free");
  assert.equal(repair.useWorktree, true);
  assert.equal(repair.worktreeBase, mergeCommit, "修复任务必须从验收 merge commit 起步");
  assert.equal(repair.originTaskId, "accepted-task");
  const again = await createPostMergeRepairTask("accepted-task", runId);
  assert.equal(again.id, repair.id, "重复点击必须幂等返回同一修复任务");
  assert.equal((await db.select().from(tasks)).filter((task) => task.originTaskId === "accepted-task").length, 1);

  // 目标分支新增的「重跑上一回合」也要兼容验收后审查：允许重跑 postmerge reviewer，
  // 但仍不允许借它重开验收前工作区审查。占住 turn 让投递停在队列里，避免测试真起 CLI。
  const retryRun = { ...settledRun!, id: "post-merge-retry", status: "failed", repairTaskId: null };
  await db.insert(freeReviewRuns).values(retryRun);
  await db.insert(freeReviewRounds).values({
    id: "post-merge-retry-round", runId: retryRun.id, round: 1, status: "error", conclusion: null,
    reviewedCommit: mergeCommit, startedAt: at, endedAt: at,
  });
  assert.equal(claimTurn("accepted-task"), true);
  const retried = await reopenFailedFreeReview("accepted-task");
  assert.equal(retried.reviews.find((run) => run.id === retryRun.id)?.status, "reviewing");
  assert.equal(existsSync(postMergeReviewWorktreePath(repo, "accepted-task", retryRun.id)), true,
    "验收后审查重跑必须重建准确 merge commit 的临时 worktree");
  await cleanupAcceptedMergeRun(retryRun);

  console.log("post-merge review regression test passed");
} finally {
  // 删舞台前先松开库文件,否则 Windows 上必然 EBUSY(理由见 tmp-db.ts 的 releaseTmpDb)。
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}

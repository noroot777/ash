// Reviewer orchestration policy regression tests. These are pure and avoid
// launching an actual CLI agent while pinning the settlement-only trigger,
// two-round repair cap, round numbering, and evidence path boundary.
// Run: npm -w server run test:review
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "harness-review-flow-"));
process.env.HARNESS_DB = join(root, "harness.db");

const {
  nextReviewRound,
  mountReviewRoutes,
  reviewOutcomeAction,
  REVIEW_OVERWRITE_CHECK,
  reviewRoundDir,
  safeReviewFilePath,
  shouldAutoDispatchReview,
} = await import("../src/review.js");
const {
  detectReviewCoverage,
  formatReviewCoverageFacts,
  repairCoverageGuard,
} = await import("../src/review-coverage.js");

const baseTrigger = {
  confirmedDone: true,
  status: "done" as const,
  parentIsTeam: true,
  mode: "single",
  reviewOf: null,
  reviewRequested: true,
  stage: null,
  existingRounds: 0,
};

assert.equal(shouldAutoDispatchReview(baseTrigger), true, "团队执行者亲口确认 done 后应派初审");
assert.equal(
  shouldAutoDispatchReview({ ...baseTrigger, confirmedDone: false }),
  false,
  "续聊回落 done / lax done 没有本回合完成确认时不得派审",
);
assert.equal(
  shouldAutoDispatchReview({ ...baseTrigger, parentIsTeam: false }),
  false,
  "普通单任务不自动派审",
);
assert.equal(
  shouldAutoDispatchReview({ ...baseTrigger, mode: "team" }),
  false,
  "调度台自身不派审",
);
assert.equal(
  shouldAutoDispatchReview({ ...baseTrigger, reviewOf: "target" }),
  false,
  "审查任务自身不递归派审",
);
assert.equal(
  shouldAutoDispatchReview({ ...baseTrigger, reviewRequested: false }),
  false,
  "团队配置或 dispatch 覆盖关闭审查后不得派审",
);
assert.equal(
  shouldAutoDispatchReview({ ...baseTrigger, stage: "verify_failed", existingRounds: 1 }),
  true,
  "第一轮失败后的修复完成应自动复审",
);
assert.equal(
  shouldAutoDispatchReview({ ...baseTrigger, stage: "verify_failed", existingRounds: 2 }),
  false,
  "第二轮失败后必须停住，不得自动创建第三轮",
);
assert.equal(
  shouldAutoDispatchReview({ ...baseTrigger, stage: "verified", existingRounds: 1 }),
  false,
  "已验证任务后续闲聊即使确认也不重复派审",
);

assert.equal(nextReviewRound(0), 1);
assert.equal(nextReviewRound(1), 2);
assert.equal(nextReviewRound(2), 3, "手动派审不受两轮自动上限限制");
assert.match(REVIEW_OVERWRITE_CHECK, /ask_question/, "审查 prompt 必须要求覆盖场景先等人工拍板");

assert.equal(
  reviewOutcomeAction({ reviewStatus: "done", conclusion: "verify_failed", reviewRequested: true, round: 1 }),
  "repair",
  "第一轮 verify_failed 应把报告打回原任务修复",
);

const coverageRepo = join(root, "coverage-repo");
const git = (...args: string[]) => execFileSync("git", ["-C", coverageRepo, ...args], {
  encoding: "utf8",
}).trim();
const commit = (message: string, at: string) => {
  execFileSync("git", ["-C", coverageRepo, "commit", "-m", message], {
    env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
  });
  return git("rev-parse", "HEAD");
};
execFileSync("git", ["init", "-b", "main", coverageRepo]);
git("config", "user.name", "Harness Review Test");
git("config", "user.email", "harness@example.test");
writeFileSync(join(coverageRepo, "shared.ts"), "seed\n");
writeFileSync(join(coverageRepo, "other.ts"), "seed\n");
git("add", "-A");
commit("seed", "2026-01-01T00:00:00Z");
writeFileSync(join(coverageRepo, "shared.ts"), "task output\n");
git("add", "shared.ts");
const artifactSha = commit("任务产物", "2026-01-01T00:01:00Z");
writeFileSync(join(coverageRepo, "other.ts"), "unrelated\n");
git("add", "other.ts");
commit("无关后续", "2026-01-01T00:02:00Z");
writeFileSync(join(coverageRepo, "shared.ts"), "replacement\n");
git("add", "shared.ts");
const coveringSha = commit("反转需求", "2026-01-01T00:03:00Z");

const coverage = await detectReviewCoverage({
  repoPath: coverageRepo,
  ref: "main",
  turnStartedAt: "2026-01-01T00:00:30Z",
  endedAt: "2026-01-01T00:01:30Z",
});
assert.equal(coverage?.basis, "artifact_files");
assert.deepEqual(coverage?.artifactCommits.map((item) => item.sha), [artifactSha]);
assert.deepEqual(coverage?.laterCommits.map((item) => item.sha), [coveringSha], "只报告触及同批文件的后续提交");
assert.deepEqual(coverage?.laterCommits[0]?.files, ["shared.ts"]);
assert.match(formatReviewCoverageFacts(coverage!), /反转需求/);
assert.match(formatReviewCoverageFacts(coverage!), new RegExp(coveringSha));
assert.match(formatReviewCoverageFacts(coverage!), /shared\.ts/);
assert.match(repairCoverageGuard(coverage!), /不要直接恢复/);
assert.match(repairCoverageGuard(coverage!), /ask_question/);
assert.equal(repairCoverageGuard(null), "", "未检测到覆盖时修复 prompt 不增加噪声");

const disjointOnly = await detectReviewCoverage({
  repoPath: coverageRepo,
  ref: `${coveringSha}^`,
  turnStartedAt: "2026-01-01T00:00:30Z",
  endedAt: "2026-01-01T00:01:30Z",
});
assert.equal(disjointOnly, null, "后续提交只改其它文件时不得给修复 prompt 增加噪声");

const fallback = await detectReviewCoverage({
  repoPath: coverageRepo,
  ref: "main",
  turnStartedAt: "2026-01-01T00:10:00Z",
  endedAt: "2026-01-01T00:01:30Z",
});
assert.equal(fallback?.basis, "ended_at_fallback", "拿不到产物提交时按 endedAt 后的新提交退化检测");
assert.deepEqual(fallback?.laterCommits.map((item) => item.sha), [
  git("rev-parse", `${coveringSha}^`),
  coveringSha,
]);
const missingBranchFallback = await detectReviewCoverage({
  repoPath: coverageRepo,
  ref: "deleted-task-branch",
  endedAt: "2026-01-01T00:01:30Z",
});
assert.equal(missingBranchFallback?.basis, "ended_at_fallback", "任务分支丢失时仍应退化检查当前 HEAD");
assert.equal(
  reviewOutcomeAction({ reviewStatus: "done", conclusion: "verify_failed", reviewRequested: true, round: 2 }),
  "stop",
  "第二轮 verify_failed 应停等人工",
);
assert.equal(
  reviewOutcomeAction({ reviewStatus: "done", conclusion: "verify_failed", reviewRequested: false, round: 1 }),
  "repair",
  "手动单任务审查失败也应打回修复，但不会暗中续派下一轮",
);
assert.equal(
  reviewOutcomeAction({ reviewStatus: "done", conclusion: "verify_failed", reviewRequested: true, round: 3 }),
  "repair",
  "手动追加的第三轮不受自动两轮上限约束",
);
assert.equal(
  reviewOutcomeAction({ reviewStatus: "done", conclusion: "verified", reviewRequested: true, round: 1 }),
  "verified",
);
assert.equal(
  reviewOutcomeAction({ reviewStatus: "failed", conclusion: null, reviewRequested: true, round: 1 }),
  "failed",
  "审查执行器自身失败时不循环",
);

const taskId = "review-path-test";
const base = resolve(reviewRoundDir(taskId, 1));
assert.equal(safeReviewFilePath(taskId, 1, "../secret.md"), null, "拒绝 .. 路径穿越");
assert.equal(safeReviewFilePath(taskId, 1, "/tmp/secret.md"), null, "拒绝绝对路径逃逸");
assert.equal(safeReviewFilePath(taskId, 0, "report.md"), null, "轮次必须从 1 开始");
assert.equal(
  safeReviewFilePath(taskId, 1, "report.md"),
  resolve(base, "report.md"),
  "合法证据文件应落在当前 round 目录",
);

// Exercise the real route guard as well as the shared lexical helper.
const [{ db, ensureSchema }, { tasks }, { Hono }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("hono"),
]);
await ensureSchema();
const at = new Date().toISOString();
await db.insert(tasks).values({
  id: taskId,
  projectId: "project",
  groupId: null,
  parentId: null,
  title: "path target",
  body: "",
  mode: "single",
  status: "done",
  stage: null,
  reviewRequested: true,
  priority: "none",
  labels: "[]",
  dependsOn: "[]",
  resumeDependsOn: "[]",
  agentType: "claude",
  autoTitle: false,
  createdAt: at,
  updatedAt: at,
});
const api = new Hono();
mountReviewRoutes(api);
const traversal = await api.request(
  `/tasks/${taskId}/review/file?round=1&name=${encodeURIComponent("../secret.md")}`,
);
assert.equal(traversal.status, 400, "review/file 路由必须拒绝路径穿越");

const outside = join(root, "outside");
mkdirSync(join(outside, "round-1"), { recursive: true });
writeFileSync(join(outside, "round-1", "report.md"), "outside secret\n");
const reviewParent = join(base, "..");
rmSync(reviewParent, { recursive: true, force: true });
mkdirSync(join(reviewParent, ".."), { recursive: true });
symlinkSync(outside, reviewParent);
const symlinkTraversal = await api.request(
  `/tasks/${taskId}/review/file?round=1&name=report.md`,
);
assert.equal(symlinkTraversal.status, 404, "review/file 必须拒绝证据目录祖先 symlink");
rmSync(reviewParent, { force: true });

const info = await api.request(`/tasks/${taskId}/review`);
assert.deepEqual(await info.json(), { reviewRequested: true, rounds: [] });

rmSync(resolve(base, "../.."), { recursive: true, force: true });
rmSync(root, { recursive: true, force: true });
console.log("review flow tests passed");

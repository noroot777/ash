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

const { mountReviewRoutes } = await import("../src/review.js");
// 证据落盘（路径边界、结论文件）住在 review-evidence.ts，措辞住在 review-prompts.ts。
const {
  nextReviewRound,
  reviewRoundDir,
  safeReviewFilePath,
} = await import("../src/review-evidence.js");
const { REVIEW_OVERWRITE_CHECK } = await import("../src/review-prompts.js");
// 判定（该不该派、几轮、找谁验）住在 review-policy.ts，是纯函数，所以这一段全程不起
// 数据库、不起 CLI。
const {
  reviewOutcomeAction,
  shouldAutoDispatchReview,
} = await import("../src/review-policy.js");
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

// ── 就地验证轮的收尾语义 ────────────────────────────────────────────────────
// 验证现在跑在被验任务自己身上（旁路回合），所以「这一轮完了没有」只能从
// verify_round / question / resumePrompt 上读，不能从任务状态读 —— 任务状态在旁路
// 回合里本来就该原样不动。这两条最容易回归，钉住它们。
const { handleTaskSettlement } = await import("../src/review.js");
const { readConclusion } = await import("../src/review-evidence.js");
const { eq } = await import("drizzle-orm");
const inlineId = "verify-inline-test";
const readTask = async () =>
  (await db.select().from(tasks).where(eq(tasks.id, inlineId))).at(0)!;

await db.insert(tasks).values({
  id: inlineId,
  projectId: "project",
  groupId: null,
  parentId: null,
  title: "inline verify target",
  body: "",
  mode: "single",
  status: "done",
  stage: "verifying",
  verifyRound: 1,
  verifyRounds: 0,
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

// ① 验证回合中途提问：这一轮还没验完，轮次标记必须留着，也不许下结论 ——
//    否则答复回来的那一回合会被当成「验完了却没给结论」。
await db.update(tasks).set({ question: "这个按钮该长什么样？" }).where(eq(tasks.id, inlineId));
await handleTaskSettlement(inlineId, "paused", false, true);
let inline = await readTask();
assert.equal(inline.verifyRound, 1, "验证回合以提问结束时必须保留 verify_round");
assert.equal(inline.verifyRounds, 0, "还没验完，不能记账为已跑完一轮");
assert.equal(await readConclusion(inlineId, 1), null, "还没验完，不能落结论文件");

// ② 答复之后真正验完：清轮次标记、记账 +1，并把 stage 上的结论固化成结论文件。
await db.update(tasks).set({ question: null, stage: "verified" }).where(eq(tasks.id, inlineId));
await handleTaskSettlement(inlineId, "done", false, true);
inline = await readTask();
assert.equal(inline.verifyRound, null, "验完必须清掉 verify_round");
assert.equal(inline.verifyRounds, 1, "验完一轮要记账，下一轮的轮次号靠它推出来");
assert.equal(inline.verifyStationRounds, 1, "这一站也要单独记账：轮数上限是按站算的");
assert.equal(await readConclusion(inlineId, 1), "verified", "结论要落盘，刷新后仍看得见");

const inlineInfo = await (async () => {
  const response = await api.request(`/tasks/${inlineId}/review`);
  return (await response.json()) as { rounds: Array<Record<string, unknown>> };
})();
assert.equal(inlineInfo.rounds.length, 1, "就地验证轮同样要出现在验证记录里");
assert.deepEqual(
  {
    round: inlineInfo.rounds[0].round,
    where: inlineInfo.rounds[0].where,
    reviewTaskId: inlineInfo.rounds[0].reviewTaskId,
    conclusion: inlineInfo.rounds[0].conclusion,
  },
  { round: 1, where: "inline", reviewTaskId: null, conclusion: "verified" },
  "就地轮次没有独立审查任务，reviewTaskId 必须是 null",
);
rmSync(resolve(reviewRoundDir(inlineId, 1), "../.."), { recursive: true, force: true });

// ── 一条线上有好几站验证时，轮数得按站算 ────────────────────────────────────
// 轮数上限是按站写的（第二站写「没过重做 2 轮」，不该继承第一站用掉的轮数）。就地验证
// 轮没有独立任务行可数，所以按站的轮数记在被验任务的 verify_station_rounds 上、站号记
// 在 review_step 上；漏掉这一份，一站验证会因为「一轮都没验过」被无限重派。
const { stationRounds } = await import("../src/workflow-advance.js");
await db.update(tasks)
  .set({ reviewStep: "v-second", verifyStationRounds: 2 })
  .where(eq(tasks.id, inlineId));
assert.equal(await stationRounds(inlineId, "v-second"), 2, "就地验证轮必须计入本站轮数");
assert.equal(await stationRounds(inlineId, "v-first"), 0, "换一站就从零开始，不继承别站用掉的轮数");

// 存量的独立审查任务是另一种载体，两边要一起数。老审查任务身上没有 review_step，
// 按「那时一条线只可能有一站验证」算进第一站。
await db.insert(tasks).values({
  id: "verify-legacy-row", projectId: "project", groupId: null, parentId: null,
  title: "legacy review", body: "", mode: "single", status: "done",
  reviewOf: inlineId, reviewRound: 1, reviewStep: "v-second",
  priority: "none", labels: "[]", dependsOn: "[]", resumeDependsOn: "[]",
  agentType: "claude", autoTitle: false, createdAt: at, updatedAt: at,
});
assert.equal(await stationRounds(inlineId, "v-second"), 3, "两种载体的轮数要加在一起");

// ── 验证起不来时不许把原任务打成 failed ──────────────────────────────────────
// 旁路回合的整个前提是「验证不改任务状态」，而启动路径上有好几处会抛错（执行器解析
// 撞上不兼容的模型/思考强度、worktree 建不出来）。原状态必须在这些解析**之前**落进
// followUpFrom，否则 catch 那边读不到，只能把一个 done 的任务打成 failed。
const { continueTask } = await import("../src/orchestrator.js");
const failId = "verify-start-fail";
await db.insert(tasks).values({
  id: failId,
  projectId: "project",
  groupId: null,
  parentId: null,
  title: "verify start failure",
  body: "",
  mode: "single",
  status: "done",
  stage: "verifying",
  verifyRound: 1,
  verifyRounds: 0,
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
// 起不来的原因随便挑一个真实的：claude 没有 no-such-effort 这个档位，resolveExecutorFor
// 会在起进程之前就抛错 —— 所以这条用例不会真的拉起 CLI。
await continueTask(failId, "验证一下", {
  system: "run",
  sideTurn: true,
  agent: "claude",
  reasoningEffort: "no-such-effort",
});
const failed = (await db.select().from(tasks).where(eq(tasks.id, failId))).at(0)!;
assert.equal(failed.status, "done", "验证启动失败不能把原任务的终态改坏");
assert.equal(failed.followUpFrom, null, "结算后要清掉 followUpFrom");
assert.equal(failed.verifyRound, null, "起不来的那一轮不能永远占着「正在验证」");
assert.equal(failed.verifyRounds, 1, "这一轮算跑过了（无结论），下一轮接着往下数");
rmSync(resolve(reviewRoundDir(failId, 1), "../.."), { recursive: true, force: true });

rmSync(resolve(base, "../.."), { recursive: true, force: true });
rmSync(root, { recursive: true, force: true });
console.log("review flow tests passed");

import assert from "node:assert/strict";
import {
  freeConclusionFreshness,
  freeReviewActivityDetail,
  freeReviewActivityTitle,
  freeReviewBlockingLabel,
  freeReviewView,
  openDisputeIn,
} from "../src/free-workflow/freeReviewCopy.ts";

const run = {
  reviewerName: "5.5审查",
  checkMode: "logic",
  retryLimit: 1,
  currentRound: 1,
  rounds: [],
};

assert.equal(freeReviewActivityTitle({ ...run, status: "reviewing" }), "5.5审查 · 逻辑检查");
assert.equal(
  freeReviewActivityDetail({ ...run, status: "reviewing" }),
  "审查中 · 已到第 1 轮 / 最多 2 轮",
);
assert.equal(
  freeReviewActivityDetail({ ...run, status: "stopped" }),
  "未通过，等待处理 · 已到第 1 轮 / 最多 2 轮",
);

// 验收只等审查回合本身；stopped/passed/failed 都不硬拦（警示归验收页）。
assert.equal(freeReviewBlockingLabel({ ...run, status: "reviewing" }), "审查进行中");
assert.equal(freeReviewBlockingLabel({ ...run, status: "stopped" }), null);
assert.equal(freeReviewBlockingLabel({ ...run, status: "passed" }), null);
assert.equal(freeReviewBlockingLabel({ ...run, status: "failed" }), null);

// 结论新鲜度是三态：fresh 要求锚点等于 HEAD 且工作区干净；缺任何一项事实都是 unknown，
// 绝不能失败开放地当成新鲜。
const passedRun = {
  ...run,
  status: "passed",
  rounds: [{ round: 1, status: "passed", conclusion: "verified", reviewedCommit: "aaa" }],
};
assert.equal(freeConclusionFreshness(passedRun, "aaa", false), "fresh", "锚点=HEAD 且工作区干净才是新鲜");
assert.equal(freeConclusionFreshness(passedRun, "bbb", false), "stale", "HEAD 变了结论过期");
assert.equal(freeConclusionFreshness(passedRun, "aaa", true), "stale", "未提交改动同样算过期，不能只看 HEAD");
assert.equal(freeConclusionFreshness(passedRun, null, false), "unknown", "取不到 HEAD 是未知，不是新鲜");
assert.equal(freeConclusionFreshness(passedRun, "aaa", null), "unknown", "读不到工作区脏净是未知");
assert.equal(
  freeConclusionFreshness({ ...passedRun, rounds: [{ round: 1, status: "passed", conclusion: "verified", reviewedCommit: null }] }, "bbb", false),
  "unknown",
  "老数据没有基准 commit 是未知，不是新鲜",
);
assert.equal(
  freeConclusionFreshness({
    ...passedRun,
    rounds: [
      { round: 1, status: "failed", conclusion: "verify_failed", reviewedCommit: "old" },
      { round: 2, status: "passed", conclusion: "verified", reviewedCommit: null },
    ],
  }, "old", false),
  "unknown",
  "只认最新结论轮自己的锚点，不得回退借用旧轮",
);

// 有内容指纹时按内容比，不再按「HEAD 相同且干净」：在没提交的改动上审出来的结论，
// 落地时工作区本来就脏，照旧判法一出生就过期。
const dirtyReviewed = {
  ...run,
  status: "stopped",
  rounds: [{ round: 1, status: "failed", conclusion: "verify_failed", reviewedCommit: "aaa", reviewedFingerprint: "v1:review" }],
};
assert.equal(freeConclusionFreshness(dirtyReviewed, "aaa", true, "v1:review"), "fresh", "脏工作区上审的结论，内容没变就是新鲜");
assert.equal(freeConclusionFreshness(dirtyReviewed, "aaa", true, "v1:other"), "stale", "内容变了就过期");
assert.equal(freeConclusionFreshness(dirtyReviewed, "aaa", false, null), "unknown", "有指纹锚点却读不到当前指纹是未知");
// 部分驳回：执行者先改掉认下的几条再驳剩下的，驳回那一版同样是这一轮的锚点。
const partlyDisputed = {
  ...dirtyReviewed,
  rounds: [{ ...dirtyReviewed.rounds[0], disputedFingerprint: "v1:dispute" }],
};
assert.equal(freeConclusionFreshness(partlyDisputed, "aaa", true, "v1:dispute"), "fresh", "驳回那一版仍对应这轮意见");
assert.equal(freeConclusionFreshness(partlyDisputed, "aaa", true, "v1:review"), "fresh", "审查那一版同样认");
assert.equal(freeConclusionFreshness(partlyDisputed, "aaa", true, "v1:later"), "stale", "驳回之后又改过就过期");
// 采纳执行者 / 转独立任务之后不再「接着修」，驳回前改的那部分没人审过：只认审查那一版。
for (const resolution of ["withdrawn", "deferred"]) {
  const ruled = {
    ...partlyDisputed,
    rounds: [{ ...partlyDisputed.rounds[0], dispute: { resolution } }],
  };
  assert.equal(freeConclusionFreshness(ruled, "aaa", true, "v1:dispute"), "stale", `${resolution} 之后驳回那一版不再算审过`);
  assert.equal(freeConclusionFreshness(ruled, "aaa", true, "v1:review"), "fresh", `${resolution} 之后审查那一版照旧`);
}
assert.equal(freeConclusionFreshness({
  ...partlyDisputed,
  rounds: [{ ...partlyDisputed.rounds[0], dispute: { resolution: "upheld" } }],
}, "aaa", true, "v1:dispute"), "fresh", "维持意见后接着修的就是驳回那一版");

// 叙事全部推导：修复中 = 任务在跑 + 未通过意见在身；自动复审 = 预约槽挂 runId。
const stoppedState = {
  workspaceHead: "aaa",
  workspaceDirty: false,
  reviewReservation: { armed: false, reviewerId: null, checkMode: null, retryLimit: null, note: null, runId: null },
  reviews: [{ ...run, status: "stopped" }],
};
const idleTask = { status: "done" };
const busyTask = { status: "running" };
assert.equal(freeReviewView(stoppedState, idleTask).repairing, false, "任务空闲不算修复中");
assert.equal(freeReviewView(stoppedState, busyTask).repairing, true, "任务在跑且有未通过意见 = 修复中");
const autoState = {
  ...stoppedState,
  reviewReservation: { armed: true, reviewerId: "r", checkMode: "logic", retryLimit: 1, note: null, runId: "run-1" },
};
assert.equal(freeReviewView(autoState, busyTask).autoRereview, true, "runId 预约 = 自动复审链");
assert.equal(freeReviewView({ ...autoState, reviewReservation: { ...autoState.reviewReservation, runId: null } }, busyTask).autoRereview, false);

console.log("free review activity copy tests passed");

// 「已裁定为不在本任务里修」是两档：采纳执行者作废，和转成独立任务。两档都要关掉修复
// 入口——后者更硬，那几条已经有别的任务在承接，这里再修一遍就是两处各改一版。
const disputeRun = (resolution, deferReason = null, supersededAt = null) => ({
  ...run,
  id: "disputed",
  status: "stopped",
  rounds: [{
    round: 1, status: "failed", conclusion: "verify_failed", reviewedCommit: "aaa",
    dispute: {
      reason: "读错了行号", deferReason, at: "t", resolution, resolvedAt: null, deferredTaskId: null,
      supersededAt, debates: [],
    },
  }],
});
const viewOfRuns = (reviews) => freeReviewView({
  workspaceHead: "aaa",
  workspaceDirty: false,
  reviewReservation: { armed: false, reviewerId: null, checkMode: null, retryLimit: null, note: null, runId: null },
  reviews,
}, { status: "done" });
const viewOf = (runValue) => viewOfRuns([runValue]);
assert.equal(viewOf(disputeRun(null)).disputedRound?.round, 1, "没裁定的驳回是「等你裁定」");
assert.equal(viewOf(disputeRun(null)).waivedRound, null, "没裁定就不算「不在本任务里修」");
assert.equal(viewOf(disputeRun("withdrawn")).waivedRound?.round, 1, "采纳执行者 = 不在本任务里修");
assert.equal(viewOf(disputeRun("deferred")).waivedRound?.round, 1, "转独立任务同样关掉修复入口");
assert.equal(viewOf(disputeRun("upheld")).waivedRound, null, "维持意见恰恰是要照改，不能关掉修复入口");

// 会话那一侧（时间线上的「去裁定」）只拿得到 reviews 列表，拿不到整个 FreeWorkflowState，
// 所以它走 openDisputeIn。口径必须和上面 freeReviewView 那条完全一致——按钮和它指向的那
// 张卡各算各的，就会出现「按钮还在、点进去什么也没有」。
assert.equal(openDisputeIn([disputeRun(null)])?.round, 1, "挂着未裁定驳回 = 有卡可裁");
assert.equal(openDisputeIn([disputeRun("deferred")]), null, "裁定完那张卡就没了");
assert.equal(openDisputeIn([]), null);
assert.equal(openDisputeIn(null), null);
// 判据是任务级的：更新的一条链遮不住旧驳回（服务端裁定闸照样挡着预约，界面不能找不到那张卡）。
const newer = { ...run, id: "newer", status: "failed", rounds: [] };
assert.equal(
  openDisputeIn([newer, disputeRun(null)])?.round,
  1,
  "更新的审查链遮不住还没裁定的旧驳回",
);
assert.equal(viewOfRuns([newer, disputeRun(null)]).disputedRun?.id, "disputed",
  "被更新的链压着时，裁定卡仍挂在旧驳回所在的那条链上");
// 用户自己又派了一轮（服务端记 supersededAt）：这条驳回不再等裁定。
assert.equal(openDisputeIn([newer, disputeRun(null, null, "t2")]), null, "被用户新派的审查取代后不再是待裁定");
// 合并结果审查是验收后的独立只读链，不参与验收前的裁定语义（与 freeReviewView 同判据）。
assert.equal(
  openDisputeIn([{ ...disputeRun("deferred"), target: { kind: "accepted_merge" } }, disputeRun(null)])?.round,
  1,
  "合并结果审查要跳过，取它后面那条工作区审查链",
);

console.log("free review dispute view tests passed");

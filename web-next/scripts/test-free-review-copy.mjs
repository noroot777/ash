import assert from "node:assert/strict";
import {
  freeConclusionStale,
  freeReviewActivityDetail,
  freeReviewActivityTitle,
  freeReviewBlockingLabel,
  freeReviewView,
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

// 结论新鲜度锚定 commit：审查基准和当前 HEAD 不一致才算过期。
const passedRun = {
  ...run,
  status: "passed",
  rounds: [{ round: 1, status: "passed", conclusion: "verified", reviewedCommit: "aaa" }],
};
assert.equal(freeConclusionStale(passedRun, "aaa"), false, "HEAD 未变不算过期");
assert.equal(freeConclusionStale(passedRun, "bbb"), true, "HEAD 变了结论过期");
assert.equal(freeConclusionStale(passedRun, null), false, "取不到 HEAD 不妄断过期");
assert.equal(
  freeConclusionStale({ ...passedRun, rounds: [{ round: 1, status: "passed", conclusion: "verified", reviewedCommit: null }] }, "bbb"),
  false,
  "老数据没有基准 commit 时不妄断",
);

// 叙事全部推导：修复中 = 任务在跑 + 未通过意见在身；自动复审 = 预约槽挂 runId。
const stoppedState = {
  workspaceHead: "aaa",
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

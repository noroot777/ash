import assert from "node:assert/strict";
import {
  freeReviewActivityDetail,
  freeReviewActivityTitle,
  freeReviewBlockingLabel,
} from "../src/free-workflow/freeReviewCopy.ts";

const run = {
  reviewerName: "5.5审查",
  checkMode: "logic",
  retryLimit: 1,
  currentRound: 1,
};

assert.equal(freeReviewActivityTitle({ ...run, status: "reviewing" }), "5.5审查 · 逻辑检查");
assert.equal(
  freeReviewActivityDetail({ ...run, status: "reviewing" }),
  "审查中 · 已到第 1 轮 / 最多 2 轮",
);

assert.equal(freeReviewActivityTitle({ ...run, status: "repairing" }), "任务修复");
assert.equal(
  freeReviewActivityDetail({ ...run, status: "repairing" }),
  "按 5.5审查 第 1 轮意见修改 · 完成后自动复审",
  "修复回合不能继续把主状态显示成审查",
);

assert.equal(freeReviewActivityTitle({ ...run, status: "manual_repairing" }), "任务修复");
assert.equal(
  freeReviewActivityDetail({ ...run, status: "manual_repairing" }),
  "按 5.5审查 第 1 轮意见修改 · 完成后等待或按预约复审",
);
assert.equal(freeReviewActivityTitle({ ...run, status: "reworking" }), "任务修改");
assert.equal(
  freeReviewActivityDetail({ ...run, status: "reworking" }),
  "任务继续修改 · 完成后等待或按预约复审",
);
assert.equal(
  freeReviewActivityDetail({ ...run, status: "superseded" }),
  "已有新修改，等待复审 · 已到第 1 轮 / 最多 2 轮",
);
assert.equal(freeReviewBlockingLabel({ ...run, status: "reviewing" }), "审查进行中");
assert.equal(freeReviewBlockingLabel({ ...run, status: "repairing" }), "等待修复");
assert.equal(freeReviewBlockingLabel({ ...run, status: "manual_repairing" }), "按意见修改中");
assert.equal(freeReviewBlockingLabel({ ...run, status: "reworking" }), "任务修改中");
assert.equal(freeReviewBlockingLabel({ ...run, status: "superseded" }), null);

console.log("free review activity copy tests passed");

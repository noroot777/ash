import type { FreeReviewRun } from "@harness/shared";

export const FREE_REVIEW_RUN_LABELS: Record<FreeReviewRun["status"], string> = {
  reviewing: "审查中",
  repairing: "修改中，完成后自动复审",
  passed: "已通过",
  exhausted: "轮数用尽，等待人工决定",
  failed: "审查链异常停止",
};

function checkModeLabel(run: FreeReviewRun): string {
  return run.checkMode === "logic" ? "逻辑检查" : "语法检查";
}

export function freeReviewActivityTitle(run: FreeReviewRun): string {
  return run.status === "repairing"
    ? "任务修复"
    : `${run.reviewerName} · ${checkModeLabel(run)}`;
}

export function freeReviewActivityDetail(run: FreeReviewRun): string {
  if (run.status === "repairing") {
    return `按 ${run.reviewerName} 第 ${run.currentRound} 轮意见修改 · 完成后自动复审`;
  }
  return `${FREE_REVIEW_RUN_LABELS[run.status]} · 已到第 ${run.currentRound} 轮 / 最多 ${run.retryLimit + 1} 轮`;
}

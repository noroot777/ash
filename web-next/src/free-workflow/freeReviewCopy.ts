import type { FreeReviewRun } from "@harness/shared";

export const FREE_REVIEW_RUN_LABELS: Record<FreeReviewRun["status"], string> = {
  reviewing: "审查中",
  repairing: "修改中，完成后自动复审",
  manual_repairing: "按审查意见修改中",
  reworking: "任务修改中",
  passed: "已通过",
  exhausted: "轮数用尽，等待人工决定",
  superseded: "已有新修改，等待复审",
  failed: "审查链异常停止",
};

function checkModeLabel(run: FreeReviewRun): string {
  return run.checkMode === "logic" ? "逻辑检查" : "语法检查";
}

export function freeReviewActivityTitle(run: FreeReviewRun): string {
  if (run.status === "reworking") return "任务修改";
  if (run.status === "repairing" || run.status === "manual_repairing") return "任务修复";
  return `${run.reviewerName} · ${checkModeLabel(run)}`;
}

export function freeReviewActivityDetail(run: FreeReviewRun): string {
  if (run.status === "repairing" || run.status === "manual_repairing" || run.status === "reworking") {
    const next = run.status === "repairing" ? "完成后自动复审" : "完成后等待或按预约复审";
    return `${run.status === "reworking" ? "任务继续修改" : `按 ${run.reviewerName} 第 ${run.currentRound} 轮意见修改`} · ${next}`;
  }
  return `${FREE_REVIEW_RUN_LABELS[run.status]} · 已到第 ${run.currentRound} 轮 / 最多 ${run.retryLimit + 1} 轮`;
}

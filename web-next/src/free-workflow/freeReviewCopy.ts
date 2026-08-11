import type { FreeReviewRun, FreeWorkflowState, Task } from "@harness/shared";

// 审查链只有四个持久状态；「修复中 / 等待复审 / 结论过期」全部在这里**推导**出来：
// - 修复中 = 任务本身 running/queued 且最近一轮停在未通过（或挂着预约）
// - 等待自动复审 = 预约槽 armed 且挂着 runId
// - 结论过期 = 有结论的最后一轮 reviewedCommit ≠ 当前工作区 HEAD
export const FREE_REVIEW_RUN_LABELS: Record<FreeReviewRun["status"], string> = {
  reviewing: "审查中",
  passed: "已通过",
  stopped: "未通过，等待处理",
  failed: "审查链异常停止",
};

export function freeReviewBlockingLabel(run: FreeReviewRun): string | null {
  return run.status === "reviewing" ? "审查进行中" : null;
}

function checkModeLabel(run: FreeReviewRun): string {
  return run.checkMode === "logic" ? "逻辑检查" : "语法检查";
}

export function freeReviewActivityTitle(run: FreeReviewRun): string {
  return `${run.reviewerName} · ${checkModeLabel(run)}`;
}

export function freeReviewActivityDetail(run: FreeReviewRun): string {
  return `${FREE_REVIEW_RUN_LABELS[run.status]} · 已到第 ${run.currentRound} 轮 / 最多 ${run.retryLimit + 1} 轮`;
}

/** 最近一轮有结论的审查是否已过期：审查基准 commit 和当前工作区 HEAD 不一致。 */
export function freeConclusionStale(
  run: FreeReviewRun | undefined,
  workspaceHead: string | null | undefined,
): boolean {
  if (!run || !workspaceHead) return false;
  if (run.status !== "passed" && run.status !== "stopped") return false;
  const anchored = [...run.rounds].reverse().find((round) => round.reviewedCommit);
  return !!anchored?.reviewedCommit && anchored.reviewedCommit !== workspaceHead;
}

export type FreeReviewView = {
  latestRun: FreeReviewRun | undefined;
  /** 审查旁路回合正在跑（派审/预约/验收都要等它） */
  reviewing: FreeReviewRun | undefined;
  /** 最近一轮停在未通过（修复按钮、警示的锚点） */
  stoppedRun: FreeReviewRun | null;
  taskBusy: boolean;
  reservationArmed: boolean;
  /** armed 且挂着 runId = 自动复审链的续轮预约 */
  autoRereview: boolean;
  /** 任务在改（running/queued）且有未通过意见在身或挂着预约 */
  repairing: boolean;
  /** 最近结论已过期（代码在审查后又变过） */
  stale: boolean;
};

export function freeReviewView(state: FreeWorkflowState | null | undefined, task: Task): FreeReviewView {
  const reviews = state?.reviews ?? [];
  const latestRun = reviews[0];
  const reviewing = reviews.find((run) => run.status === "reviewing");
  const stoppedRun = latestRun?.status === "stopped" ? latestRun : null;
  const taskBusy = task.status === "running" || task.status === "queued";
  const reservationArmed = !!state?.reviewReservation?.armed;
  const autoRereview = reservationArmed && !!state?.reviewReservation?.runId;
  return {
    latestRun,
    reviewing,
    stoppedRun,
    taskBusy,
    reservationArmed,
    autoRereview,
    repairing: taskBusy && (!!stoppedRun || reservationArmed),
    stale: freeConclusionStale(latestRun, state?.workspaceHead),
  };
}

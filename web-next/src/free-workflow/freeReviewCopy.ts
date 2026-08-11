import type { FreeReviewRun, FreeWorkflowState, Task } from "@harness/shared";

// 审查链只有四个持久状态；「修复中 / 等待复审 / 结论过期」全部在这里**推导**出来：
// - 修复中 = 任务本身 running/queued 且最近一轮停在未通过（或挂着预约）
// - 等待自动复审 = 预约槽 armed 且挂着 runId
// - 结论新鲜度 = 三态：fresh（锚点等于 HEAD 且工作区干净）/ stale（HEAD 变过或有未提交
//   改动）/ unknown（缺锚点或读不到工作区）。unknown 绝不能显示成新鲜——失败要向着
//   「不确定」开，不能向着「没问题」开。
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

export type FreeReviewFreshness = "fresh" | "stale" | "unknown";

/**
 * 最近一轮**有结论**的审查相对当前工作区的新鲜度。只看最新结论轮自己的锚点，
 * 不回退借用更早轮次（借用会把「最新一轮没锚点」洗成旧轮的结论）。
 */
export function freeConclusionFreshness(
  run: FreeReviewRun | undefined,
  workspaceHead: string | null | undefined,
  workspaceDirty: boolean | null | undefined,
): FreeReviewFreshness | null {
  if (!run || (run.status !== "passed" && run.status !== "stopped")) return null;
  const concluded = [...run.rounds].reverse().find((round) => round.conclusion);
  if (!concluded?.reviewedCommit || !workspaceHead || workspaceDirty == null) return "unknown";
  return concluded.reviewedCommit === workspaceHead && !workspaceDirty ? "fresh" : "stale";
}

export type FreeReviewView = {
  latestRun: FreeReviewRun | undefined;
  /** 审查旁路回合正在跑（派审/预约/验收都要等它） */
  reviewing: FreeReviewRun | undefined;
  /** 最近一轮停在未通过（修复按钮、警示的锚点） */
  stoppedRun: FreeReviewRun | null;
  /** 最近一条链异常停止（验收页要警示，不能静默当成没审过） */
  failedRun: FreeReviewRun | null;
  taskBusy: boolean;
  reservationArmed: boolean;
  /** armed 且挂着 runId = 自动复审链的续轮预约 */
  autoRereview: boolean;
  /** 任务在改（running/queued）且有未通过意见在身或挂着预约 */
  repairing: boolean;
  /** 最近结论的新鲜度；最近一轮没有结论（reviewing/failed/无审查）时为 null */
  freshness: FreeReviewFreshness | null;
  /** 结论确定过期（freshness === "stale" 的便捷判断） */
  stale: boolean;
};

export function freeReviewView(state: FreeWorkflowState | null | undefined, task: Task): FreeReviewView {
  const reviews = state?.reviews ?? [];
  const latestRun = reviews[0];
  const reviewing = reviews.find((run) => run.status === "reviewing");
  const stoppedRun = latestRun?.status === "stopped" ? latestRun : null;
  const failedRun = latestRun?.status === "failed" ? latestRun : null;
  const taskBusy = task.status === "running" || task.status === "queued";
  const reservationArmed = !!state?.reviewReservation?.armed;
  const autoRereview = reservationArmed && !!state?.reviewReservation?.runId;
  const freshness = freeConclusionFreshness(latestRun, state?.workspaceHead, state?.workspaceDirty);
  return {
    latestRun,
    reviewing,
    stoppedRun,
    failedRun,
    taskBusy,
    reservationArmed,
    autoRereview,
    repairing: taskBusy && (!!stoppedRun || reservationArmed),
    freshness,
    stale: freshness === "stale",
  };
}

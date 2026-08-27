import type { FreeReviewRun, FreeWorkflowState, Task } from "@ash/shared";

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
  /** 任务挂着待答复的提问或待续跑的检查点指令 —— 「立即派审/修复/开预览」后端必拒（409）。 */
  waiting: boolean;
  reservationArmed: boolean;
  /** 派审按钮此刻的语义是「预约一轮跑完就审」而不是「立刻开审」。
   *  判据是**这个任务后面还会再动**:正在跑(taskBusy)、停在检查点或等答复(waiting)、
   *  或者已经挂着一条预约(armed,点进去是改预约)。后端 reserveFreeReview 对这三种
   *  一律放行,所以这里必须一起认——只认 taskBusy 会把「暂停在检查点的任务」判成
   *  「立刻开审」,再被 waiting 一票否决,入口就死了(第 1 轮审查实测)。 */
  reservationMode: boolean;
  /** armed 且挂着 runId = 自动复审链的续轮预约 */
  autoRereview: boolean;
  /** 任务在改（running/queued）且有未通过意见在身或挂着自动续轮——「修复中」的叙事。
   *  用户手动预约（runId 空）不算：首次审查还没发生过，没有什么可「修复」的。 */
  repairing: boolean;
  /** 最近结论的新鲜度；最近一轮没有结论（reviewing/failed/无审查）时为 null */
  freshness: FreeReviewFreshness | null;
  /** 结论确定过期（freshness === "stale" 的便捷判断） */
  stale: boolean;
};

export function freeReviewView(state: FreeWorkflowState | null | undefined, task: Task): FreeReviewView {
  // 合并结果审查是验收后的独立只读链，不参与验收前的修复、新鲜度和预约语义。
  const reviews = (state?.reviews ?? []).filter((run) => run.target?.kind !== "accepted_merge");
  const latestRun = reviews[0];
  const reviewing = reviews.find((run) => run.status === "reviewing");
  const stoppedRun = latestRun?.status === "stopped" ? latestRun : null;
  const failedRun = latestRun?.status === "failed" ? latestRun : null;
  const taskBusy = task.status === "running" || task.status === "queued";
  const waiting = !!task.question || !!task.resumePrompt;
  const reservationArmed = !!state?.reviewReservation?.armed;
  const autoRereview = reservationArmed && !!state?.reviewReservation?.runId;
  const freshness = freeConclusionFreshness(latestRun, state?.workspaceHead, state?.workspaceDirty);
  return {
    latestRun,
    reviewing,
    stoppedRun,
    failedRun,
    taskBusy,
    waiting,
    reservationArmed,
    reservationMode: taskBusy || waiting || reservationArmed,
    autoRereview,
    repairing: taskBusy && (!!stoppedRun || autoRereview),
    freshness,
    stale: freshness === "stale",
  };
}

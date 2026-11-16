import type { Task, TaskListItem } from "@ash/shared";
import { freeReviewBlockingLabel, freeReviewView } from "../free-workflow/freeReviewCopy.ts";
import { useFreeWorkflowState } from "../free-workflow/useFreeWorkflowState.ts";

export type FactRow = {
  key: string;
  tone: "block" | "warn" | "live" | "idle";
  text: string;
  /** 这一行自己的出路：读失败的重试、审查警示去看审查。 */
  retry?: () => void;
};

export type ReviewFacts = {
  /** 拦验收的那几行（红或「正在替你办」）。 */
  blocks: FactRow[];
  /** 只提醒、不拦的那一行（审查结论的五种警示）。 */
  warning: string | null;
  /** 还在读：主按钮只转圈，不出一行字。 */
  loading: boolean;
  /** 验收之后「审查这次合并」那颗键的三种说法。 */
  postMergeLabel: string;
};

/**
 * 验收之前这个任务自己的几道关（与后端 acceptanceGuard 同款判据）：未收尾的就地验证轮、待答复的
 * 提问、自由工作流的审查。四处宿主共用这一份 —— 原先只有单任务验收台算它，别处的按钮「可点却必 409」。
 *
 * 失败关闭：自由工作流的状态读不出来、或还没读到，一律不放行。已验收（或已合并）的不再算：那一版
 * 已经定稿，挂着的验证轮或提问属于被唤醒之后的新一版。
 */
export function useReviewFacts(task: TaskListItem): ReviewFacts {
  const freeMode = task.workflowMode === "free";
  const free = useFreeWorkflowState(task.id, freeMode);
  const settled = task.stage === "accepted" || task.stage === "merged";
  const inFlight = task.status === "running" || task.status === "queued";
  const latestPostMerge = free.state?.reviews.find((run) => run.target?.kind === "accepted_merge");
  const postMergeLabel = latestPostMerge?.status === "reviewing" ? "合并审查中" : latestPostMerge ? "再审这次合并" : "审查这次合并";
  if (settled) return { blocks: [], warning: null, loading: false, postMergeLabel };
  const blocks: FactRow[] = [];
  if (task.verifyRound != null) blocks.push({ key: "verify-round", tone: "live", text: `第 ${task.verifyRound} 轮验证还没出结论` });
  else if (task.question) blocks.push({ key: "question", tone: "block", text: "有待答复的提问" });
  let loading = false;
  let warning: string | null = null;
  if (freeMode) {
    const active = free.state?.reviews.find((run) => freeReviewBlockingLabel(run) !== null);
    if (active) blocks.push({ key: "review", tone: "live", text: freeReviewBlockingLabel(active)! });
    // 后端只在终态放行自由任务验收；在跑的那一种由「任务在跑」那一行说，这里只说停着没结束的。
    else if (!["done", "failed", "canceled"].includes(task.status) && !inFlight) blocks.push({ key: "unfinished", tone: "block", text: "任务尚未结束" });
    else if (free.error) blocks.push({ key: "review-state", tone: "block", text: "审查状态读不出来", retry: () => void free.reload(false, true) });
    else if (!free.state) loading = true;
    const view = freeReviewView(free.state, task as Task);
    warning = view.stoppedRun && (view.stale || view.freshness === "unknown")
      ? "上一份未通过报告针对的是旧版代码，当前版本没有有效审查结论"
      : view.stoppedRun
        ? `最后一轮审查未通过（第 ${view.stoppedRun.currentRound} 轮）`
        : view.failedRun
          ? "最近一条审查链异常停止，没有结论"
          : view.stale
            ? "审查通过后代码又变了"
            : view.freshness === "unknown"
              ? "认不出审查结论对应的是不是当前代码"
              : null;
  }
  return { blocks, warning, loading, postMergeLabel };
}

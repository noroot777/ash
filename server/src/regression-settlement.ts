import type { ReviewConclusion } from "@ash/shared";
import { checkRegressionConclusion } from "./regression-evidence-lifecycle.js";
import { RegressionConclusionRejected } from "./regression-conclusion-errors.js";
import { appendTaskTimeline } from "./task-timeline.js";

export async function regressionSettlementConclusion(taskId: string, directory: string, conclusion: ReviewConclusion,
  acceptedMerge = false): Promise<{ conclusion: ReviewConclusion } | null> {
  try {
    await checkRegressionConclusion(taskId, directory, conclusion ?? "", acceptedMerge, undefined, true);
    return { conclusion };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof RegressionConclusionRejected) {
      await appendTaskTimeline(taskId, `通过结论的依据已失效：${message}`);
      return { conclusion: "verify_failed" };
    }
    await appendTaskTimeline(taskId, `验证依据暂不可核验，保留结论及审查轮次，恢复后可重试：${message}`);
    return null;
  }
}

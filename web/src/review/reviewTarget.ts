// 「打开审查格里的哪一条记录」：会话里那一句审查结论、工作流格里那一轮点过来时带的话。
//
// 轮号不是记录的身份：重新派审从第 1 轮数起，同一个任务可以有好几场「第 1 轮」；合并结果审查
// 压根没有轮号。所以一律带上来源（就地验证 / 自由派审 / 合并结果审查）和那一场的 id，接收
// 的那一格按这三样认。**认不出就不跳**：派审 / 合并结果审查缺了那一场的 id、或者这个任务的
// 审查格根本不装这一类记录（自由工作流的审查格不列就地验证），发送方就不给「去审查格」这条
// 路，在原处展开那一轮（见 reviewTargetLocatable）——绝不拿最近那一场顶上。
import type { InspectorRequest } from "../inspector/nav.tsx";

export type ReviewTargetSource = "inline" | "free" | "merge";

export type ReviewTarget = { source: ReviewTargetSource; runId: string | null; round: number | null };

export function reviewTargetRequest(target: ReviewTarget): InspectorRequest {
  return { source: target.source, runId: target.runId, round: target.round };
}

/**
 * 这个任务的审查格装得下哪几类记录——跟 task-detail/taskInspectors 挑哪一种审查格同一个判据：
 * 自由工作流是派审与合并结果审查（FreeReviewPane），其余是验证记录（TaskReviewInspector）。
 */
export function reviewPanelSources(workflowMode: string | null | undefined): ReadonlySet<ReviewTargetSource> {
  return workflowMode === "free" ? FREE_PANEL : INLINE_PANEL;
}
const FREE_PANEL: ReadonlySet<ReviewTargetSource> = new Set(["free", "merge"]);
const INLINE_PANEL: ReadonlySet<ReviewTargetSource> = new Set(["inline"]);

/** 点过去一定认得出是哪一条：审查格装这一类，而且身份齐（派审要那一场的 id，验证要轮号）。 */
export function reviewTargetLocatable(target: ReviewTarget, sources: ReadonlySet<ReviewTargetSource>): boolean {
  if (!sources.has(target.source)) return false;
  return target.source === "inline" ? target.round !== null : target.runId !== null;
}

export function reviewTargetOf(params: InspectorRequest): ReviewTarget {
  const source = params.source === "inline" || params.source === "merge" ? params.source : "free";
  return {
    source,
    runId: typeof params.runId === "string" && params.runId ? params.runId : null,
    round: typeof params.round === "number" ? params.round : null,
  };
}

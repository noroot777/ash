// 「打开审查格里的哪一条记录」：会话里那一句审查结论、工作流格里那一轮点过来时带的话。
//
// 轮号不是记录的身份：重新派审从第 1 轮数起，同一个任务可以有好几场「第 1 轮」；合并结果审查
// 压根没有轮号。所以一律带上来源（就地验证 / 自由派审 / 合并结果审查）和那一场的 id，接收
// 的那一格按这三样认，认不出 id（老时间线配不上 run）才退回「同来源里最近的那一场」。
import type { InspectorRequest } from "../inspector/nav.tsx";

export type ReviewTargetSource = "inline" | "free" | "merge";

export type ReviewTarget = { source: ReviewTargetSource; runId: string | null; round: number | null };

export function reviewTargetRequest(target: ReviewTarget): InspectorRequest {
  return { source: target.source, runId: target.runId, round: target.round };
}

export function reviewTargetOf(params: InspectorRequest): ReviewTarget {
  const source = params.source === "inline" || params.source === "merge" ? params.source : "free";
  return {
    source,
    runId: typeof params.runId === "string" && params.runId ? params.runId : null,
    round: typeof params.round === "number" ? params.round : null,
  };
}

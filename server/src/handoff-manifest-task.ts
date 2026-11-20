// 清单里任务那一段（HandoffManifest["task"]）怎么从任务行取。从 handoff.ts 的 exportHandoff 拆出来，
// 导入侧对应 handoff-import.ts 的 taskValues。
//
// 逐列列出来，不整行搬：执行器 id、分组、依赖、回合与方向身份这些只在本机有意义，不过网。任务行上新加的
// 列因此默认不随任务走——建议任务那两列就是这样漏掉过的（handoff-suggestions.ts）。导入侧有两条路：第一次
// 落到对端是新建任务行；移回是只覆盖清单带着的字段，老版本对端没带的那几列留着本机原来的值。
import type { tasks } from "./db/schema.js";
import { exportSuggestions } from "./handoff-suggestions.js";
import type { HandoffManifest } from "./handoff-types.js";
import { exportWaitOrigins } from "./handoff-wait.js";

export async function manifestTask(task: typeof tasks.$inferSelect): Promise<HandoffManifest["task"]> {
  return {
    id: task.id, title: task.title, body: task.body,
    status: task.status, stage: task.stage, labels: task.labels,
    agentType: task.agentType, model: task.model, reasoningEffort: task.reasoningEffort,
    autoTitle: task.autoTitle, useWorktree: task.useWorktree, worktreeBase: task.worktreeBase,
    worktreeStartCommit: task.worktreeStartCommit, worktreeBaseBranch: task.worktreeBaseBranch, mergeTargetBranch: task.mergeTargetBranch,
    baseTaskId: task.baseTaskId, acceptedSourceCommit: task.acceptedSourceCommit,
    creationOrigin: task.creationOrigin,
    workflow: task.workflow, workflowMode: task.workflowMode, workflowAt: task.workflowAt,
    reviewStep: task.reviewStep, verifyRounds: task.verifyRounds, verifyStationRounds: task.verifyStationRounds,
    verifyCompletedSteps: task.verifyCompletedSteps,
    resumePrompt: task.resumePrompt, resumePromptAuto: task.resumePromptAuto, question: task.question,
    waitOrigins: await exportWaitOrigins(task),
    questionOptions: task.questionOptions, questionItems: task.questionItems,
    questionHistory: task.questionHistory,
    ...await exportSuggestions(task),
    acceptedTargetBranch: task.acceptedTargetBranch,
    acceptedBaseCommit: task.acceptedBaseCommit,
    acceptedMergeCommit: task.acceptedMergeCommit,
    acceptedMergeMethod: task.acceptedMergeMethod,
    acceptedGateMode: task.acceptedGateMode as HandoffManifest["task"]["acceptedGateMode"],
    acceptedGateRunId: task.acceptedGateRunId, acceptanceId: task.acceptanceId,
    pinnedAt: task.pinnedAt,
    createdAt: task.createdAt, startedAt: task.startedAt, endedAt: task.endedAt,
  };
}

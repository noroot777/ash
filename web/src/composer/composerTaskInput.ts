// 新建面板「提交那一刻」要发给 POST /tasks 的那一份。新建出来的一律是普通任务（mode=single、自由工作流）：
// 团队、讨论不再是新建时选的模式，讨论是这条任务里 `@` 人开的一场（composerOpening.ts）。
// 从 TaskComposerPanel 拆出来纯粹是职责：面板管状态和门禁，这里只管把状态翻成请求体。
import type { ProjectView } from "@ash/shared";
import type { api } from "../lib/api.ts";
import type { ExecutorSelection } from "../lib/agentAvailability.ts";
import { forkTaskBody, type ConversationFork } from "../task-detail/conversationFork.ts";
import { provisionalTitle } from "@ash/shared/provisional-title";

type RunTarget = ExecutorSelection & { model: string | null; reasoningEffort: string | null };

export function composerTaskInput({
  project, body, fork, groupId, labels, attachments, useWorktree, base, run, prerequisites,
}: {
  project: ProjectView;
  body: string;
  fork: ConversationFork | undefined;
  groupId: string;
  labels: string[];
  attachments: string[];
  useWorktree: boolean;
  base: string;
  /** 胶囊上那个执行器：这条任务由它来跑（`@` 来的人只答第一句、或者跟它讨论，任务还是它的）。 */
  run: RunTarget;
  /**
   * 启动方式是「创建并等前置」时已选的前置。起点在起跑那一刻按前置定，所以不带 base；合入分支跟着前置走
   * （`mergeTargetBranch`，null = 不限制、照常按项目分支定）。
   */
  prerequisites?: { ids: string[]; mergeTargetBranch: string | null } | null;
}): Parameters<typeof api.createTask>[0] {
  const worktree = project.health.isRepo && useWorktree;
  return {
    projectId: project.id,
    title: provisionalTitle(body),
    autoTitle: true,
    groupId: groupId || null,
    labels,
    originTaskId: fork?.sourceTaskId,
    body: forkTaskBody(fork, body),
    attachments,
    mode: "single",
    useWorktree: worktree,
    worktreeBase: useWorktree && base && !prerequisites ? base : null,
    ...(prerequisites ? {
      prerequisites: prerequisites.ids,
      ...(worktree && prerequisites.mergeTargetBranch ? { mergeTargetBranch: prerequisites.mergeTargetBranch } : {}),
    } : {}),
    agentType: run.agentType,
    executorId: run.executorId,
    model: run.model,
    reasoningEffort: run.reasoningEffort,
    workflowMode: "free",
  };
}

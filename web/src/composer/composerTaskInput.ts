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
  project, body, fork, groupId, labels, attachments, useWorktree, base, run,
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
}): Parameters<typeof api.createTask>[0] {
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
    useWorktree: project.health.isRepo && useWorktree,
    worktreeBase: useWorktree && base ? base : null,
    agentType: run.agentType,
    executorId: run.executorId,
    model: run.model,
    reasoningEffort: run.reasoningEffort,
    workflowMode: "free",
  };
}

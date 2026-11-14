// 新建面板「提交那一刻」要发给 POST /tasks 的那一份：三种模式各一种形状。
// 从 TaskComposerPanel 拆出来纯粹是职责：面板管状态和门禁，这里只管把状态翻成请求体。
import { DUET_DEFAULTS } from "@ash/shared/duet";
import type { ProjectView, TaskMode } from "@ash/shared";
import type { api } from "../lib/api.ts";
import type { ExecutorSelection } from "../lib/agentAvailability.ts";
import { forkTaskBody, type ConversationFork } from "../task-detail/conversationFork.ts";
import { provisionalTitle } from "@ash/shared/provisional-title";
import type { ComposerExecutorConfigs } from "./executorOverrides.ts";

type RunTarget = ExecutorSelection & { model: string | null; reasoningEffort: string | null };

export function composerTaskInput({
  mode, project, body, fork, groupId, labels, attachments, rounds, gate, review, useWorktree, base,
  executors, lead, worker, reviewer, voiceA, voiceB, singleRun,
}: {
  mode: TaskMode;
  project: ProjectView;
  body: string;
  fork: ConversationFork | undefined;
  groupId: string;
  labels: string[];
  attachments: string[];
  rounds: string;
  gate: boolean;
  review: boolean;
  useWorktree: boolean;
  base: string;
  executors: ComposerExecutorConfigs;
  lead: ExecutorSelection;
  worker: ExecutorSelection;
  reviewer: ExecutorSelection;
  voiceA: ExecutorSelection;
  voiceB: ExecutorSelection;
  singleRun: RunTarget;
}): Parameters<typeof api.createTask>[0] {
  const text = forkTaskBody(fork, body);
  const common = {
    projectId: project.id,
    title: provisionalTitle(body, mode === "duet" ? "新建讨论" : undefined),
    autoTitle: mode === "single",
    groupId: groupId || null,
    labels,
    originTaskId: fork?.sourceTaskId,
    body: text,
    attachments,
    mode,
  };
  const workspace = {
    useWorktree: project.health.isRepo && useWorktree,
    worktreeBase: useWorktree && base ? base : null,
  };
  if (mode === "duet") {
    // 议题同时送 body 和 duet.topic：后端会把附件块分别拼在两者末尾（task-routes
    // 的 `row.body` / `scopedDuet`），于是讨论者的开场 prompt 和详情页顶部的「完整
    // 议题」看到的是同一份东西。只送 topic 的话，详情页那句 `task.body || topic`
    // 会拿到一段只剩附件路径、没有正文的 body。
    return {
      ...common,
      duet: {
        ...DUET_DEFAULTS,
        topic: text,
        voiceA: voiceA.agentType,
        voiceB: voiceB.agentType,
        voiceAExecutorId: voiceA.executorId,
        voiceBExecutorId: voiceB.executorId,
        voiceAModel: executors.voiceA.model || null,
        voiceAReasoningEffort: executors.voiceA.effort || null,
        voiceBModel: executors.voiceB.model || null,
        voiceBReasoningEffort: executors.voiceB.effort || null,
        maxRounds: rounds ? Math.max(1, Number(rounds) || 3) : null,
        gateG1: gate ? "on" : "off",
      },
    };
  }
  if (mode === "team") {
    return {
      ...common,
      ...workspace,
      agentType: lead.agentType,
      team: {
        lead: lead.agentType,
        worker: worker.agentType,
        leadExecutorId: lead.executorId,
        workerExecutorId: worker.executorId,
        leadModel: executors.lead.model || null,
        workerModel: executors.worker.model || null,
        leadReasoningEffort: executors.lead.effort || null,
        workerReasoningEffort: executors.worker.effort || null,
        review,
        reviewerAgentType: reviewer.agentType,
        reviewerExecutorId: reviewer.executorId,
        reviewerModel: executors.reviewer.model || null,
        reviewerReasoningEffort: executors.reviewer.effort || null,
      },
    };
  }
  return {
    ...common,
    ...workspace,
    agentType: singleRun.agentType,
    executorId: singleRun.executorId,
    model: singleRun.model,
    reasoningEffort: singleRun.reasoningEffort,
    workflowMode: "free",
  };
}

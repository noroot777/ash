import type { AgentType } from "./index.ts";

export const TASK_WORKFLOW_MODES = ["free", "preset"] as const;
export type TaskWorkflowMode = (typeof TASK_WORKFLOW_MODES)[number];

export const FREE_REVIEW_CHECK_MODES = ["syntax", "logic"] as const;
export type FreeReviewCheckMode = (typeof FREE_REVIEW_CHECK_MODES)[number];

// 审查链只落四个持久状态：reviewing 是唯一的「活」态（旁路审查回合正在跑），
// passed / failed 是链的终局，stopped 是「最后一轮未通过后停住」。
// 「修复中 / 等待复审 / 结论已过期」这些叙事一律**推导**，不落库：
// - 修复中 = 任务本身 running（谁发起的都一样）
// - 等待自动复审 = stopped + 预约槽里挂着 runId
// - 结论过期 = round.reviewedCommit ≠ 当前工作区 HEAD
export type FreeReviewRunStatus = "reviewing" | "passed" | "failed" | "stopped";
export type FreeReviewRoundStatus = "reviewing" | "passed" | "failed" | "error";

export interface ReviewerProfile {
  id: string;
  name: string;
  agentType: AgentType;
  executorId: string | null;
  executorLabel: string | null;
  model: string | null;
  reasoningEffort: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FreeReviewRound {
  round: number;
  status: FreeReviewRoundStatus;
  conclusion: "verified" | "verify_failed" | null;
  /** 本轮启动时任务工作区的 HEAD；与当前 HEAD 不一致即「结论陈旧」。null = 未能取到（老数据/工作区缺失）。 */
  reviewedCommit: string | null;
  reportMarkdown: string;
  screenshots: string[];
  startedAt: string;
  endedAt: string | null;
}

export interface FreeReviewRun {
  id: string;
  reviewerId: string | null;
  reviewerName: string;
  agentType: AgentType;
  executorId: string | null;
  executorLabel: string | null;
  model: string | null;
  reasoningEffort: string | null;
  checkMode: FreeReviewCheckMode;
  note: string | null;
  retryLimit: number;
  currentRound: number;
  status: FreeReviewRunStatus;
  rounds: FreeReviewRound[];
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface FreeWorkflowPreviewState {
  running: boolean;
  url: string | null;
  port: number | null;
  command: string | null;
  startedAt: string | null;
}

export type FreeWorkflowPreviewEventKind = "preview_opened" | "preview_closed";
export type FreeWorkflowPreviewEventSource = "user" | "merge" | "rerun" | "system";

export interface FreeWorkflowPreviewEvent {
  id: string;
  kind: FreeWorkflowPreviewEventKind;
  source: FreeWorkflowPreviewEventSource;
  detail: string | null;
  occurredAt: string;
}

export type FreeWorkflowExecutionStatus = "running" | "completed" | "failed" | "canceled" | "paused";

export interface FreeWorkflowExecution {
  id: string;
  status: FreeWorkflowExecutionStatus;
  startedAt: string;
  endedAt: string | null;
}

export interface FreeWorkflowState {
  taskId: string;
  selectedReviewerId: string | null;
  /** 服务端生成快照的单调时间戳。前端只接受更新的快照——「响应到达顺序」不是版本，
   *  早先生成、更晚到达的 mutation 响应不能盖掉后来 GET 拿到的新世界。 */
  stateVersion: number;
  /** 当前任务工作区 HEAD；null = 工作区不存在（如已验收清理）或不是 git 目录。 */
  workspaceHead: string | null;
  /** 工作区是否有未提交改动；null = 取不到（按未知处理，不能当干净）。 */
  workspaceDirty: boolean | null;
  reviewReservation: {
    armed: boolean;
    reviewerId: string | null;
    checkMode: FreeReviewCheckMode | null;
    retryLimit: number | null;
    note: string | null;
    /** 非空 = 这是自动复审链的续轮预约（修复确认完成后在该 run 上续下一轮）。 */
    runId: string | null;
  };
  preview: FreeWorkflowPreviewState;
  previewEvents: FreeWorkflowPreviewEvent[];
  executions: FreeWorkflowExecution[];
  reviews: FreeReviewRun[];
}

export interface FreeReviewDispatchInput {
  reviewerId: string;
  checkMode: FreeReviewCheckMode;
  retryLimit: number;
  note?: string | null;
}

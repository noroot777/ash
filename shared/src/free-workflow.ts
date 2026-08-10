import type { AgentType } from "./index.ts";

export const TASK_WORKFLOW_MODES = ["free", "preset"] as const;
export type TaskWorkflowMode = (typeof TASK_WORKFLOW_MODES)[number];

export const FREE_REVIEW_CHECK_MODES = ["syntax", "logic"] as const;
export type FreeReviewCheckMode = (typeof FREE_REVIEW_CHECK_MODES)[number];

export type FreeReviewRunStatus = "reviewing" | "repairing" | "passed" | "exhausted" | "failed";
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

export interface FreeWorkflowMergeState {
  status: "idle" | "merging" | "merged" | "failed";
  message: string | null;
  mergedAt: string | null;
  updatedAt: string | null;
}

export interface FreeWorkflowState {
  taskId: string;
  selectedReviewerId: string | null;
  reviewReservation: {
    armed: boolean;
    reviewerId: string | null;
    checkMode: FreeReviewCheckMode | null;
    retryLimit: number | null;
  };
  preview: FreeWorkflowPreviewState;
  previewEvents: FreeWorkflowPreviewEvent[];
  executions: FreeWorkflowExecution[];
  merge: FreeWorkflowMergeState;
  reviews: FreeReviewRun[];
}

export interface FreeReviewDispatchInput {
  reviewerId: string;
  checkMode: FreeReviewCheckMode;
  retryLimit: number;
}

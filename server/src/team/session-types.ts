import type { Writable } from "node:stream";
import type { AgentType } from "@ash/shared";
import type { ResidentHandle, ResumeFields } from "../executors/types.js";
import type { PendingInbound } from "./inbound-queue.js";

export interface Lead {
  taskId: string;
  sessId: string;
  cliSessionId: string;
  agentType: AgentType;
  /** 这台调度台跑的是谁的活(多人模式)。技能扫描与环境注入按它走。 */
  ownerUserId: string | null;
  executorId: string | null;
  model: string | null;
  reasoningEffort: string | null;
  cwd: string;
  handle: ResidentHandle;
  out: Writable;
  busy: boolean;
  turnStart: string | null;
  pending: PendingInbound[];
  notices: { text: string; at: string }[];
  pendingCredential: ({ cliSessionId: string } & ResumeFields) | null;
  wantedStatus: "running" | "idle" | null;
  statusTimer: NodeJS.Timeout | null;
  retired: boolean;
  idleTimer: NodeJS.Timeout | null;
  closing: "recycle" | "halt" | "workspace" | null;
  closingSaidRotated?: boolean;
}

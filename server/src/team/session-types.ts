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
  /** 投递串行链(见 session-consumer.ts 的 sendToLead):保证同一台的 send 按调用顺序落地。 */
  sending?: Promise<void>;
  turnStart: string | null;
  /**
   * 这台**此刻持有**的回合身份（`started_at` 的集合）。只由 `lead-turns.ts` 读写,别处不碰。
   *
   * 为什么不能只靠上面那个 `turnStart`：它是个会被下一轮直接覆盖的字段（用户插话会在上一轮
   * 还开着时就起新一轮），覆盖掉的那个起点于是永远没人注销 —— 读端把它当成「这条会话一直
   * 在写」，待命期间别人做的东西全算进这台的产物（第 8 轮审查必须修 1）。可选是因为构造点
   * 散在生产与多份回归夹具里,集合由所有权层按需建；判据不靠这个字段在不在,靠
   * `holdTurn`/`releaseHeldTurns` 成对。
   */
  held?: Set<string>;
  pending: PendingInbound[];
  notices: { text: string; at: string; level?: "notice" }[];
  pendingCredential: ({ cliSessionId: string } & ResumeFields) | null;
  wantedStatus: "running" | "idle" | null;
  statusTimer: NodeJS.Timeout | null;
  retired: boolean;
  idleTimer: NodeJS.Timeout | null;
  closing: "recycle" | "halt" | "workspace" | null;
  closingSaidRotated?: boolean;
}

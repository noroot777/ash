import type { UnexecutedVerification } from "@navi/shared/workflow-policy";
import type { AcceptanceAutoCommitOutcome } from "@navi/shared/accept-workspace";
import type { AcceptFailure, AcceptWarning } from "./task-accept-guard.js";
import type { AcceptTail } from "./task-accept-tail.js";
import type { PushOutcome } from "./task-accept-push.js";

export type AcceptSuccess = {
  accepted: true;
  taskId: string;
  status: string;
  /** 中途关口放行不是验收，stage 会被清回「进行中」，所以这里可能是 null */
  stage: "accepted" | null;
  kind: "already_accepted" | "in_place" | "isolated_worktree" | "marked_only" | "gate_released";
  sharedWorkersAccepted?: number;
  targetBranch?: string;
  merge?: string;
  /** 「只打标签不合并」那一档打下的标签名 */
  tag?: string;
  worktreePath?: string;
  worktreeRemoved?: boolean;
  branch?: string;
  branchDeleted?: boolean;
  warnings?: AcceptWarning[];
  verification?: UnexecutedVerification;
  /**
   * 「点头之后」那一段（发布脚本之类）跑得怎么样。线上没写这一段就没有这个字段。
   *
   * 它**不影响 accepted**：合并和清理已经真的做完了，改回 accepted:false 等于谎报另一头。
   * 但也不能不说 —— 一个挂掉的发布脚本被吞成「验收成功」，用户下一次知道是在线上出事
   * 的时候。所以合并的结论和尾段的结论分开报，各说各的。
   */
  tail?: AcceptTail;
  /** 这一按选了推送到远程：推没推上去（推不上去不改 accepted，见 task-accept-push.ts）。 */
  push?: PushOutcome;
};

export type AcceptTaskResult = (AcceptSuccess | AcceptFailure) & { autoCommit?: AcceptanceAutoCommitOutcome };

import type { AgentType } from "./index.ts";
import type { PreviewServiceState } from "./preview.ts";

export const TASK_WORKFLOW_MODES = ["free", "preset"] as const;
export type TaskWorkflowMode = (typeof TASK_WORKFLOW_MODES)[number];

/**
 * 「这个建任务请求容得下自由工作流吗」——**建任务路由的门禁与默认值共用同一份判据**。
 *
 * 自由工作流只适用于普通单任务：团队/讨论任务、派生执行者（`parentId`）、审查任务
 * （`reviewOf`）各自有自己的编排，自带起手式（`workflow`/`workflowId`）的请求则是明摆着
 * 要走预设那条线。这几种传 `workflowMode: "free"` 一律 409/400。
 *
 * 之所以要把它抽成一个函数：默认值现在按它推导（没显式说就是「配得上就给 free」）。
 * 判据但凡和门禁差一个字，老调用方就会在自己什么都没改的情况下凭空吃 409——它们
 * 压根不知道有 `workflowMode` 这个字段。两处各写一份，早晚漂。
 */
export function freeWorkflowFits(req: {
  mode?: string | null;
  parentId?: string | null;
  reviewOf?: string | null;
  workflow?: unknown;
  workflowId?: string | null;
}): boolean {
  return (req.mode ?? "single") === "single"
    && req.parentId == null
    && req.reviewOf == null
    && req.workflow == null
    && req.workflowId == null;
}

export const FREE_REVIEW_CHECK_MODES = ["syntax", "logic"] as const;
export type FreeReviewCheckMode = (typeof FREE_REVIEW_CHECK_MODES)[number];

/**
 * 「失败后自动复审」允许的最大次数（这条链最多跑 `retryLimit + 1` 轮）。
 * 派审面让用户直接填数字，前端的输入门禁和后端的入参校验必须是同一个上限——
 * 各写一份的话，界面放行的值会在提交那一刻被后端打回。
 */
export const MAX_FREE_REVIEW_RETRIES = 20;

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

/**
 * 「这一次审查实际用谁跑」——相对审查者配置的整套覆盖，**不写回审查者本身**。
 *
 * 是整套而不是单个字段：选执行器的形状是一颗三段胶囊（智能体 · 模型 · 智能水平），
 * 换智能体会把后两段打回「跟随执行器」，拆成可选字段就没法表达「这次显式跟随」。
 * null/空 = 跟随该执行器自己的默认，与审查者配置里的同名字段语义一致。
 */
export interface FreeReviewExecutorOverride {
  agentType: AgentType;
  executorId: string | null;
  model: string | null;
  reasoningEffort: string | null;
}

/**
 * 「驳回」这条支线的三个概念，**不共用一个状态字段**：
 * - `FreeReviewDispute`：执行者不认某一轮未通过结论（`dispute_review`），链停下来等用户裁定。
 * - `FreeReviewDebate`：用户看过驳回后让双方各自陈词的那几个旁路回合。
 * - `resolution`：**用户**的裁定。审查者在辩论收尾时给的 `verdict` 只是它自己的立场，
 *   两者分开存 —— 让被驳回的一方替用户签字，等于绕过用户裁定这件事本身。
 */
export type FreeReviewDisputeResolution =
  /** 维持审查意见：照报告修 */
  | "upheld"
  /** 采纳执行者：这条未通过意见作废，报告与证据原样留着 */
  | "withdrawn"
  /**
   * 转独立任务：意见**成立**，但不属于本任务边界（多半是本轮修复自己引入的衍生问题）。
   * 建一个 backlog 派生任务把它带走，本轮不再要求在本任务里修；报告与证据同样原样留着。
   *
   * 与 `withdrawn` 的差别只有一处——**这条意见没有作废，只是换了个地方修**。所以它不是
   * 「不想改」的第三种说法：必须由执行者先在 `deferReason` 里逐条写明越界/衍生的依据
   * （没写时服务端拒绝这个裁定），再由用户签字。
   */
  | "deferred";

/** 辩论收尾时**审查者自述**的立场（不是用户裁定，不自动改变任何状态）。 */
export type FreeReviewDebateVerdict = "upheld" | "withdrawn" | "partial";

export type FreeReviewDebateSide = "reviewer" | "executor";
export type FreeReviewDebateStatus = "running" | "finished" | "failed";
export type FreeReviewDebateTurnStatus = "speaking" | "done" | "error";

/** 一次辩论最多几个来回（一个来回 = 审查者答辩 + 执行者回应）。 */
export const MAX_FREE_REVIEW_DEBATE_EXCHANGES = 3;

export interface FreeReviewDebateTurn {
  seq: number;
  side: FreeReviewDebateSide;
  /** 这一段发言正文；还没交卷（speaking/error）时为空串。 */
  statement: string;
  status: FreeReviewDebateTurnStatus;
  startedAt: string;
  endedAt: string | null;
}

export interface FreeReviewDebate {
  id: string;
  status: FreeReviewDebateStatus;
  /** 用户选的来回数；总发言段数 = exchanges * 2 + 1（末尾多一段审查者收尾）。 */
  exchanges: number;
  /** 正在发言的一方；辩论已结束为 null。 */
  currentSide: FreeReviewDebateSide | null;
  verdict: FreeReviewDebateVerdict | null;
  turns: FreeReviewDebateTurn[];
  startedAt: string;
  finishedAt: string | null;
}

export interface FreeReviewDispute {
  /** 执行者写的「哪几条不成立 / 哪几条是知情且有意为之」；空串 = 它只提了转出那几条。 */
  reason: string;
  /**
   * 执行者写的「哪几条我认可、但超出本任务边界，建议转独立任务」；null = 没提过。
   *
   * 与 `reason` 分开存而不是挤进同一段文本：界面要据此决定「转为独立任务」那个出口
   * 给不给，服务端也要据此拒绝凭空的 `deferred` 裁定——靠在自由文本里找关键词判断，
   * 等于把一条裁定门禁交给措辞去守。
   */
  deferReason: string | null;
  at: string;
  /** 用户的裁定；null = 还在等用户。 */
  resolution: FreeReviewDisputeResolution | null;
  resolvedAt: string | null;
  /** `deferred` 裁定后建出的那个 backlog 派生任务；其它裁定恒为 null。 */
  deferredTaskId: string | null;
  /** 这一条驳回上开过的辩论，按开始时间排；空数组 = 还没辩过。中断过的可以重开，
   *  所以同一条驳回上可能有多条（辩完的那条会挡住再开，判据在服务端）。 */
  debates: FreeReviewDebate[];
}

export interface FreeReviewRound {
  round: number;
  status: FreeReviewRoundStatus;
  conclusion: "verified" | "verify_failed" | null;
  /** 本轮启动时任务工作区的 HEAD；与当前 HEAD 不一致即「结论陈旧」。null = 未能取到（老数据/工作区缺失）。 */
  reviewedCommit: string | null;
  reportMarkdown: string;
  screenshots: string[];
  /** 执行者对这一轮结论的驳回；null = 没驳回过（绝大多数轮次）。 */
  dispute: FreeReviewDispute | null;
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
  /** 省略视为老数据的任务工作区审查。 */
  target?:
    | { kind: "workspace" }
    | {
        kind: "accepted_merge";
        branch: string;
        baseCommit: string;
        mergeCommit: string;
        repairTaskId: string | null;
      };
  retryLimit: number;
  currentRound: number;
  status: FreeReviewRunStatus;
  rounds: FreeReviewRound[];
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface FreeWorkflowPreviewState {
  gen?: string | null;
  services?: PreviewServiceState[];
  proxied?: boolean;
  /** 起来了**或者正在起**。界面拿它决定那颗开关是「打开预览」还是「关掉」。 */
  running: boolean;
  /**
   * 还在启动（装依赖 / 等就绪）。这一段能长到八分钟，期间没有 url、也随时可以被收掉，
   * 所以它跟「起来了」必须分得开：文案要说「正在启动…（点这里取消）」而不是「关闭预览」，
   * 「预览页」那个链接也不能给。
   */
  starting: boolean;
  // 这个任务盘上有没有预览启动日志。跟 running 是两件事：**起失败的那次也留着日志**，
  // 而那一次恰恰最需要看 —— 只按 running 给入口，用户永远看不到失败现场。
  hasLog: boolean;
  url: string | null;
  port: number | null;
  command: string | null;
  startedAt: string | null;
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
    /** 非空 = 本次预约要用的执行器覆盖（审查者配置没被改，只有这一次这么跑）。 */
    override: FreeReviewExecutorOverride | null;
    /** 非空 = 这是自动复审链的续轮预约（修复回合正常结束后在该 run 上续下一轮）。 */
    runId: string | null;
  };
  /**
   * 此刻在跑的是**审查/验证旁路回合**（只读工作区、写报告、给结论，不产出新一版代码）。
   *
   * 界面拿它给预览类动作开门：「任务在跑 = 代码改到一半，预览没有意义」这条对旁路回合
   * 不成立——审查那十几分钟恰恰是最想自己打开页面看一眼的时候。判据取服务端的运行时
   * 事实（turn 的 role），不是「库里有没有 reviewing run」，理由见 server/review-turn.ts。
   */
  reviewTurn: boolean;
  /** 预览是「随手开一眼」的看片器，不是工作流里的一步：只报当下开没开，不留开关历史。 */
  preview: FreeWorkflowPreviewState;
  executions: FreeWorkflowExecution[];
  reviews: FreeReviewRun[];
}

export interface FreeReviewDispatchInput {
  reviewerId: string;
  checkMode: FreeReviewCheckMode;
  retryLimit: number;
  note?: string | null;
  /** 本次审查的执行器覆盖；缺省/null = 就按审查者自己的配置跑。 */
  override?: FreeReviewExecutorOverride | null;
}

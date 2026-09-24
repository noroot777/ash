// 自由工作流那一族表：工作流状态与事件、审查链(run/round)、以及一条驳回上开的辩论。
//
// 从 schema.ts 拆出来的理由和 schema-multiuser / schema-chat 一样——那份文件已越过 700 行
// 上限,而这一族是其中边界最清楚的一块:只被自由工作流那几个模块用到,其余表都不引用它。
// **整份仍由 schema.ts 原样再导出**:drizzle 的 `import * as schema` 必须看到全部表,
// 拆文件不能拆掉那个视图。
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const freeWorkflowStates = sqliteTable("free_workflow_states", {
  taskId: text("task_id").primaryKey(),
  selectedReviewerId: text("selected_reviewer_id"),
  reviewArmed: integer("review_armed", { mode: "boolean" }).notNull().default(false),
  reviewCheckMode: text("review_check_mode"),
  reviewRetryLimit: integer("review_retry_limit"),
  reviewNote: text("review_note"),
  // 预约要用的执行器覆盖（相对审查者配置，只作用于这一次）。四列一起写、一起清：
  // 智能体换了、模型/智能水平就得跟着重来，拆开写会拼出审查者从未有过的组合。
  // agent_type 为空 = 没有覆盖，照审查者自己的配置跑。
  reviewAgentType: text("review_agent_type"),
  reviewExecutorId: text("review_executor_id"),
  reviewModel: text("review_model"),
  reviewReasoningEffort: text("review_reasoning_effort"),
  // 非空 = 自动复审链的续轮预约：修复确认完成后在这条 run 上续下一轮，而不是开新 run。
  reviewRunId: text("review_run_id"),
  updatedAt: text("updated_at").notNull(),
});

export const freeWorkflowEvents = sqliteTable(
  "free_workflow_events",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    detail: text("detail"),
    occurredAt: text("occurred_at").notNull(),
  },
  (t) => ({ taskIdx: index("free_workflow_events_task_idx").on(t.taskId, t.occurredAt) }),
);

export const freeReviewRuns = sqliteTable(
  "free_review_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    reviewerId: text("reviewer_id"),
    reviewerName: text("reviewer_name").notNull(),
    agentType: text("agent_type").notNull(),
    executorId: text("executor_id"),
    model: text("model"),
    reasoningEffort: text("reasoning_effort"),
    checkMode: text("check_mode").notNull(),
    note: text("note"),
    // workspace = 验收前任务工作区；accepted_merge = 验收时冻结的目标分支 commit 区间。
    targetKind: text("target_kind").notNull().default("workspace"),
    targetBranch: text("target_branch"),
    targetBaseCommit: text("target_base_commit"),
    targetCommit: text("target_commit"),
    // 合并结果审查未通过后创建的独立修复任务；非空即幂等返回同一任务。
    repairTaskId: text("repair_task_id"),
    retryLimit: integer("retry_limit").notNull().default(1),
    currentRound: integer("current_round").notNull().default(1),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (t) => ({ taskIdx: index("free_review_runs_task_idx").on(t.taskId, t.createdAt) }),
);

export const freeReviewRounds = sqliteTable(
  "free_review_rounds",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    round: integer("round").notNull(),
    status: text("status").notNull(),
    conclusion: text("conclusion"),
    // 本轮启动时任务工作区的 HEAD。结论新不新鲜靠它跟当前 HEAD 比，不靠状态字段。
    reviewedCommit: text("reviewed_commit"),
    // 执行者对这一轮结论的驳回：理由正文 + 时刻。非空 = 这一轮没被执行者认下。
    disputeReason: text("dispute_reason"),
    // 同一次驳回里「我认可这几条，但它们超出本任务边界，建议转独立任务」那一段。
    // 与 dispute_reason 分开存：界面据它决定给不给「转为独立任务」那个出口，服务端
    // 据它拒绝凭空的 deferred 裁定——两段揉进一个字段就只能靠在文本里找关键词。
    // 两列**至少有一列非空** = 这一轮挂着一条驳回（CAS 与 openDisputeOf 都按这个判）。
    disputeDeferReason: text("dispute_defer_reason"),
    disputeAt: text("dispute_at"),
    // **用户**的裁定（upheld=维持审查意见 / withdrawn=采纳执行者 / deferred=转独立任务），
    // 与辩论里审查者自述的 verdict 分开存：让被驳回的一方替用户签字，等于绕过裁定这件事本身。
    disputeResolution: text("dispute_resolution"),
    disputeResolvedAt: text("dispute_resolved_at"),
    // deferred 裁定建出的那个 backlog 派生任务；非空即幂等返回同一任务（同 repair_task_id）。
    disputeDeferredTaskId: text("dispute_deferred_task_id"),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
  },
  (t) => ({ runRoundIdx: uniqueIndex("free_review_rounds_run_round_idx").on(t.runId, t.round) }),
);

// 一条驳回上开的辩论。一轮审查至多一条（`round_id` 唯一）：用户再想让双方说一次，
// 得先裁定这一条 —— 否则同一份报告会挂着两条互相矛盾的辩论记录。
export const freeReviewDebates = sqliteTable(
  "free_review_debates",
  {
    id: text("id").primaryKey(),
    roundId: text("round_id").notNull(),
    taskId: text("task_id").notNull(),
    runId: text("run_id").notNull(),
    round: integer("round").notNull(),
    status: text("status").notNull(),
    /** 来回数；总发言段数 = exchanges * 2 + 1（末尾多一段审查者收尾）。 */
    exchanges: integer("exchanges").notNull().default(1),
    /** 正在发言的是第几段；结束后停在最后一段的序号。 */
    currentSeq: integer("current_seq").notNull().default(1),
    verdict: text("verdict"),
    startedAt: text("started_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (t) => ({
    // 一轮意见可以留多条辩论记录：辩完的那条挡着再辩，中断的允许重开（判据在
    // free-review-debate.ts，不靠唯一索引表达）。
    roundIdx: index("free_review_debates_round_idx").on(t.roundId, t.startedAt),
    taskIdx: index("free_review_debates_task_idx").on(t.taskId, t.startedAt),
  }),
);

export const freeReviewDebateTurns = sqliteTable(
  "free_review_debate_turns",
  {
    id: text("id").primaryKey(),
    debateId: text("debate_id").notNull(),
    seq: integer("seq").notNull(),
    side: text("side").notNull(),
    // 发言正文由 `debate_reply` 直接落库（不走证据目录）：它是对话，不是证据文件，
    // 而且必须能在「这一段到底交卷没有」上给出确定答案 —— 文件存不存在答不了这个。
    statement: text("statement"),
    status: text("status").notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
  },
  (t) => ({ debateSeqIdx: uniqueIndex("free_review_debate_turns_seq_idx").on(t.debateId, t.seq) }),
);

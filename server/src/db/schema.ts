import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// JSON columns are stored as text and parsed in the repository layer.
// Schema mirrors shared/src/index.ts.

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  repoPath: text("repo_path").notNull(),
  apiKeys: text("api_keys"), // legacy project-level credentials, kept for compatibility
  // 本项目新建任务默认用哪条起手式（workflows.id 或内置 key）。空 = 跟随全局默认。
  workflowId: text("workflow_id"),
  createdAt: text("created_at").notNull(),
});

// Generic global settings store. Values are JSON-encoded text; the typed
// read/write boundary lives in app-settings.ts so future settings can reuse the
// same table without another schema change.
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// 外部 CLI 报“会话累计值”时的最后一份原始快照。它独立于 sessions：同一个 CLI
// 会话可能跨多个 harness 行（例如讨论模式），按 source_id 才能正确算本轮差值。
export const usageCumulativeSnapshots = sqliteTable("usage_cumulative_snapshots", {
  sourceId: text("source_id").primaryKey(),
  input: integer("input_tokens").notNull(),
  output: integer("output_tokens").notNull(),
  cacheRead: integer("cache_read_tokens").notNull(),
  cacheWrite: integer("cache_write_tokens").notNull(),
  reasoning: integer("reasoning_tokens").notNull(),
  costUsd: real("cost_usd"),
  // false = 旧 trace 不完整，拿不到上一份累计值。下一次上报只建立基线、不入 token 账。
  baselineReady: integer("baseline_ready", { mode: "boolean" }).notNull().default(true),
  updatedAt: text("updated_at").notNull(),
});

export const notes = sqliteTable("notes", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  body: text("body").notNull(),
  attachments: text("attachments"), // json string[]
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// 一条随手记可以反复转成多个任务。独立关联表既保留完整历史，也让同一任务幂等去重；
// created_at 是转换发生时间，详情页按它倒序展示。
export const noteTasks = sqliteTable(
  "note_tasks",
  {
    noteId: text("note_id").notNull(),
    taskId: text("task_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    noteTaskIdx: uniqueIndex("note_tasks_note_task_idx").on(t.noteId, t.taskId),
    taskIdx: index("note_tasks_task_idx").on(t.taskId),
  }),
);

export const groups = sqliteTable("groups", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  name: text("name").notNull(),
  mode: text("mode").notNull().default("parallel"), // parallel | serial
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  // 内部组：非空 = 这个组由某个团队任务(mode:"team")派活时自动创建，成员都是它的
  // 执行者。分组管理界面按此过滤掉（见 §Team）。
  ownerTaskId: text("owner_task_id"),
  createdAt: text("created_at").notNull(),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  groupId: text("group_id"),
  parentId: text("parent_id"),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  mode: text("mode").notNull().default("single"), // single | duet | team
  status: text("status").notNull().default("backlog"),
  stage: text("stage"), // 正交验收阶段；不参与 status 调度/结算语义
  pinnedAt: integer("pinned_at"), // null=未置顶；多个置顶任务按时间戳排序
  reviewOf: text("review_of"), // 审查任务 → 被审任务 id；普通任务为 null
  reviewRound: integer("review_round"), // 审查任务针对该目标的轮次（从 1 开始）
  // 就地验证：验证轮不再另起一个任务，而是在这个任务自己身上多跑一个旁路回合。
  // verify_round 非空 = 此刻正在跑第几轮验证（结算时清空）；verify_rounds = 已经跑完几轮。
  verifyRound: integer("verify_round"),
  verifyRounds: integer("verify_rounds").notNull().default(0),
  // 这一站（review_step）已经就地验过几轮。轮数上限按站算，而就地验证轮没有独立任务
  // 行可数，所以自己记一个：开新一轮时发现换站了就归零。
  verifyStationRounds: integer("verify_station_rounds").notNull().default(0),
  // 验的是线上**哪一站**「自动验证」（WorkflowStep.id）。一条线可以写不止一站，
  // 轮数上限得按站分开数，否则第一站用掉的轮次会算到第二站头上。老数据为 null =
  // 线上第一站。历史那批独立审查任务把它记在自己身上，就地验证轮记在被验任务身上。
  reviewStep: text("review_step"),
  reviewRequested: integer("review_requested", { mode: "boolean" }).notNull().default(false),
  labels: text("labels").notNull().default("[]"), // json
  dependsOn: text("depends_on").notNull().default("[]"), // json
  resumeDependsOn: text("resume_depends_on").notNull().default("[]"), // json
  agentType: text("agent_type"),
  executorId: text("executor_id"), // agents.id；非空时优先使用具体执行器，空则按 agentType 默认降级
  model: text("model"), // null=跟随执行器 profile；非空=任务级覆盖
  reasoningEffort: text("reasoning_effort"), // null=跟随执行器 profile；非空=任务级覆盖
  autoTitle: integer("auto_title", { mode: "boolean" }).notNull().default(false),
  duet: text("duet"), // json DuetConfig
  team: text("team"), // json TeamConfig（mode:"team" 的调度者/默认执行者类型）
  // 执行者旗标：done 时是否汇报给调度者（dispatch 时逐个指定）。
  reportBack: integer("report_back", { mode: "boolean" }).notNull().default(false),
  scheduleId: text("schedule_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  startedAt: text("started_at"), // first time the task entered `running`
  endedAt: text("ended_at"), // last terminal transition (cleared while running)
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  archivedAt: text("archived_at"), // when it was archived (orders the archive view)
  // Opt-in per-task worktree. true → orchestrator builds <repoPath>/.worktrees/<id>
  // on branch `harness/<id8>` based off `worktreeBase` (null = current HEAD) before
  // running. False / missing repo → behaves like before (runs in repoPath).
  useWorktree: integer("use_worktree", { mode: "boolean" }).notNull().default(false),
  // 这个任务当初挑的那条线，**创建时拷进来的快照**（json WorkflowDef）。之后改起手式
  // 库不会追着改它 —— 「起手式」不是「模板引用」。空 = 老任务，走旧的写死流程。
  workflow: text("workflow"),
  workflowMode: text("workflow_mode").notNull().default("preset"), // preset | free
  // 这条线此刻停在哪一站（WorkflowStep.id，只会是锚点站：干活 / 自动验证 / 等我点头）。
  // 执行链靠它把「某一轮审查有了结论」「用户点了头」落回**具体那一站**，于是同一类站
  // 可以在一条线上出现多次。空 = 还没走到任何锚点，或者老任务——调用方一律回落到线上
  // 第一个同类锚点（shared 的 anchorAt），所以它丢了也只是退化成老行为，不会卡死。
  workflowAt: text("workflow_at"),
  worktreeBase: text("worktree_base"),
  originTaskId: text("origin_task_id"), // 回链来源任务(null = 直接创建)
  // 检查点续跑：agent 调 pause_task 时填进来；下次 resume 时取出喂给 CLI 会话并清空。
  resumePrompt: text("resume_prompt"),
  // 提问：agent 调 ask_question 时填进来。结算落 paused 且队列不自动续跑，
  // 等 answer_question 清空并带答复 resume（见 scheduler.pickNextLaunchable 的挡板）。
  question: text("question"),
  // 提问的候选答案（json string[]）：ask_question 可选地附几个候选，网页在问题下方
  // 渲染成可点按钮（点一下 = 以该选项原文当答复送出，走的还是同一个 /answer）。
  // null/[] = 纯自由作答。答复时与 question 一起清空。
  questionOptions: text("question_options"),
  // 多问题提问（json {question, options?}[]）：question 字段保留为引言/背景，
  // 每个 item 在网页上有独立输入框和候选快捷填充。null/[] = 老式单问题。
  questionItems: text("question_items"),
  // 续聊（follow-up）：任务已经到终态后用户又发消息，这一轮不是「任务的执行」而是
  // 任务之后的对话。开跑时把续聊前的终态记在这里（done/failed/canceled），队列一律
  // 按它看待该成员（既不挡后面的，也不会被当 backlog 拉起），结算后清空。
  followUpFrom: text("follow_up_from"),
  // 完成确认（严格 done 协议）：agent 调 complete_task 时盖时间戳，settle 消费后清空。
  // 落库而不只放内存 —— 确认与结算若不在同一个进程里（历史事故：僵尸实例跑任务、
  // HTTP 打到监听进程），内存标记会静默丢掉，agent 明明确认了却记 failed。
  completeConfirmedAt: text("complete_confirmed_at"),
  // 统一验收合并的结构化落账：目标分支 + 合并前后它的 commit。合并后基线审查（对
  // base@before..after 派新任务）靠它，时间线文本反解不可靠。无合并动作（in_place /
  // marked_only / 打标签）时保持 null 或 before==after。
  acceptedTargetBranch: text("accepted_target_branch"),
  acceptedBaseCommit: text("accepted_base_commit"),
  acceptedMergeCommit: text("accepted_merge_commit"),
});

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  target: text("target").notNull().default('{"kind":"local"}'), // json ExecTarget
  model: text("model"),
  extraArgs: text("extra_args").notNull().default("[]"), // json
  reasoningEffort: text("reasoning_effort"), // null=跟随 CLI 默认
  speed: text("speed"), // null=标准；"fast"=1.5x 加速档
  // 挂载的供应商(llm_providers.id)。null=用 CLI 自己的官方登录账号。
  // 非空时启动 CLI 前注入 base_url + key(claude: env;codex: -c model_providers)。
  providerId: text("provider_id"),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
});

// Global team-creation shortcuts. config stores only the configurable TeamConfig
// fields; executor labels are resolved at read time so stale ids degrade cleanly.
export const teamPresets = sqliteTable("team_presets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  config: text("config").notNull(), // json TeamPresetConfig (without display labels)
  createdAt: text("created_at").notNull(),
});

// 起手式库。系统自带的那几条**没有种子行**：builtin_key 非空的行 = 用户对某条
// 自带起手式的覆写，删掉这行就回到 shared/workflow-presets.ts 里的出厂定义。
// 用户自建的行 builtin_key 为空。disabled 只对自带的有意义（自带的删不掉，只能停用）。
export const workflows = sqliteTable(
  "workflows",
  {
    id: text("id").primaryKey(),
    builtinKey: text("builtin_key"), // 非空 = 覆写某条系统自带的
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    def: text("def").notNull(), // json WorkflowDef
    disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({ builtinIdx: uniqueIndex("workflows_builtin_idx").on(t.builtinKey) }),
);

export const reviewerProfiles = sqliteTable("reviewer_profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  agentType: text("agent_type").notNull(),
  executorId: text("executor_id"),
  model: text("model"),
  reasoningEffort: text("reasoning_effort"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const freeWorkflowStates = sqliteTable("free_workflow_states", {
  taskId: text("task_id").primaryKey(),
  selectedReviewerId: text("selected_reviewer_id"),
  reviewArmed: integer("review_armed", { mode: "boolean" }).notNull().default(false),
  reviewCheckMode: text("review_check_mode"),
  reviewRetryLimit: integer("review_retry_limit"),
  reviewNote: text("review_note"),
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
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
  },
  (t) => ({ runRoundIdx: uniqueIndex("free_review_rounds_run_round_idx").on(t.runId, t.round) }),
);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  role: text("role").notNull(),
  agentType: text("agent_type").notNull(),
  executor: text("executor").notNull(),
  target: text("target").notNull(),
  worktreePath: text("worktree_path"),
  branch: text("branch"),
  cwd: text("cwd"),
  cliSessionId: text("cli_session_id"),
  resumeCommand: text("resume_command"),
  // 本次运行挂的供应商在恢复命令里要带的 env 前缀(token 已是占位符)。
  // null = 走 CLI 官方账号。只用于展示,不含真 key。
  relayEnv: text("relay_env"),
  commandLine: text("command_line"),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"), // when this run finished (set with exit_status)
  exitStatus: integer("exit_status"),
  // Execution-time accounting. active_ms accumulates each turn's active span
  // [prompt sent → turn done], so idle waits between turns are excluded;
  // turn_started_at marks the current/last turn's start (set when a turn begins,
  // ended_at cleared on resume). Both null on rows created before these columns
  // existed → that task reads as historical/unmeasured and surfaces show its
  // lifespan instead of a (wrong) execution time.
  activeMs: integer("active_ms"),
  turnStartedAt: text("turn_started_at"),
  // ── 解绑重启（executors/detached.ts）────────────────────────────────────
  // 单飞任务的 agent 输出走文件而不是匿名管道，所以它活得过 server 重启。
  // 下面这组是重启后接管它所需的全部线索；常驻会话（团队调度台）不走这条路，
  // 这几列对它恒为 null——它靠 cli_session_id 的 --resume 自动接回。
  agentPid: integer("agent_pid"),
  // ps 的 lstart 原文。**必须跟 pid 一起比**：pid 会被复用，光 kill(pid,0)
  // 只能证明「有个进程叫这个号」，不能证明还是当初那个 agent。
  agentStartedAt: text("agent_started_at"),
  agentOutPath: text("agent_out_path"),
  agentErrPath: text("agent_err_path"),
  agentRcPath: text("agent_rc_path"),
  // 已安全消费到的 stdout 字节位置，永远落在换行边界（见 detached.ts 的
  // tailFile）。重启后从这里接着读 → 不丢行也不重行。
  agentOffset: integer("agent_offset"),
  // ── Token 用量（server/src/usage.ts）────────────────────────────────────
  // 这条会话行**跨回合累加**的账（同 active_ms 的模式：会话可复用，每回合结束
  // 时把执行器报的那笔加上去）。口径归一在 shared/src/usage.ts：input 不含缓存、
  // cache_read/cache_write 分列。全 null = 建在本功能之前或那家 CLI 不报账，
  // 展示端据此区分「没数据」与「0」。cost 只有 claude 报得出，codex 恒 null。
  usageInput: integer("usage_input"),
  usageOutput: integer("usage_output"),
  usageCacheRead: integer("usage_cache_read"),
  usageCacheWrite: integer("usage_cache_write"),
  usageReasoning: integer("usage_reasoning"),
  usageCostUsd: real("usage_cost_usd"),
  usageTurns: integer("usage_turns"),
  // ── 上下文水位（同一个文件里的 setSessionContext）────────────────────────
  // 上面那组是**累加**的流水，这三列是**覆盖**的水位：最近一次 API 调用带进模型
  // 的输入有多大。两者差着数量级（流水 18M / 水位 12 万），别拿流水去算「还剩
  // 多少上下文」。window 为 null = 谁也没报出窗口大小，界面只显示绝对水位。
  contextUsed: integer("context_used"),
  contextWindow: integer("context_window"),
  // window 是不是「估的」：claude 在 result.modelUsage 里自报窗口，读到了就是准数
  // （false）；自报缺失才按模型名估（true，估不出则 window 为 null）。codex 从私有
  // rollout best-effort 读取；格式变化或本轮取不到时清空为 null，胶囊自然不显示旧值。
  contextWindowEstimated: integer("context_window_estimated", { mode: "boolean" }),
});

export const schedules = sqliteTable("schedules", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  kind: text("kind").notNull(), // once | cron
  at: text("at"), // ISO timestamp for one-shot
  cron: text("cron"), // 5-field expression for recurring
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastRunAt: text("last_run_at"),
  createdAt: text("created_at").notNull(),
});

// Scheduled replies: a message to send to a task's agent when it comes due
// (continueTask). Distinct from `schedules` (which re-runs a task): a task may
// have several pending messages; the scheduler fires each when due and the task
// is idle. `mode` decides what "due" means — timed=到点，queued=任务一空闲就发。
export const scheduledMessages = sqliteTable("scheduled_messages", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  text: text("text").notNull().default(""),
  attachments: text("attachments").notNull().default("[]"), // json string[]
  agent: text("agent"), // AgentType | null（@指派目标）
  // @指派时一并选定的执行器与模型：定时发送落地时要跑的还是用户当时选的那一个。
  executorId: text("executor_id"), // agents.id | null（null=按 agent 类型默认执行器）
  model: text("model"), // 模型覆盖 | null（跟随执行器）
  reasoningEffort: text("reasoning_effort"), // 思考强度覆盖 | null（跟随执行器）
  mode: text("mode").notNull().default("timed"), // timed | queued
  sendAt: text("send_at").notNull(), // timed=ISO 到期时间；queued=入队时刻（只用来排先后）
  status: text("status").notNull().default("pending"), // pending | sent | canceled
  createdAt: text("created_at").notNull(),
  sentAt: text("sent_at"),
  // 「有人正在把这条送进会话」的租约（ISO 时刻），行本身仍是 pending。sent 只在原话
  // 真的落进会话之后才写，所以 sent 永远意味着「用户刷新后看得见」。租约是内存态的
  // 持久投影：进程一换就作废（开机 reclaimStaleDeliveries 全清），那条消息回到待发送。
  deliveringSince: text("delivering_since"),
});

// Queue items: ordered list of tasks where each task waits for the one
// immediately before it in the queue. Replaces the legacy depends_on /
// resume_depends_on pointer model.
//
// Invariants (enforced at application layer, NOT DB constraints):
//   - All tasks in one queue belong to the same group (or all have null group_id)
//   - Position is dense (0..N-1) within a queue; reorder repacks
//
// task_id is PRIMARY KEY because a task is in at most one queue at a time.
export const queueItems = sqliteTable(
  "queue_items",
  {
    taskId: text("task_id").primaryKey(),
    queueId: text("queue_id").notNull(),
    position: integer("position").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    queuePosIdx: uniqueIndex("queue_items_queue_pos_idx").on(t.queueId, t.position),
  }),
);

// 供应商(relay), system-level. 挂给执行器用:启动 CLI 时注入 base_url + key,
// 顶掉 CLI 自己的官方登录账号。harness 自己不再直连 HTTP 调模型。
export const llmProviders = sqliteTable("llm_providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  protocol: text("protocol").notNull().default("openai"), // anthropic | openai
  baseUrl: text("base_url").notNull(), // 根地址,不含 /v1(各处按需自行补)
  apiKey: text("api_key").notNull().default(""), // 本机存储,GET 不回传明文
  model: text("model").notNull().default(""),
  protocolConversionEnabled: integer("protocol_conversion_enabled", { mode: "boolean" }).notNull().default(false),
  // 选模型面板的候选来源:'api'=每次现调 /models;'pinned'=只用 pinned_models(json string[])。
  modelListMode: text("model_list_mode").notNull().default("api"),
  pinnedModels: text("pinned_models").notNull().default("[]"),
  createdAt: text("created_at").notNull(),
});

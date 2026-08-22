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

// 项目走 HTTPS 远端时用的用户名 + 令牌。**一个项目一组**，故意不做成「一个项目多个
// host」：需求是「这个项目用哪个账号推」，多 host 那层复杂度还没有人要过。
//
// 这份东西不写进仓库的 .git/config（那是明文、所有 worktree 和 agent 都读得到），也不
// 回传给前端 —— 读侧只报 username 和「配没配」，见 git-credentials.ts 顶部。
export const projectGitCredentials = sqliteTable("project_git_credentials", {
  projectId: text("project_id").primaryKey(),
  username: text("username").notNull(),
  secret: text("secret").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Generic global settings store. Values are JSON-encoded text; the typed
// read/write boundary lives in app-settings.ts so future settings can reuse the
// same table without another schema change.
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// 外部 CLI 报“会话累计值”时的最后一份原始快照。它独立于 sessions：同一个 CLI
// 会话可能跨多个 ash 行（例如讨论模式），按 source_id 才能正确算本轮差值。
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
  starredAt: integer("starred_at"), // 星标（用户手动软记号）；null=未标
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
  // on branch `ash/<id8>` based off `worktreeBase` (null = current HEAD) before
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
  // 这一轮是 CLI 原生命令（`/compact`）：整条消息由 CLI 本地执行，不进模型 —— 既不是
  // 任务的执行，也不是一轮验证。结算钩子（派验证 / 收验证轮 / 推工作流）必须整段跳过，
  // 否则「压一下上下文」会被记成一轮验证跑完，还白吃一轮配额。开跑时写，结算后清空；
  // 落库而不只放内存，理由同上一条（结算可能发生在另一个进程里）。
  nativeTurn: integer("native_turn", { mode: "boolean" }).notNull().default(false),
  // 统一验收合并的结构化落账：目标分支 + 合并前后它的 commit。合并后基线审查（对
  // base@before..after 派新任务）靠它，时间线文本反解不可靠。无合并动作（in_place /
  // marked_only / 打标签）时保持 null 或 before==after。
  acceptedTargetBranch: text("accepted_target_branch"),
  acceptedBaseCommit: text("accepted_base_commit"),
  acceptedMergeCommit: text("accepted_merge_commit"),
  // 验收尾段（点头之后的发布/命令步骤）的 durable 进度：finalize 时线上真有尾段就置 1，
  // 尾段跑完（无论成败，结果已报告）清 0。进程死在两者之间时，重启后的重复验收会发现
  // 它还挂着并补跑——否则发布步骤被 already_accepted 快路静默永久漏掉（审查实测复现）。
  acceptedTailPending: integer("accepted_tail_pending", { mode: "boolean" }).notNull().default(false),
  // 尾段的**逐站** durable 进度（JSON string[]：已完成的 step id）。只有 pending 一个
  // 布尔位时，崩溃重试会整段重跑——已经执行过的发布/部署命令再来一遍（at-least-once
  // 变 at-least-twice，审查实测复现）。补跑按这份清单跳过已完成的站；随 pending 一起清。
  acceptedTailDone: text("accepted_tail_done").notNull().default("[]"),
  // 任务接力（json TaskHandoff）：direction:"out" = 已交给另一台 ash 续跑（本地这份
  // 是历史），"in" = 从别的机器接过来的。持久落库,刷新后的横幅靠它,不靠 toast。
  handoff: text("handoff"),
});

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  model: text("model"),
  extraArgs: text("extra_args").notNull().default("[]"), // json
  reasoningEffort: text("reasoning_effort"), // null=跟随 CLI 默认
  speed: text("speed"), // null=标准；"fast"=1.5x 加速档
  // 挂载的供应商(llm_providers.id)。null=用 CLI 自己的官方登录账号。
  // 非空时启动 CLI 前注入 base_url + key(claude: env;codex: -c model_providers)。
  providerId: text("provider_id"),
  // 覆盖 CLI 自己配置文件里的设置(json Record<string, number>,以 env 注入)。
  // 声明表在 @ash/shared/cli-overrides —— 没在那儿声明过的 key 一律不落库。
  configOverrides: text("config_overrides").notNull().default("{}"),
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
  // 这一轮真正跑的**执行器 profile 主键**，以及生效的 model/思考强度。上面那个
  // `executor` 只是展示名（agents.name 非唯一、可改名），拿它反查 profile 会选中
  // 同名的另一个人；要「按上一回合原样再跑一遍」只能认 id + 这一轮的覆盖值。
  // 全 null = 这条会话建在本功能之前，只能退回按任务当前配置跑。
  executorId: text("executor_id"),
  turnModel: text("turn_model"),
  turnReasoningEffort: text("turn_reasoning_effort"),
  // 那一刻这条 profile 的**执行环境指纹**（extraArgs / 供应商 / 配置覆盖…，
  // 算法见 executors/index.ts 的 fingerprintOf）。profile 是可编辑、可删除的，光有主键
  // 说不清「它当时长什么样」：换一次供应商就换了后端，重试会把旧配置下生成的 CLI
  // session id 发到新后端去（第 1 轮审查 finding 2）。所以重跑前先拿它跟当前 profile
  // 对一次，对不上就 409，让用户明确决定要不要按新配置另起一轮。null = 老会话行。
  executorFingerprint: text("executor_fingerprint"),
  worktreePath: text("worktree_path"),
  branch: text("branch"),
  cwd: text("cwd"),
  cliSessionId: text("cli_session_id"),
  resumeCommand: text("resume_command"),
  // 恢复命令要带的 env 前缀:供应商那一截(token 已是占位符)。null = 没有。
  // 只用于展示,不含真 key。列名 relay_env 跟它现在装的东西正好对上。
  resumeEnv: text("relay_env"),
  // 恢复命令里跟在 CLI 后面的参数(claude 的 `--settings '{…}'`)。配置覆盖项走这一列:
  // env 前缀打不过用户自己的 settings.json,只有 --settings 这一层压得住(finding 2)。
  resumeArgs: text("resume_args"),
  commandLine: text("command_line"),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"), // when this run finished (set with exit_status)
  exitStatus: integer("exit_status"),
  // 这一轮**是被停下来的**（canceled = 手动停止 / paused = 分组暂停），不是它自己崩的。
  // 非空时 exit_status 多半也是非零：CLI 吃 SIGTERM 按 signal 退出。光看 exit_status
  // 区分不了「我停的」和「它崩了」，而这两件事的入口完全不同（运行 vs 重试），所以停止
  // 的口径只能在结算时落在这里。每回合开头清空。
  stoppedAs: text("stopped_as"),
  // 旁路回合：就地验证、审查、`/compact` 这类「不算任务执行」的回合（判据见
  // orchestrator.ts 的 sideTurn）。它们收尾后任务回到原状态，光看 status + exit_status
  // 分辨不出来——而重跑一个旁路回合要走它自己那条路，不能按普通回合重投。
  sideTurn: integer("side_turn", { mode: "boolean" }).notNull().default(false),
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
  // 投递时恢复的回合身份（"reviewer" 等）。审查者提问回合还没 release turn、用户就答复
  // 时答案会落到这里排队——不存 role 的话投递会以 single 身份进实现会话，reviewer 永远
  // 收不到答案（审查实测复现）。null = 普通消息。
  sessionRole: text("session_role"),
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
// 顶掉 CLI 自己的官方登录账号。ash 自己不再直连 HTTP 调模型。
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
  // Anthropic 供应商逐模型声明 1M；存干净模型名，运行时再加 [1m] 并按需走本地转发。
  context1mModels: text("context_1m_models").notNull().default("[]"),
  createdAt: text("created_at").notNull(),
});

// 接力来源(入站方向的信任表):哪些机器可以把任务接力**进**本机。
//
// 主键是公钥指纹而不是地址 —— 地址会随 DHCP/网络环境漂,身份不会;而且换了地址还是
// 同一台机器,不该重新批准。存的全是公开信息(公钥、对端自述的主机名),泄露无害;
// 本机自己的私钥在 `<db>.identity.json`,见 handoff-identity.ts 顶部注释。
//
// 出站方向(「我要发的这台是不是原来那台」)不在这里,而是 app_settings.handoffTargets
// 每个目标上的 peerFp —— 那是「地址 → 期望身份」的绑定,和这张「身份 → 是否放行」是
// 两件事,合成一张表反而说不清一台只出不进(或只进不出)的机器该是什么状态。
export const handoffPeers = sqliteTable("handoff_peers", {
  fingerprint: text("fingerprint").primaryKey(), // sha256(公钥 SPKI DER) 小写 hex
  publicKey: text("public_key").notNull(), // base64(SPKI DER)
  // 对端自述的主机名,**不可信**,只用来在批准列表里帮人认出是哪台;身份永远看指纹。
  name: text("name").notNull().default(""),
  // pending = 来敲过门还没批;approved = 放行;blocked = 明确拒绝(不再进待批列表打扰)。
  status: text("status").notNull().default("pending"),
  firstSeenAt: text("first_seen_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  approvedAt: text("approved_at"),
  // 最近一次来访的地址,纯展示(帮人判断「这是不是我那台台式机」)。
  lastAddr: text("last_addr").notNull().default(""),
});

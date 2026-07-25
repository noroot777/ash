import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";

// JSON columns are stored as text and parsed in the repository layer.
// Schema mirrors shared/src/index.ts.

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  repoPath: text("repo_path").notNull(),
  apiKeys: text("api_keys"), // json {anthropic?, openai?} — 本机用,给直连 LLM 解析事项
  createdAt: text("created_at").notNull(),
});

export const groups = sqliteTable("groups", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  name: text("name").notNull(),
  mode: text("mode").notNull().default("parallel"), // parallel | serial
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  // 编排组：协调者任务 id。非空时组内其它任务结束/提问会自动唤醒它（见
  // orchestrator.notifyCoordinator）；协调者不得在本组串行队列里。
  coordinatorTaskId: text("coordinator_task_id"),
  createdAt: text("created_at").notNull(),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  groupId: text("group_id"),
  parentId: text("parent_id"),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  mode: text("mode").notNull().default("single"), // single | debate
  status: text("status").notNull().default("backlog"),
  priority: text("priority").notNull().default("none"),
  labels: text("labels").notNull().default("[]"), // json
  dependsOn: text("depends_on").notNull().default("[]"), // json
  resumeDependsOn: text("resume_depends_on").notNull().default("[]"), // json
  agentType: text("agent_type"),
  autoTitle: integer("auto_title", { mode: "boolean" }).notNull().default(false),
  debate: text("debate"), // json DebateConfig
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
  worktreeBase: text("worktree_base"),
  issueId: text("issue_id"), // 回链来源事项(null = 直接创建)
  // 检查点续跑：agent 调 pause_task 时填进来；下次 resume 时取出喂给 CLI 会话并清空。
  resumePrompt: text("resume_prompt"),
  // 编排组提问：agent 调 ask_question 时填进来。结算落 paused 且队列不自动续跑，
  // 等 answer_question 清空并带答复 resume（见 scheduler.pickNextLaunchable 的挡板）。
  question: text("question"),
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

// Scheduled replies: a message to send to a task's agent at a future time
// (continueTask at sendAt). Distinct from `schedules` (which re-runs a task):
// a task may have several pending messages; the scheduler fires each when due
// and the task is idle.
export const scheduledMessages = sqliteTable("scheduled_messages", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  text: text("text").notNull().default(""),
  attachments: text("attachments").notNull().default("[]"), // json string[]
  agent: text("agent"), // AgentType | null（@指派目标）
  sendAt: text("send_at").notNull(), // ISO 到期发送时间
  status: text("status").notNull().default("pending"), // pending | sent | canceled
  createdAt: text("created_at").notNull(),
  sentAt: text("sent_at"),
});

// Issues: the lightweight planning/discussion layer upstream of tasks.
export const issues = sqliteTable("issues", {
  id: text("id").primaryKey(),
  projectId: text("project_id"), // null = 未归类(AI 没识别出项目,内部暂存)
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  sourceText: text("source_text").notNull().default(""), // 用户原始输入
  status: text("status").notNull().default("open"), // open | in_progress | done | canceled
  priority: text("priority").notNull().default("none"),
  labels: text("labels").notNull().default("[]"), // json
  attachments: text("attachments").notNull().default("[]"), // json: absolute file paths
  aiBackend: text("ai_backend"), // json AiBackend({executorId}); 旧格式 {kind:…} 读到就降级为默认执行者
  parsed: integer("parsed", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  closedAt: text("closed_at"),
});

// Issue discussion: plain comments + agent turns. @-mentioning a CLI agent in a
// comment records a turn AND triggers execution (see POST /issues/:id/comments).
export const issueComments = sqliteTable("issue_comments", {
  id: text("id").primaryKey(),
  issueId: text("issue_id").notNull(),
  author: text("author").notNull().default('{"kind":"human"}'), // json CommentAuthor
  body: text("body").notNull().default(""),
  attachments: text("attachments").notNull().default("[]"), // json: absolute file paths
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at"), // set when edited
  // Only agent comments produced by a discuss @-mention use this: pending →
  // done/failed. Human comments leave it null.
  status: text("status"),
});

// Queue items: ordered list of tasks where each task waits for the one
// immediately before it in the queue. Replaces the legacy depends_on /
// resume_depends_on pointer model. See DESIGN-scheduling.md.
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

// 供应商(relay), system-level. 挂给执行者用:启动 CLI 时注入 base_url + key,
// 顶掉 CLI 自己的官方登录账号。harness 自己不再直连 HTTP 调模型。
export const llmProviders = sqliteTable("llm_providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  protocol: text("protocol").notNull().default("openai"), // anthropic | openai
  baseUrl: text("base_url").notNull(), // 根地址,不含 /v1(各处按需自行补)
  apiKey: text("api_key").notNull().default(""), // 本机存储,GET 不回传明文
  model: text("model").notNull().default(""),
  createdAt: text("created_at").notNull(),
});

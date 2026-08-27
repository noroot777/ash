import * as driverCore from "drizzle-orm/libsql/driver-core";
import type { LibSQLDatabase } from "drizzle-orm/libsql/driver-core";
import { createClient } from "./node-sqlite-client.js";
import * as schema from "./schema.js";
import { ensureAshDbDir, resolveAshDbFile } from "./path.js";
import { dropRetiredTables } from "./retired-schema.js";

const dbFile = resolveAshDbFile();
ensureAshDbDir(dbFile);

// Node 自带的 `node:sqlite`，零原生编译（Windows 不需要 Visual Studio Build Tools）。
// 外壳把它伪装成 libsql 的 Client，drizzle 那一侧的用法一行不用改；细节见 node-sqlite-client.ts。
// 路径直接给裸路径：`file:C:\...` 在 Windows 上不是合法 URL。
const client = createClient({ url: dbFile });

// **不能 `import { drizzle } from "drizzle-orm/libsql"`**：那个入口第一行就是
// `import { createClient } from "@libsql/client"`（静态的、无条件的），只要引它，那个原生
// 模块就会被真的加载——换掉驱动的意义（Windows 上不装 Visual Studio Build Tools 也能跑）
// 当场归零。`driver-core` 是同一份实现里不碰 @libsql/client 的那半：`drizzle(client, cfg)`
// 传对象时做的事就是直接调它的 `construct`。回归测试 `test:no-libsql` 钉住这条。
//
// 两处类型缝合，一并说明：
// ① `construct` 只存在于 driver-core 的**实现**里，drizzle 没把它写进 .d.ts，所以签名在这
//    自己声明一遍——照 `drizzle()` 的返回类型写，`db` 的 schema 类型一点不丢。
// ② client 转 never：libsql 的 Client 类型声明 blob 是 ArrayBuffer，node:sqlite 给的是
//    Uint8Array。drizzle 两边都当二进制透传，运行时无差别，只有类型咬不住。
const construct = (driverCore as unknown as {
  construct(client: unknown, config: { schema: typeof schema }): LibSQLDatabase<typeof schema>;
}).construct;

export const db = construct(client as never, { schema });

// 原始连接。日常一律用上面的 `db`（drizzle，有类型）；只有「按运行时拿到的列名搬表」
// 这种拿不到静态类型的活儿才需要它（preview-seed.ts）。
export { client as dbClient };

// Minimal bootstrap so the app runs without a separate migration step in dev.
// `npm run db:push` (drizzle-kit) remains the source of truth for migrations.
export async function ensureSchema() {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_cumulative_snapshots (
      source_id TEXT PRIMARY KEY,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      reasoning_tokens INTEGER NOT NULL,
      cost_usd REAL,
      baseline_ready INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT NOT NULL,
      attachments TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS note_tasks (
      note_id TEXT NOT NULL, task_id TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS note_tasks_note_task_idx
      ON note_tasks (note_id, task_id);
    CREATE INDEX IF NOT EXISTS note_tasks_task_idx ON note_tasks (task_id);
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'parallel',
      paused INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, group_id TEXT, parent_id TEXT,
      title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL DEFAULT 'single',
      status TEXT NOT NULL DEFAULT 'backlog', stage TEXT, pinned_at INTEGER,
      review_of TEXT, review_round INTEGER, review_requested INTEGER NOT NULL DEFAULT 0,
      verify_round INTEGER, verify_rounds INTEGER NOT NULL DEFAULT 0,
      verify_station_rounds INTEGER NOT NULL DEFAULT 0,
      labels TEXT NOT NULL DEFAULT '[]', depends_on TEXT NOT NULL DEFAULT '[]',
      resume_depends_on TEXT NOT NULL DEFAULT '[]',
      agent_type TEXT, executor_id TEXT, model TEXT, reasoning_effort TEXT,
      active_turn_token TEXT, active_direction_token TEXT,
      active_direction_version INTEGER NOT NULL DEFAULT 0,
      auto_title INTEGER NOT NULL DEFAULT 0, duet TEXT, schedule_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, ended_at TEXT,
      archived INTEGER NOT NULL DEFAULT 0, archived_at TEXT
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, model TEXT,
      extra_args TEXT NOT NULL DEFAULT '[]', reasoning_effort TEXT, speed TEXT,
      config_overrides TEXT NOT NULL DEFAULT '{}',
      is_default INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS team_presets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, config TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL,
      agent_type TEXT NOT NULL, executor TEXT NOT NULL,
      worktree_path TEXT, branch TEXT, cwd TEXT, cli_session_id TEXT, resume_command TEXT,
      command_line TEXT, started_at TEXT NOT NULL, ended_at TEXT, exit_status INTEGER,
      active_ms INTEGER, turn_started_at TEXT
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL,
      at TEXT, cron TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
      attachments TEXT NOT NULL DEFAULT '[]', agent TEXT,
      executor_id TEXT, model TEXT, mode TEXT NOT NULL DEFAULT 'timed', send_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, sent_at TEXT,
      delivering_since TEXT
    );
    CREATE TABLE IF NOT EXISTS llm_providers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      protocol TEXT NOT NULL DEFAULT 'openai', base_url TEXT NOT NULL,
      api_key TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
      protocol_conversion_enabled INTEGER NOT NULL DEFAULT 0,
      model_list_mode TEXT NOT NULL DEFAULT 'api',
      pinned_models TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS queue_items (
      task_id TEXT PRIMARY KEY,
      queue_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS queue_items_queue_pos_idx
      ON queue_items (queue_id, position);
    CREATE TABLE IF NOT EXISTS team_inbound (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS team_inbound_task_idx ON team_inbound (task_id, seq);
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY, builtin_key TEXT, name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', def TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS workflows_builtin_idx ON workflows (builtin_key);
    CREATE TABLE IF NOT EXISTS reviewer_profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, agent_type TEXT NOT NULL,
      executor_id TEXT, model TEXT, reasoning_effort TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS free_workflow_states (
      task_id TEXT PRIMARY KEY, selected_reviewer_id TEXT,
      review_armed INTEGER NOT NULL DEFAULT 0, review_check_mode TEXT,
      review_retry_limit INTEGER, review_note TEXT, review_run_id TEXT,
      review_agent_type TEXT, review_executor_id TEXT,
      review_model TEXT, review_reasoning_effort TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS free_workflow_events (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL,
      source TEXT NOT NULL, detail TEXT, occurred_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS free_workflow_events_task_idx
      ON free_workflow_events (task_id, occurred_at);
    CREATE TABLE IF NOT EXISTS free_review_runs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, reviewer_id TEXT,
      reviewer_name TEXT NOT NULL, agent_type TEXT NOT NULL, executor_id TEXT,
      model TEXT, reasoning_effort TEXT, check_mode TEXT NOT NULL, note TEXT,
      target_kind TEXT NOT NULL DEFAULT 'workspace', target_branch TEXT,
      target_base_commit TEXT, target_commit TEXT, repair_task_id TEXT,
      retry_limit INTEGER NOT NULL DEFAULT 1, current_round INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS free_review_runs_task_idx ON free_review_runs (task_id, created_at);
    CREATE TABLE IF NOT EXISTS free_review_rounds (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, round INTEGER NOT NULL,
      status TEXT NOT NULL, conclusion TEXT, reviewed_commit TEXT,
      started_at TEXT NOT NULL, ended_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS free_review_rounds_run_round_idx
      ON free_review_rounds (run_id, round);
    CREATE TABLE IF NOT EXISTS project_git_credentials (
      project_id TEXT PRIMARY KEY, username TEXT NOT NULL,
      secret TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS handoff_peers (
      fingerprint TEXT PRIMARY KEY, public_key TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      approved_at TEXT, last_addr TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member', dir_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'invited', key_hash TEXT,
      git_name TEXT NOT NULL DEFAULT '', git_email TEXT NOT NULL DEFAULT '',
      created_by TEXT, created_at TEXT NOT NULL, last_active_at TEXT
    );
    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      user_agent TEXT NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX IF NOT EXISTS user_sessions_token_idx ON user_sessions (token_hash);
    CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions (user_id);
    CREATE TABLE IF NOT EXISTS user_invites (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL,
      created_by TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      consumed_at TEXT, revoked_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS user_invites_token_idx ON user_invites (token_hash);
    CREATE INDEX IF NOT EXISTS user_invites_user_idx ON user_invites (user_id);
    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL, user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member', added_by TEXT, added_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS project_members_idx ON project_members (project_id, user_id);
    CREATE INDEX IF NOT EXISTS project_members_user_idx ON project_members (user_id);
    CREATE TABLE IF NOT EXISTS project_invites (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, token_hash TEXT NOT NULL,
      created_by TEXT, created_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS project_invites_token_idx ON project_invites (token_hash);
    CREATE INDEX IF NOT EXISTS project_invites_project_idx ON project_invites (project_id);
    CREATE TABLE IF NOT EXISTS user_handoff_targets (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL,
      peer_fp TEXT, peer_key TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS user_handoff_targets_user_idx ON user_handoff_targets (user_id);
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS user_settings_idx ON user_settings (user_id, key);
  `);
  // Tolerant migration for DBs created before columns were added.
  try {
    await client.execute("ALTER TABLE tasks ADD COLUMN auto_title INTEGER NOT NULL DEFAULT 0");
  } catch {
    /* column already exists */
  }
  try {
    await client.execute("ALTER TABLE sessions ADD COLUMN cwd TEXT");
  } catch {
    /* column already exists */
  }
  // Run-timing columns (added later). Each ALTER is independent + tolerant so a
  // DB created before any one of them still upgrades cleanly.
  for (const sql of [
    "ALTER TABLE tasks ADD COLUMN started_at TEXT",
    "ALTER TABLE tasks ADD COLUMN ended_at TEXT",
    "ALTER TABLE sessions ADD COLUMN ended_at TEXT",
    "ALTER TABLE groups ADD COLUMN paused INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN archived_at TEXT",
    "ALTER TABLE sessions ADD COLUMN active_ms INTEGER",
    "ALTER TABLE sessions ADD COLUMN turn_started_at TEXT",
    "ALTER TABLE tasks ADD COLUMN use_worktree INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN worktree_base TEXT",
    "ALTER TABLE tasks ADD COLUMN origin_task_id TEXT",
    "ALTER TABLE projects ADD COLUMN api_keys TEXT",
    "ALTER TABLE tasks ADD COLUMN resume_prompt TEXT",
    "ALTER TABLE tasks ADD COLUMN resume_depends_on TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE agents ADD COLUMN speed TEXT",
    "ALTER TABLE agents ADD COLUMN reasoning_effort TEXT",
    "ALTER TABLE tasks ADD COLUMN question TEXT",
    "ALTER TABLE agents ADD COLUMN provider_id TEXT",
    "ALTER TABLE sessions ADD COLUMN relay_env TEXT",
    "ALTER TABLE sessions ADD COLUMN resume_args TEXT",
    // §Team：团队模式（替掉旧的「编排组/协调者」）
    "ALTER TABLE tasks ADD COLUMN team TEXT",
    "ALTER TABLE tasks ADD COLUMN report_back INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE groups ADD COLUMN owner_task_id TEXT",
    // ask_question 的候选答案（json string[]，null=只能自由作答）
    "ALTER TABLE tasks ADD COLUMN question_options TEXT",
    // ask_question 的多问题列表（json {question, options?}[]，null=老式单问题）
    "ALTER TABLE tasks ADD COLUMN question_items TEXT",
    // 任务执行器 profile。非空时按 agents.id 精确解析；空/悬空时按 agent_type 默认执行器降级。
    "ALTER TABLE tasks ADD COLUMN executor_id TEXT",
    // 任务级模型/思考强度覆盖；null 时继续跟随执行器 profile。
    "ALTER TABLE tasks ADD COLUMN model TEXT",
    "ALTER TABLE tasks ADD COLUMN reasoning_effort TEXT",
    // 续聊：终态任务的追加对话回合，记下续聊前的终态（队列按它看待该成员）
    "ALTER TABLE tasks ADD COLUMN follow_up_from TEXT",
    // 完成确认落库（严格 done 协议），确认与结算跨进程也不丢
    "ALTER TABLE tasks ADD COLUMN complete_confirmed_at TEXT",
    "ALTER TABLE tasks ADD COLUMN active_turn_token TEXT",
    "ALTER TABLE tasks ADD COLUMN active_direction_token TEXT",
    "ALTER TABLE tasks ADD COLUMN active_direction_version INTEGER NOT NULL DEFAULT 0",
    // 正交验收阶段，只用于展示与协作，不进入 TaskStatus 调度/结算
    "ALTER TABLE tasks ADD COLUMN stage TEXT",
    // 正交列表展示字段：null=未置顶，整数毫秒时间戳用于多个置顶任务排序
    "ALTER TABLE tasks ADD COLUMN pinned_at INTEGER",
    // 星标：用户手动软记号（与自动状态正交）；null=未标
    "ALTER TABLE tasks ADD COLUMN starred_at INTEGER",
    // §工作流：项目默认起手式 + 任务创建时拷下的那条线（快照，不是引用）
    "ALTER TABLE projects ADD COLUMN workflow_id TEXT",
    "ALTER TABLE tasks ADD COLUMN workflow TEXT",
    // 独立审查任务与被审目标的关系；review_requested 只在团队 dispatch worker 上置位。
    "ALTER TABLE tasks ADD COLUMN review_of TEXT",
    "ALTER TABLE tasks ADD COLUMN review_round INTEGER",
    "ALTER TABLE tasks ADD COLUMN review_requested INTEGER NOT NULL DEFAULT 0",
    // 就地验证轮：验证不再另起一个审查任务，而是在原任务上多跑一个旁路回合。
    // review_of/review_round 保留，只为让历史那批独立审查任务仍能读出来。
    "ALTER TABLE tasks ADD COLUMN verify_round INTEGER",
    "ALTER TABLE tasks ADD COLUMN verify_rounds INTEGER NOT NULL DEFAULT 0",
    // 就地验证轮没有独立任务行可数，所以「这一站验过几轮」得自己记：换一站就归零，
    // 站号记在同一行的 review_step 上。
    "ALTER TABLE tasks ADD COLUMN verify_station_rounds INTEGER NOT NULL DEFAULT 0",
    // 一条线上可以写不止一站「自动验证」/「等我点头」：游标记住此刻停在哪一站，
    // 审查任务记住自己验的是哪一站（轮数上限按站分开数）。
    "ALTER TABLE tasks ADD COLUMN workflow_at TEXT",
    "ALTER TABLE tasks ADD COLUMN workflow_mode TEXT NOT NULL DEFAULT 'preset'",
    "ALTER TABLE tasks ADD COLUMN review_step TEXT",
    // 解绑重启（executors/detached.ts）：agent 输出走文件而不是匿名管道，于是它
    // 活得过 server 重启。这几列是重启后「找回并接管」所需的全部线索——pid 认
    // 进程、started_at 防 pid 复用、out_path 是原始输出、offset 是已消费到哪个
    // 字节（永远落在换行边界），从那里接着读就不丢不重。
    "ALTER TABLE sessions ADD COLUMN agent_pid INTEGER",
    "ALTER TABLE sessions ADD COLUMN agent_started_at TEXT",
    "ALTER TABLE sessions ADD COLUMN agent_out_path TEXT",
    "ALTER TABLE sessions ADD COLUMN agent_err_path TEXT",
    "ALTER TABLE sessions ADD COLUMN agent_rc_path TEXT",
    "ALTER TABLE sessions ADD COLUMN agent_offset INTEGER",
    // OpenAI 兼容供应商：把 Codex 的 Responses API 适配到仅有 Chat Completions 的上游。
    "ALTER TABLE llm_providers ADD COLUMN protocol_conversion_enabled INTEGER NOT NULL DEFAULT 0",
    // 选模型面板的候选来源：api=每次现调 /models；pinned=只用固定下来的这几个。
    "ALTER TABLE llm_providers ADD COLUMN model_list_mode TEXT NOT NULL DEFAULT 'api'",
    "ALTER TABLE llm_providers ADD COLUMN pinned_models TEXT NOT NULL DEFAULT '[]'",
    // Anthropic 供应商中明确以 1M 上下文运行的模型名集合；未选模型继续直连。
    "ALTER TABLE llm_providers ADD COLUMN context_1m_models TEXT NOT NULL DEFAULT '[]'",
    // 定时发送的 @指派：连执行器、模型、思考强度一起记住，到点还是跑用户当时选的那一套。
    "ALTER TABLE scheduled_messages ADD COLUMN executor_id TEXT",
    "ALTER TABLE scheduled_messages ADD COLUMN model TEXT",
    "ALTER TABLE scheduled_messages ADD COLUMN reasoning_effort TEXT",
    // 排队追问：运行中发出的消息不看时间，任务一空闲就投递（timed 是老的定时发送）。
    "ALTER TABLE scheduled_messages ADD COLUMN mode TEXT NOT NULL DEFAULT 'timed'",
    // 投递租约：行仍是 pending，只是标着「有人正在送」。**它必须落库**——进程死在
    // 「已认领、还没送到」当口时，内存里的等待/在途标记全没了，只有库里这个标记能让
    // 开机扫描认出「这条得重新投递」（见 docs/incidents.md「排队消息凭空消失」）。
    "ALTER TABLE scheduled_messages ADD COLUMN delivering_since TEXT",
    // 投递时恢复的回合身份（审查者提问期间排队的答复必须以 reviewer 身份送回）。
    "ALTER TABLE scheduled_messages ADD COLUMN session_role TEXT",
    // 自由工作流预约审查：只保存一份配置，confirmed done 后复用现有派审链。
    "ALTER TABLE free_workflow_states ADD COLUMN review_armed INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE free_workflow_states ADD COLUMN review_check_mode TEXT",
    "ALTER TABLE free_workflow_states ADD COLUMN review_retry_limit INTEGER",
    "ALTER TABLE free_workflow_states ADD COLUMN review_note TEXT",
    "ALTER TABLE free_workflow_states ADD COLUMN review_run_id TEXT",
    // 预约里「这次换个模型/智能水平跑」的覆盖（不改审查者配置本身）。
    "ALTER TABLE free_workflow_states ADD COLUMN review_agent_type TEXT",
    "ALTER TABLE free_workflow_states ADD COLUMN review_executor_id TEXT",
    "ALTER TABLE free_workflow_states ADD COLUMN review_model TEXT",
    "ALTER TABLE free_workflow_states ADD COLUMN review_reasoning_effort TEXT",
    "ALTER TABLE free_review_runs ADD COLUMN note TEXT",
    "ALTER TABLE free_review_runs ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'workspace'",
    "ALTER TABLE free_review_runs ADD COLUMN target_branch TEXT",
    "ALTER TABLE free_review_runs ADD COLUMN target_base_commit TEXT",
    "ALTER TABLE free_review_runs ADD COLUMN target_commit TEXT",
    "ALTER TABLE free_review_runs ADD COLUMN repair_task_id TEXT",
    "ALTER TABLE free_review_rounds ADD COLUMN reviewed_commit TEXT",
    // 统一验收的结构化合并落账（目标分支 + 合并前后 commit），合并后基线审查靠它。
    "ALTER TABLE tasks ADD COLUMN accepted_target_branch TEXT",
    "ALTER TABLE tasks ADD COLUMN accepted_base_commit TEXT",
    "ALTER TABLE tasks ADD COLUMN accepted_merge_commit TEXT",
    "ALTER TABLE tasks ADD COLUMN accepted_tail_pending INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN accepted_tail_done TEXT NOT NULL DEFAULT '[]'",
    // Token 用量:一条会话行按回合累加(口径统一在 shared/src/usage.ts)。全 null
    // = 这条会话建在本功能之前、或那家 CLI 不报账——**不能当 0 展示**。
    "ALTER TABLE sessions ADD COLUMN usage_input INTEGER",
    "ALTER TABLE sessions ADD COLUMN usage_output INTEGER",
    "ALTER TABLE sessions ADD COLUMN usage_cache_read INTEGER",
    "ALTER TABLE sessions ADD COLUMN usage_cache_write INTEGER",
    "ALTER TABLE sessions ADD COLUMN usage_reasoning INTEGER",
    "ALTER TABLE sessions ADD COLUMN usage_cost_usd REAL",
    "ALTER TABLE sessions ADD COLUMN usage_turns INTEGER",
    // 上下文水位:**覆盖**式,跟上面那组累加流水是两个概念(见 shared/src/usage.ts)。
    "ALTER TABLE sessions ADD COLUMN context_used INTEGER",
    "ALTER TABLE sessions ADD COLUMN context_window INTEGER",
    "ALTER TABLE sessions ADD COLUMN context_window_estimated INTEGER",
    // Codex 旧 trace 不完整时没有可信累计基线：下一回合只采基线，宁可少记一轮，也不
    // 把整条线程累计值再次加进 sessions。
    "ALTER TABLE usage_cumulative_snapshots ADD COLUMN baseline_ready INTEGER NOT NULL DEFAULT 1",
    // 覆盖 CLI 自己配置文件里的设置(json,以 env 注入进程)。声明表在
    // shared/src/cli-overrides.ts,那里同时写明每一项盖掉的是谁。
    "ALTER TABLE agents ADD COLUMN config_overrides TEXT NOT NULL DEFAULT '{}'",
    // 这一轮是 CLI 原生命令(`/compact`):结算钩子整段跳过,别把一次本地压缩记成
    // 一轮验证跑完(说明见 db/schema.ts 的 tasks.nativeTurn)。
    "ALTER TABLE tasks ADD COLUMN native_turn INTEGER NOT NULL DEFAULT 0",
    // 回合保真三件套(说明见 db/schema.ts 的 sessions 同名列):这一轮跑在哪个 profile
    // 上、是被停的还是崩的、是不是旁路回合。少一件,「重跑上一回合」就只能靠猜。
    "ALTER TABLE sessions ADD COLUMN executor_id TEXT",
    "ALTER TABLE sessions ADD COLUMN turn_model TEXT",
    "ALTER TABLE sessions ADD COLUMN turn_reasoning_effort TEXT",
    "ALTER TABLE sessions ADD COLUMN stopped_as TEXT",
    "ALTER TABLE sessions ADD COLUMN side_turn INTEGER NOT NULL DEFAULT 0",
    // profile 是可编辑可删除的,光记主键说不清「当时那套执行环境」。这一列存指纹,
    // 重跑前对不上就 409(说明见 db/schema.ts 的 sessions.executor_fingerprint)。
    "ALTER TABLE sessions ADD COLUMN executor_fingerprint TEXT",
    // 任务接力(跨机器 handoff)的持久标记(json TaskHandoff,见 db/schema.ts)。
    "ALTER TABLE tasks ADD COLUMN handoff TEXT",
    "ALTER TABLE tasks ADD COLUMN handoff_audit TEXT",
    // ── 多人模式(docs/multi-user-plan.md §八)──────────────────────────────
    // 归属列。全部可空:自用模式下恒为 null,转多人时由向导一次性实名化成初始管理员。
    "ALTER TABLE tasks ADD COLUMN owner_user_id TEXT",
    "ALTER TABLE tasks ADD COLUMN executor_snapshot TEXT",
    "ALTER TABLE projects ADD COLUMN owner_user_id TEXT",
    "ALTER TABLE notes ADD COLUMN owner_user_id TEXT",
    "ALTER TABLE agents ADD COLUMN owner_user_id TEXT",
    "ALTER TABLE llm_providers ADD COLUMN owner_user_id TEXT",
    "ALTER TABLE workflows ADD COLUMN owner_user_id TEXT",
    "ALTER TABLE reviewer_profiles ADD COLUMN owner_user_id TEXT",
    "ALTER TABLE team_presets ADD COLUMN owner_user_id TEXT",
    "ALTER TABLE schedules ADD COLUMN owner_user_id TEXT",
    // 定时/排队消息也盖归属戳:它触发的回合要按**排消息的人**跑(§八),
    // 不是按任务归属人 —— 共享项目里给别人的任务排一条回复,烧的是自己的 key。
    "ALTER TABLE scheduled_messages ADD COLUMN owner_user_id TEXT",
    // 入站接力来源:谁批的 + 对端自报的实例模式(§十一 知情批准)。
    "ALTER TABLE handoff_peers ADD COLUMN approved_by TEXT",
    "ALTER TABLE handoff_peers ADD COLUMN peer_mode TEXT NOT NULL DEFAULT ''",
  ]) {
    try {
      await client.execute(sql);
    } catch {
      /* column already exists */
    }
  }
  await widenWorkflowBuiltinIndex();
  await migrateLegacyNoteTaskLinks();
  await migrateDebateToDuet();
  await migrateFreeReviewStatuses();
  const mergeStatesMigrated = await migrateFreeWorkflowMergeStates();
  // 合并状态迁移刚把老库的 stage 补成 accepted/merged —— 预约清理必须再跑一遍才能
  // 命中它们(见 disarmReservationsOnAcceptedTasks 的注释)。无条件跑:部分失败
  // (mergeStatesMigrated=false)时也已经有任务落了 stage,那几条同样得清。
  try {
    await disarmReservationsOnAcceptedTasks();
  } catch (e) {
    console.warn("[ash] 已验收任务遗留预约清理失败,忽略:", e);
  }
  await reclaimOrphanOwnerGroups();
  // 事实没迁走的那几列留到下次启动:它们各自是唯一还认得出旧状态的证据。
  const keepColumns = new Set<string>();
  if (!mergeStatesMigrated) for (const column of MERGE_STATE_COLUMNS) keepColumns.add(column);
  if (!(await removeSshExecutorProfiles())) keepColumns.add("agents.target");
  await dropRetiredColumns(keepColumns);
  await dropRetiredTables(client, RETIRED_TABLES);
}

// 起手式的「覆写某条系统自带」唯一约束要**带上归属**：多人模式下每个人都能各自覆写
// 同一条自带起手式,全局唯一会让第二个人存不进去(而且报的是一句看不懂的约束冲突)。
// 老库上的旧索引只认 builtin_key,这里换成 (builtin_key, owner_user_id)。幂等。
async function widenWorkflowBuiltinIndex(): Promise<void> {
  try {
    const info = await client.execute("PRAGMA index_info(workflows_builtin_idx)");
    if (info.rows.length === 2) return; // 已经是两列的新索引
    await client.execute("DROP INDEX IF EXISTS workflows_builtin_idx");
    await client.execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS workflows_builtin_idx ON workflows (builtin_key, owner_user_id)",
    );
  } catch (e) {
    console.warn("[ash] 起手式覆写索引扩宽失败,忽略:", e);
  }
}

// 审查链状态瘦身（2026-08-11）：叙事状态改为推导，持久值只剩 reviewing/passed/failed/stopped。
// 老库的中间态**按旧语义逐类转换**，不能枚举压平（第 1 轮审查抓过三条丢语义）：
// - repairing：旧结算是「确认完成后直接续下一轮」，新结算只消费预约槽 → 必须回填
//   自动续轮预约（review_armed=1 + review_run_id），否则升级期间正在自动修复的任务静默断链。
// - superseded：旧语义「代码已改过，未通过结论已过期」。压成 stopped 会让前端重新露出
//   「按意见修复/未通过等待处理」。给该 run 最新一轮回填哨兵 reviewed_commit（永不等于任何
//   HEAD），新鲜度推导即显示「代码已有新修改」而不是把旧意见当成当前待办。
// - manual_repairing / reworking / exhausted：本来就是「未通过后停住」→ stopped。
// - 已验收（accepted/merged）自由任务的遗留预约一并注销，否则 reopen 后触发幽灵审查。
// 全部幂等：匹配 0 行就是空转。
export const LEGACY_SUPERSEDED_ANCHOR = "legacy-superseded";
async function migrateFreeReviewStatuses(): Promise<void> {
  try {
    // repairing：回填自动续轮预约（先回填，再改状态，中途失败重启后仍能续上）。
    const repairing = await client.execute(
      `SELECT id, task_id FROM free_review_runs WHERE status='repairing'`,
    );
    for (const row of repairing.rows) {
      await client.execute({
        sql: `INSERT INTO free_workflow_states (task_id, selected_reviewer_id, review_armed, review_run_id, updated_at)
              SELECT task_id, reviewer_id, 1, id, updated_at FROM free_review_runs WHERE id=:id
              ON CONFLICT(task_id) DO UPDATE SET review_armed=1, review_run_id=excluded.review_run_id`,
        args: { id: String(row.id) },
      });
    }
    // superseded：最新一轮回填哨兵锚点 → 新鲜度推导为「已过期」。
    await client.execute(
      `UPDATE free_review_rounds SET reviewed_commit='${LEGACY_SUPERSEDED_ANCHOR}'
       WHERE reviewed_commit IS NULL AND run_id IN (SELECT id FROM free_review_runs WHERE status='superseded')
         AND round=(SELECT MAX(r2.round) FROM free_review_rounds r2 WHERE r2.run_id=free_review_rounds.run_id)`,
    );
    await client.execute(
      `UPDATE free_review_runs
       SET status='stopped', finished_at=COALESCE(finished_at, updated_at)
       WHERE status IN ('repairing','manual_repairing','reworking','exhausted','superseded')`,
    );
    // 升级前已排队的答复没有 session_role：该任务有 reviewing 链的话，pending 消息几乎
    // 只可能是给审查者的答复（实现回合在审查挂着时进不来）——补成 reviewer，投递才能
    // 送回审查会话（启发式，注释于此备查）。
    await client.execute(
      `UPDATE scheduled_messages SET session_role='reviewer'
       WHERE status='pending' AND session_role IS NULL
         AND mode='queued' AND text LIKE '【答复】%'
         AND task_id IN (SELECT task_id FROM free_review_runs WHERE status='reviewing')`,
    );
    await disarmReservationsOnAcceptedTasks();
  } catch (e) {
    console.warn("[ash] 自由审查旧状态收敛失败,忽略:", e);
  }
}

// 已验收(accepted/merged)自由任务的遗留预约不自愈会变幽灵审查:任务日后被唤醒、再次
// 确认完成时,那条上一个验收生命周期的预约就会启动一轮语境全变的审查。
// **必须在 stage 定型之后再跑一次**:老库的 stage 是空的,accepted/merged 由后面的
// migrateFreeWorkflowMergeStates() 从旧 merge_status 列恢复;只在它之前清一遍,匹配不到
// 任何行,而旧 merge 列随后就被删了,预约永久留存(审查实测:old-merged/old-merging 两条
// 升级后都还 armed)。幂等,匹配 0 行就是空转。
async function disarmReservationsOnAcceptedTasks(): Promise<void> {
  await client.execute(
    `UPDATE free_workflow_states SET review_armed=0, review_run_id=NULL, review_note=NULL
     WHERE review_armed=1 AND task_id IN (
       SELECT id FROM tasks WHERE workflow_mode='free' AND stage IN ('accepted','merged')
     )`,
  );
}

// 辩论模式更名为讨论(duet,2026-08-07):列、mode 值、会话角色一起迁。全部幂等——
// RENAME 在已迁移/新库上报「no such column」被吞掉,UPDATE 匹配 0 行就是空转。
// tasks.duet JSON 里的旧字段(debaterA…)不迁,由 normalizeDuetConfig 兜底读旧写新;
// transcript.jsonl 里的旧事件类型(debate.*)也不迁,读取端归一。
async function migrateDebateToDuet(): Promise<void> {
  try {
    await client.execute("ALTER TABLE tasks RENAME COLUMN debate TO duet");
    console.log("[ash] tasks.debate 列已更名为 duet");
  } catch {
    /* 已迁移或新库 */
  }
  await client.execute("UPDATE tasks SET mode = 'duet' WHERE mode = 'debate'");
  await client.execute("UPDATE sessions SET role = 'voiceA' WHERE role = 'debaterA'");
  await client.execute("UPDATE sessions SET role = 'voiceB' WHERE role = 'debaterB'");
}

// notes.task_id 曾经只能记住最后一次转换。先把老值搬进多对多关联表，再由下面的
// retired-column 清理删掉旧列；顺序不能反，否则用户现存的回链会丢。
async function migrateLegacyNoteTaskLinks(): Promise<void> {
  const info = await client.execute("PRAGMA table_info(notes)");
  if (!info.rows.some((r) => r.name === "task_id")) return;
  await client.execute(`
    INSERT OR IGNORE INTO note_tasks (note_id, task_id, created_at)
    SELECT id, task_id, updated_at
    FROM notes
    WHERE task_id IS NOT NULL AND TRIM(task_id) <> ''
  `);
}

// 退役列:功能改掉后没人再读、但老库里还留着的列。放这里一次性清掉,而不是让
// 它们静静躺着 —— 否则 `db:push` 每次都会拿它们吓唬人(「about to delete
// use_worktree column with 13 items / THIS ACTION WILL CAUSE DATA LOSS」),
// 真正该看的 schema 变更反而淹没在里面,久了就养成无脑 abort 的习惯。
// 新建库压根不会有这些列(上面的 CREATE TABLE 里没有),所以只对老库生效。
// 加一条的前提:全仓 grep 确认没有任何读写,且列里的值已无恢复价值。
const RETIRED_COLUMNS: { table: string; column: string; why: string }[] = [
  // 随手记现在通过 note_tasks 保留每一次转任务记录；迁移函数已先回填老值
  { table: "notes", column: "task_id", why: "随手记改为多任务历史关联" },
  // worktree 从「按分组配」改成「按任务 opt-in」(tasks.use_worktree)后废弃
  { table: "groups", column: "use_worktree", why: "worktree 改为按任务 opt-in" },
  // 「编排组/协调者」被 /team 团队模式取代(groups.owner_task_id + tasks.parent_id)
  { table: "groups", column: "coordinator_task_id", why: "编排组已被 /team 取代" },
  // 事项中心移除后，任务不再回链事项
  { table: "tasks", column: "issue_id", why: "事项中心已移除" },
  // 任务列表不再区分人工优先级，统一按状态/分区和最后更新时间展示
  { table: "tasks", column: "priority", why: "任务优先级已移除" },
  // 自由工作流专属「合并&清理」被统一验收（task-accept）取代，状态列一并退役
  { table: "free_workflow_states", column: "merge_status", why: "自由工作流合并已统一走验收" },
  { table: "free_workflow_states", column: "merge_message", why: "自由工作流合并已统一走验收" },
  { table: "free_workflow_states", column: "merged_at", why: "自由工作流合并已统一走验收" },
  // ssh 执行器整个功能删掉了(换机器改走「接力」):profile 不再记执行位置,
  // 会话也不再记 "local"/"ssh:host"。agents.target 删列前必须先清掉 ssh profile
  // 本身,见 removeSshExecutorProfiles。
  { table: "agents", column: "target", why: "ssh 执行器已移除,执行位置永远是本机" },
  { table: "sessions", column: "target", why: "ssh 执行器已移除,执行位置永远是本机" },
];

// 退役整表与退役列遵循同一原则：新库不创建，老库启动时幂等清理，失败只告警。
// 先删明细表再删主表，兼容未来可能启用外键约束的旧库。
const RETIRED_TABLES: { table: string; why: string }[] = [
  { table: "issue_comments", why: "事项中心已移除" },
  { table: "issues", why: "事项中心已移除" },
];

// 旧自由工作流「合并&清理」的三列（merge_status/message/merged_at）在 DROP 前必须把
// 事实迁走——旧实现先写 merging、Git 合并成功后才落 stage=accepted，「Git 已合、进程在
// 落 stage 前退出」是可达窗口；直接删列就是删掉唯一恢复凭据（审查实测：升级后合并已
// 发生的任务永久卡在未验收，failed 的错误原因也静默丢失）。规则：
// - merged：合并确实完成过 → task.stage 还空着就补成 accepted（不伪造 commit 区间，
//   acceptedMergeCommit 留空，快路验证自会按「无证据」保守处理）。
// - merging：Git 状态不可知 → 不动 stage，只留一条可见的时间线说明，让用户从验收页
//   重新验收（already_merged 走保留式判定，不会重复合并也不会伪造）。
// - failed：把原错误信息留进时间线，不再静默蒸发。
const MERGE_STATE_COLUMNS = new Set(["free_workflow_states.merge_status", "free_workflow_states.merge_message", "free_workflow_states.merged_at"]);

async function migrateFreeWorkflowMergeStates(): Promise<boolean> {
  const info = await client.execute("PRAGMA table_info(free_workflow_states)");
  if (!info.rows.some((r) => r.name === "merge_status")) return true; // 旧列已清，迁移早做完了
  const rows = await client.execute(
    "SELECT task_id, merge_status, merge_message FROM free_workflow_states WHERE merge_status IS NOT NULL AND merge_status != ''",
  );
  if (!rows.rows.length) return true;
  let allMigrated = true;
  const { appendTaskTimeline } = await import("../task-timeline.js");
  for (const row of rows.rows) {
    const taskId = String(row.task_id ?? "");
    const status = String(row.merge_status ?? "");
    if (!taskId) continue;
    try {
      if (status === "merged") {
        await client.execute({
          sql: "UPDATE tasks SET stage = 'accepted' WHERE id = ? AND (stage IS NULL OR stage = '')",
          args: [taskId],
        });
        await appendTaskTimeline(taskId, "升级迁移：上一版「合并&清理」已记录合并完成，验收标记已补上（合并区间无从考证，未伪造）。");
      } else if (status === "merging") {
        // 结构化恢复，不依赖时间线（没跑过会话的任务时间线写不进去）：stage=merged 让
        // 统一验收接管——source branch 还在会正常重合并/识别 already_merged；已清理的
        // 走「stage=merged 人工确认」路径而不是 stage=null 的死路。目标分支按旧实现
        // 同一条规则解析并冻结；commit 区间无从考证，留空（诚实，不伪造）。
        const ctx = (await client.execute({
          sql: "SELECT t.worktree_base AS wb, p.repo_path AS rp FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?",
          args: [taskId],
        })).rows.at(0);
        let target: string | null = null;
        if (ctx?.rp) {
          const { resolveTaskMergeTarget } = await import("../git.js");
          target = await resolveTaskMergeTarget(String(ctx.rp), ctx.wb == null ? null : String(ctx.wb)).catch(() => null) ?? null;
        }
        await client.execute({
          sql: "UPDATE tasks SET stage = 'merged', accepted_target_branch = COALESCE(accepted_target_branch, ?) WHERE id = ? AND (stage IS NULL OR stage = '')",
          args: [target, taskId],
        });
        await appendTaskTimeline(taskId, "升级迁移：上一版验收停在「合并进行中」，Git 合并可能已完成；已按「已合并待确认」恢复，请从验收页重新验收——已合并的会被安全识别，无法核对时会停下等人工确认，不会伪造区间。");
      } else if (status === "failed") {
        const message = String(row.merge_message ?? "").trim();
        // 错误原文是唯一证据：时间线写不进去（任务从没跑过会话）就保留旧列，下次启动再试。
        const wrote = await appendTaskTimeline(taskId, `升级迁移：上一版「合并&清理」失败${message ? `，原始错误：${message}` : ""}；请从验收页重新验收或人工处理。`);
        if (!wrote) {
          console.warn(`[ash] 旧合并失败原因写不进 ${taskId} 的时间线（无会话），本轮保留旧列`);
          allMigrated = false;
        }
      }
      console.log(`[ash] 迁移旧自由工作流合并状态 ${taskId}: ${status}`);
    } catch (e) {
      // 单条失败不拦启动，但这一轮不许删旧列（证据还没迁走），下次启动重试。
      console.warn(`[ash] 旧合并状态迁移失败 ${taskId}(${status})，本轮保留旧列：`, e);
      allMigrated = false;
    }
  }
  return allMigrated;
}

// ssh 执行器功能删掉后,老库里**已注册的 ssh profile 是删列前必须先处理掉的事实**:
// 光 DROP COLUMN 会让那一行原样留下、只丢掉「它跑在别的机器上」这一件事 —— 名字还叫
// claude@build.example、is_default 还挂着,派任务时被当成本机 profile 照常构造出来
// (第 1 轮审查实测:label 仍是 claude@build.example,resume 却已经是本机的
// `cd /repo && claude --resume sid`)。本来明确指向远端的活会**静默改在本机上跑**。
//
// 做法与用户在设置页手删一条 profile 完全一致(routes.ts 的 DELETE /agents/:id):删行,
// 并把**决定以后派给谁**的那些 executor_id 清空——执行随即按 agentType 的默认 profile 降级,
// 这条降级路径本来就是「这条 profile 没了」的既定语义(executors/index.ts 的 pickProfile)。
// 界线是「配置清空、历史保留」:sessions / free_review_runs 记的是那一回合当时真的用了谁,
// 改它就是改历史。sessions.executor_id 尤其不能清——重跑校验正是靠它认出「上一回合那条
// profile 已经没了」并拒绝原样重放(task-retry-turn 的 profileDrift="missing");清成 null
// 反而会让在远端跑过的会话被静默重放到本机,那正是这条迁移要挡的事。
// tasks.duet / tasks.team / mode_presets.config 这类 JSON 里的 executorId 不动:悬空 id 在
// pickProfile 里就是降级到类型默认,与手删 profile 后的现状一致,没必要再去改写用户的配置。
const SSH_PROFILE_REFERENCES: { table: string; column: string; touchUpdatedAt?: boolean }[] = [
  { table: "tasks", column: "executor_id", touchUpdatedAt: true },
  { table: "reviewer_profiles", column: "executor_id" },
  { table: "free_workflow_states", column: "review_executor_id" },
  { table: "scheduled_messages", column: "executor_id" },
];

async function removeSshExecutorProfiles(): Promise<boolean> {
  try {
    const info = await client.execute("PRAGMA table_info(agents)");
    if (!info.rows.some((r) => r.name === "target")) return true; // 列早清了 = 这一步早做完了
    const rows = await client.execute("SELECT id, name, target FROM agents");
    const ssh = rows.rows.filter((r) => {
      try {
        return (JSON.parse(String(r.target ?? "")) as { kind?: string }).kind === "ssh";
      } catch {
        return false; // 读不出来的当本机放过:宁可留一行,也不误删用户的本机 profile
      }
    });
    if (!ssh.length) return true;
    // 老到还没有某一列的库照样得清得动 profile 本身 —— 那种库里也不会有指向它的引用。
    const present = new Set<string>();
    for (const ref of SSH_PROFILE_REFERENCES) {
      const columns = await client.execute(`PRAGMA table_info(${ref.table})`);
      if (columns.rows.some((r) => r.name === ref.column)) present.add(`${ref.table}.${ref.column}`);
    }
    for (const row of ssh) {
      const id = String(row.id);
      for (const ref of SSH_PROFILE_REFERENCES) {
        if (!present.has(`${ref.table}.${ref.column}`)) continue;
        await client.execute({
          sql: `UPDATE ${ref.table} SET ${ref.column} = NULL${ref.touchUpdatedAt ? ", updated_at = ?" : ""} WHERE ${ref.column} = ?`,
          args: ref.touchUpdatedAt ? [new Date().toISOString(), id] : [id],
        });
      }
      await client.execute({ sql: "DELETE FROM agents WHERE id = ?", args: [id] });
      console.warn(
        `[ash] 已删除 ssh 执行器 profile ${String(row.name ?? id)}(${id}):该功能已移除,换机器请改用「接力」;`
        + "指向它的任务/审查者/待发送消息已改回按 CLI 类型的默认执行器",
      );
    }
    return true;
  } catch (e) {
    // 清不干净就把 agents.target 留到下次启动重试:那一列是唯一还认得出 ssh profile 的证据。
    console.warn("[ash] ssh 执行器 profile 清理失败,本轮保留 agents.target:", e);
    return false;
  }
}

// 团队派活自建的内部组：owner 任务已不存在的（旧版删除没做级联）没有任何入口可见或
// 清理，启动时幂等回收（审查实测：真实主库存量 1 条挂 6 个成员）。
async function reclaimOrphanOwnerGroups(): Promise<void> {
  try {
    const gone = await client.execute(
      "DELETE FROM groups WHERE owner_task_id IS NOT NULL AND owner_task_id NOT IN (SELECT id FROM tasks) RETURNING id",
    );
    if (gone.rows.length) console.log(`[ash] 回收 ${gone.rows.length} 个 owner 任务已不存在的内部组`);
    // 组的成员也要处理：lead 行已不存在的 worker 挂着悬空 parent_id，前端只把
    // parentId===null 列为顶层，它们永久不可见（审查实测：主库 6 个 done+accepted 的
    // worker 藏在已消失的团队下）。解绑而不是删除——数据（会话/产物）保留，回到顶层
    // 由用户自行处置；悬空 group_id 一并清。
    const unparented = await client.execute(
      "UPDATE tasks SET parent_id = NULL WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM tasks) RETURNING id",
    );
    if (unparented.rows.length) console.log(`[ash] 解绑 ${unparented.rows.length} 个 lead 已不存在的执行者（回到顶层可见）`);
    const ungrouped = await client.execute(
      "UPDATE tasks SET group_id = NULL WHERE group_id IS NOT NULL AND group_id NOT IN (SELECT id FROM groups) RETURNING id",
    );
    if (ungrouped.rows.length) console.log(`[ash] 清理 ${ungrouped.rows.length} 个悬空的 group 引用`);
  } catch (e) {
    console.warn("[ash] 孤儿内部组回收失败，忽略：", e);
  }
}

async function dropRetiredColumns(skip?: ReadonlySet<string>): Promise<void> {
  for (const { table, column, why } of RETIRED_COLUMNS) {
    if (skip?.has(`${table}.${column}`)) continue; // 事实还没迁走，证据列留到下次启动

    const info = await client.execute(`PRAGMA table_info(${table})`);
    if (!info.rows.some((r) => r.name === column)) continue; // 早就清过了
    try {
      await client.execute(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      console.log(`[ash] 清理退役列 ${table}.${column}(${why})`);
    } catch (e) {
      // 清不掉不该拦住启动(比如老 SQLite 不支持 DROP COLUMN):报一声继续跑,
      // 这列本来就没人读。
      console.warn(`[ash] 退役列 ${table}.${column} 没能清掉,忽略:`, e);
    }
  }
}

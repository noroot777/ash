import * as driverCore from "drizzle-orm/libsql/driver-core";
import type { LibSQLDatabase } from "drizzle-orm/libsql/driver-core";
import { createClient } from "./node-sqlite-client.js";
import * as schema from "./schema.js";
import { ensureAshDbDir, resolveAshDbFile } from "./path.js";
import { runDataMigrations } from "./migrations.js";
import { ensureChatSchema } from "./schema-chat.js";
import { ensurePageAnnotationSchema } from "./schema-page-annotation.js";

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
  await ensurePageAnnotationSchema(client);
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS task_branch_receipts (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source_commit TEXT NOT NULL, merge_commit TEXT NOT NULL, target_branch TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS task_branch_receipts_task ON task_branch_receipts(task_id);
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
      verify_completed_steps TEXT NOT NULL DEFAULT '[]',
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
    CREATE TABLE IF NOT EXISTS monitors (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, command TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running', pid INTEGER, pid_started_at TEXT,
      log_path TEXT NOT NULL, read_offset INTEGER NOT NULL DEFAULT 0,
      events INTEGER NOT NULL DEFAULT 0, exit_code INTEGER,
      started_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      ended_at TEXT, ended_reason TEXT, owner_user_id TEXT,
      kind TEXT NOT NULL DEFAULT 'ash', native_id TEXT, cli_session_id TEXT,
      source_lifetime TEXT NOT NULL DEFAULT 'unknown',
      lifetime_evidence TEXT, source_pid INTEGER, source_pid_started_at TEXT,
      start_evidence TEXT, timeout_ms INTEGER,
      start_anchor_width_ms INTEGER, tool_use_id TEXT,
      source_run TEXT, start_low_at TEXT
    );
    CREATE INDEX IF NOT EXISTS monitors_task ON monitors(task_id);
    CREATE TABLE IF NOT EXISTS monitor_pending_calls (
      task_id TEXT NOT NULL, session_key TEXT NOT NULL, tool_use_id TEXT NOT NULL,
      command TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      at TEXT, source_run TEXT,
      PRIMARY KEY (task_id, session_key, tool_use_id)
    );
    CREATE TABLE IF NOT EXISTS monitor_scan_cursors (
      task_id TEXT NOT NULL, path TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0, read_offset INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (task_id, path)
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
      dispute_reason TEXT, dispute_defer_reason TEXT, dispute_at TEXT,
      dispute_resolution TEXT, dispute_resolved_at TEXT, dispute_resolution_note TEXT,
      dispute_deferred_task_id TEXT,
      started_at TEXT NOT NULL, ended_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS free_review_rounds_run_round_idx
      ON free_review_rounds (run_id, round);
    CREATE TABLE IF NOT EXISTS free_review_debates (
      id TEXT PRIMARY KEY, round_id TEXT NOT NULL, task_id TEXT NOT NULL,
      run_id TEXT NOT NULL, round INTEGER NOT NULL, status TEXT NOT NULL,
      exchanges INTEGER NOT NULL DEFAULT 1, current_seq INTEGER NOT NULL DEFAULT 1,
      verdict TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS free_review_debates_round_idx
      ON free_review_debates (round_id, started_at);
    CREATE INDEX IF NOT EXISTS free_review_debates_task_idx
      ON free_review_debates (task_id, started_at);
    CREATE TABLE IF NOT EXISTS free_review_debate_turns (
      id TEXT PRIMARY KEY, debate_id TEXT NOT NULL, seq INTEGER NOT NULL,
      side TEXT NOT NULL, statement TEXT, status TEXT NOT NULL,
      started_at TEXT NOT NULL, ended_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS free_review_debate_turns_seq_idx
      ON free_review_debate_turns (debate_id, seq);
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
    CREATE TABLE IF NOT EXISTS handoff_local_peer_keys (
      url TEXT PRIMARY KEY, peer_key TEXT NOT NULL, peer_fp TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS handoff_local_key_revisions (
      url TEXT PRIMARY KEY, revision TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS uploads (
      file TEXT PRIMARY KEY, owner_user_id TEXT, task_id TEXT, created_at TEXT NOT NULL
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
      peer_fp TEXT, peer_key TEXT NOT NULL DEFAULT '', peer_key_fp TEXT, created_at TEXT NOT NULL
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
    "ALTER TABLE monitors ADD COLUMN kind TEXT NOT NULL DEFAULT 'ash'",
    "ALTER TABLE monitors ADD COLUMN native_id TEXT",
    "ALTER TABLE monitors ADD COLUMN cli_session_id TEXT",
    // 默认值是 'unknown' 而**不是** 'bounded'：加列那一刻的存量行里，claude 投影的
    // expires_at 是拿 Monitor 入参那个 timeout_ms（请求值）算的，来源侧真钳了就是错的。
    // 填 'bounded' 等于声称「来源确认过这个期限」，把编出来的时刻变成事实。ash 自己起的
    // 哨兵期限确实是自己定的，由紧随其后的那条 UPDATE 刷回 'bounded'（见下）。
    "ALTER TABLE monitors ADD COLUMN source_lifetime TEXT NOT NULL DEFAULT 'unknown'",
    // 期限的**证据**,不是期限本身。新列 ⇒ 旧行必然 NULL,这才是「哪些期限由旧算法推出来」
    // 的可靠版本判据(原来拿 cli_session_id IS NULL 当依据,而那一列更早就有了)。
    "ALTER TABLE monitors ADD COLUMN lifetime_evidence TEXT",
    // 起它的那一代 agent 进程。sessions 那两列每回合被覆盖,不能用来判历史投影的死活。
    "ALTER TABLE monitors ADD COLUMN source_pid INTEGER",
    "ALTER TABLE monitors ADD COLUMN source_pid_started_at TEXT",
    // **起点**的证据,与 lifetime_evidence(时长的证据)分开记:回执能证明配置了多长,不能证明
    // 消息 timestamp 就是计时器起点(计时器在工具返回前就起了,回执要等 PostToolUse hooks)。
    "ALTER TABLE monitors ADD COLUMN start_evidence TEXT",
    // 来源确认的时长。起点不确定时 expires_at 不可信,但时长仍然说得出来。
    "ALTER TABLE monitors ADD COLUMN timeout_ms INTEGER",
    // 起点锚点的误差界。存量行一律 NULL = 无法重验 ⇒ 对外只给时长（见 schema-monitors.ts）。
    "ALTER TABLE monitors ADD COLUMN start_anchor_width_ms INTEGER",
    // 起它的那个 tool_use id。检查点的另一半:位置之前的配对关系靠它从库里重建
    // （见 claude-monitor-commit.ts 的文件头）。存量行 NULL，读到回执时顺手补上。
    "ALTER TABLE monitors ADD COLUMN tool_use_id TEXT",
    // 代次结论与起点下界的持久化依据(见 schema-monitors.ts)。存量行一律 NULL。
    "ALTER TABLE monitors ADD COLUMN source_run TEXT",
    "ALTER TABLE monitors ADD COLUMN start_low_at TEXT",
    "ALTER TABLE handoff_local_peer_keys ADD COLUMN peer_fp TEXT",
    "ALTER TABLE user_handoff_targets ADD COLUMN peer_key_fp TEXT",
    "ALTER TABLE tasks ADD COLUMN started_at TEXT",
    "ALTER TABLE tasks ADD COLUMN goal_turn INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN cli_state TEXT",
    "ALTER TABLE tasks ADD COLUMN ended_at TEXT",
    "ALTER TABLE sessions ADD COLUMN ended_at TEXT",
    "ALTER TABLE groups ADD COLUMN paused INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN archived_at TEXT",
    "ALTER TABLE sessions ADD COLUMN active_ms INTEGER",
    "ALTER TABLE sessions ADD COLUMN turn_started_at TEXT",
    "ALTER TABLE tasks ADD COLUMN use_worktree INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN worktree_base TEXT",
    "ALTER TABLE tasks ADD COLUMN worktree_start_commit TEXT",
    "ALTER TABLE tasks ADD COLUMN merge_target_branch TEXT",
    "ALTER TABLE tasks ADD COLUMN base_task_id TEXT",
    "ALTER TABLE tasks ADD COLUMN accepted_source_commit TEXT",
    "ALTER TABLE tasks ADD COLUMN base_update_intent TEXT",
    "ALTER TABLE tasks ADD COLUMN origin_task_id TEXT",
    "ALTER TABLE tasks ADD COLUMN creation_origin TEXT",
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
    "ALTER TABLE tasks ADD COLUMN question_history TEXT",
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
    // 「新任务默认开不开 worktree」从 app_settings 搬到项目这一层（2026-09-14）。
    // 老库的那颗全局值由 migrations.ts 的 migrateWorktreeDefaultToProjects 灌进存量
    // 项目 —— 它必须跑在这句 ADD COLUMN 之后，所以别把数据迁移挪到 DDL 前面。
    "ALTER TABLE projects ADD COLUMN use_worktree_default INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE tasks ADD COLUMN workflow TEXT",
    // 独立审查任务与被审目标的关系；review_requested 只在团队 dispatch worker 上置位。
    "ALTER TABLE tasks ADD COLUMN review_of TEXT",
    "ALTER TABLE tasks ADD COLUMN review_round INTEGER",
    "ALTER TABLE tasks ADD COLUMN review_requested INTEGER NOT NULL DEFAULT 0",
    // 就地验证轮：验证不再另起一个审查任务，而是在原任务上多跑一个旁路回合。
    // review_of/review_round 保留，只为让历史那批独立审查任务仍能读出来。
    "ALTER TABLE tasks ADD COLUMN verify_round INTEGER",
    "ALTER TABLE tasks ADD COLUMN verify_rounds INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN verify_completed_steps TEXT NOT NULL DEFAULT '[]'",
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
    // 这条消息是谁写的。null = 真人；"monitor:<id>" = 某个哨兵推来的事件。两件事靠它：
    // 同一个哨兵还没送出去的事件合并进同一行（一次唤醒看完全部，而不是一行一个回合），
    // 投递时标 byBackend 让它在会话里显示成系统代写而不是用户发言。
    "ALTER TABLE scheduled_messages ADD COLUMN origin TEXT",
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
    // 执行者驳回审查结论那条支线（理由 + 用户裁定）；老库补列即可，空 = 没驳回过。
    "ALTER TABLE free_review_rounds ADD COLUMN dispute_reason TEXT",
    "ALTER TABLE free_review_rounds ADD COLUMN dispute_at TEXT",
    "ALTER TABLE free_review_rounds ADD COLUMN dispute_resolution TEXT",
    "ALTER TABLE free_review_rounds ADD COLUMN dispute_resolved_at TEXT",
    // 第三条出路：「意见成立但越界，建议转独立任务」的理由，以及裁定后建出的那个任务。
    "ALTER TABLE free_review_rounds ADD COLUMN dispute_defer_reason TEXT",
    "ALTER TABLE free_review_rounds ADD COLUMN dispute_deferred_task_id TEXT",
    // 裁定时用户写给执行者的要点（三档裁定表达不了的那部分结论，多半是辩论里达成的方案）。
    "ALTER TABLE free_review_rounds ADD COLUMN dispute_resolution_note TEXT",
    // 统一验收的结构化合并落账（目标分支 + 合并前后 commit），合并后基线审查靠它。
    "ALTER TABLE tasks ADD COLUMN accepted_target_branch TEXT",
    "ALTER TABLE tasks ADD COLUMN accepted_base_commit TEXT",
    "ALTER TABLE tasks ADD COLUMN accepted_merge_commit TEXT",
    "ALTER TABLE tasks ADD COLUMN accepted_tail_pending INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN accepted_tail_done TEXT NOT NULL DEFAULT '[]'",
    // 「怎么合的」与「不提交那一档留在索引里的内容指纹」：null 的 accepted_merge_commit
    // 有两种含义，UI 不能靠猜（见 schema.ts 上那两段注释）。
    "ALTER TABLE tasks ADD COLUMN accepted_merge_method TEXT",
    "ALTER TABLE tasks ADD COLUMN accepted_pending_tree TEXT",
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
    // 项目级预览命令。空 = 按各语言惯例自动识别（preview-command.ts）。
    "ALTER TABLE projects ADD COLUMN preview_command TEXT",
    "ALTER TABLE projects ADD COLUMN preview_config TEXT",
    // 常用命令（状态栏启停的常驻服务），JSON 数组。见 shared/src/project-commands.ts。
    "ALTER TABLE projects ADD COLUMN commands_config TEXT",
    // 验收合并完落不落提交（1 = 老行为，落提交）。见 db/schema.ts 同名列。
    "ALTER TABLE projects ADD COLUMN accept_commit INTEGER NOT NULL DEFAULT 1",
    // 项目级浏览器登录态授权白名单（JSON 字符串数组）。空/null = 不授权,是默认。
    "ALTER TABLE projects ADD COLUMN browser_cdp_domains TEXT",
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
    "ALTER TABLE scheduled_messages ADD COLUMN execution INTEGER NOT NULL DEFAULT 0",
    // 这一轮实际跑在谁名下(= 注入 CLAUDE_CONFIG_DIR/CODEX_HOME 的那个人)。接力搬会话
    // 文件按它找,不按任务归属人 —— 跨人回合两者不是一回事(见 db/schema.ts 同名列)。
    "ALTER TABLE sessions ADD COLUMN run_owner_user_id TEXT",
    // 这一轮**注进去的那个配置目录**本身。归属人算得出目录,但目录会随实例设置整体
    // 挪位置(「CLI 额度」共用 ⇄ 隔离),所以「这条会话的文件在哪」只能记下来,不能现算
    // (见 db/schema.ts 同名列)。老行为 null,读侧回落到按归属人现算。
    "ALTER TABLE sessions ADD COLUMN cli_config_dir TEXT",
    // 入站接力来源:谁批的 + 对端自报的实例模式(§十一 知情批准)。
    "ALTER TABLE handoff_peers ADD COLUMN approved_by TEXT",
    "ALTER TABLE handoff_peers ADD COLUMN peer_mode TEXT NOT NULL DEFAULT ''",
    // 这次配对申请代表本机的哪个账号(源机带的对端 key 认出来的)。多人模式下认不出
    // 主人就不受理,所以空值只见于单人时期或升级前的存量行(见 handoff-peers.ts
    // peerAudience)。
    "ALTER TABLE handoff_peers ADD COLUMN requested_by_user_id TEXT",
  ]) {
    try {
      await client.execute(sql);
    } catch {
      /* column already exists */
    }
  }
  // **必须排在上面那串容错 ALTER 之后**：这条索引引用 `native_id`，而老库那一列是靠
  // ALTER 补上的。放进上面的建表块里会要了命——`CREATE TABLE IF NOT EXISTS` 对已存在的
  // 表什么都不做（不补列），索引紧接着引用一个还不存在的列，整个 executeMultiple 抛出，
  // ensureSchema 崩掉 = 整台 ash 起不来。2026-10-14 在真实库副本上实测到这一条。
  //
  // 索引本身的用途：claude 内置 Monitor 的投影按 native_id 认人，同一个后台任务的
  // task_started / task_notification 要 upsert 成同一行；唯一性同时挡住重放同一段 stream
  // 时的重复落库（回归 test-claude-monitor-parse.ts「重放幂等」钉的就是它）。
  //
  // **身份里必须带上来源会话。** native_id 的唯一性由来源侧保证，而来源侧只承诺在一条 CLI
  // 会话内唯一 —— 同一个任务上先后两条 claude 会话（续聊、接管、重试）各自编号，撞上同一个
  // id 时，旧的 (task_id, native_id) 会把乙的事实 upsert 到甲那一行上：一张卡串两条监听，
  // 另一张干脆不出现（第 13 轮审查 N1）。cli_session_id 为空的是存量行，COALESCE 成空串让
  // 它们彼此之间仍然互斥（旧索引保证过的那部分唯一性一点不丢）。
  try {
    await client.execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS monitors_native_session"
      + " ON monitors(task_id, COALESCE(cli_session_id,''), native_id) WHERE native_id IS NOT NULL",
    );
    // 旧的窄索引必须**拆掉**：留着它就还在按 (task_id, native_id) 拦,上面那条等于没加。
    await client.execute("DROP INDEX IF EXISTS monitors_native");
  } catch (e) {
    console.warn("[ash] monitors_native_session 索引创建失败,忽略:", e);
  }
  // ash 自己起的哨兵期限是它自己定的,`bounded` 对它恒成立 —— 上面那个 ALTER 为了不给
  // claude 投影编期限把默认值设成了 'unknown',这里把 ash 那半刷回来；证据列同理补 'self'
  // （新列对存量行一律 NULL,而 NULL 的语义是「旧算法推的、不可信」,对 ash 行不成立）。幂等。
  try {
    await client.execute("UPDATE monitors SET source_lifetime='bounded' WHERE kind='ash' AND source_lifetime<>'bounded'");
    await client.execute("UPDATE monitors SET lifetime_evidence='self' WHERE kind='ash' AND lifetime_evidence IS NULL");
    // ash 行的起点就是 ash 自己 spawn 那一刻,从来没有不确定性 —— 档位 'observed'、误差界 0。
    // **这两句必须成对**:只补档位不补误差界的话,存量 ash 行会因为「无法重验」而丢掉期限
    // (第 7 轮把起点判据从结论字符串换成了可重验的误差界)。
    await client.execute("UPDATE monitors SET start_evidence='observed' WHERE kind='ash' AND start_evidence IS NULL");
    await client.execute("UPDATE monitors SET start_anchor_width_ms=0 WHERE kind='ash' AND start_anchor_width_ms IS NULL");
  } catch {
    /* 列还不存在 */
  }
  await ensureChatSchema(client);
  // DDL 到此为止。剩下那一半(一次性数据搬运 + 退役字段/表清理)在 `migrations.ts`。
  await runDataMigrations(client);
}

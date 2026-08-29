import * as driverCore from "drizzle-orm/libsql/driver-core";
import type { LibSQLDatabase } from "drizzle-orm/libsql/driver-core";
import { createClient } from "./node-sqlite-client.js";
import * as schema from "./schema.js";
import { ensureAshDbDir, resolveAshDbFile } from "./path.js";
import { runDataMigrations } from "./migrations.js";

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
    CREATE TABLE IF NOT EXISTS handoff_local_peer_keys (
      url TEXT PRIMARY KEY, peer_key TEXT NOT NULL, updated_at TEXT NOT NULL
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
  // DDL 到此为止。剩下那一半(一次性数据搬运 + 退役字段/表清理)在 `migrations.ts`。
  await runDataMigrations(client);
}

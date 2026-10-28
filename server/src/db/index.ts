import * as driverCore from "drizzle-orm/libsql/driver-core";
import type { LibSQLDatabase } from "drizzle-orm/libsql/driver-core";
import { createClient } from "./node-sqlite-client.js";
import * as schema from "./schema.js";
import { ensureAshDbDir, resolveAshDbFile } from "./path.js";
import { runDataMigrations } from "./migrations.js";
import { COLUMN_MIGRATIONS } from "./column-migrations.js";
import { ensureChatSchema } from "./schema-chat.js";
import { ensureHandoffTokenUnique } from "./handoff-token-index.js";
import { ensureFreeWorkflowSchema } from "./schema-free-workflow.js";
import { ensureAcceptGateSchema } from "./schema-accept-gate.js";
import { ensureTaskBackgroundSchema } from "./schema-task-background.js";
import { ensureRegressionChecksSchema } from "./schema-regression-checks.js";
import { ensureRegressionEvidenceSchema } from "./schema-regression-evidence.js";
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
    CREATE TABLE IF NOT EXISTS task_memos (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, body TEXT NOT NULL,
      owner_user_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS task_memos_task_idx ON task_memos (task_id);
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
      active_ms INTEGER, turn_started_at TEXT, turns_started INTEGER,
      turns_lost INTEGER, turns_base INTEGER, turns_base_approx INTEGER
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
      delivering_since TEXT, checkpoint_taken TEXT, handoff_token TEXT,
      review_run TEXT, review_round INTEGER
    );
    CREATE TABLE IF NOT EXISTS session_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      cwd TEXT,
      started_at TEXT NOT NULL,
      -- 可空：null = 这一回合开始了还没收口（见 schema.ts 上那段注释）。唯一索引
      -- （session_id, started_at）由 migrate-session-turns.ts 在去重之后建——老库里可能
      -- 已经有重复行，在这里建会抛，而这一段抛出去就是整台 ash 起不来。
      ended_at TEXT,
      -- 这一回合**自己**的结局（completed/failed/stopped）。可空：存量行与收尾没落成的行都是
      -- null = 「不知道」，读端据此不给失败现场（见 schema.ts 上那段注释）。
      outcome TEXT
    );
    CREATE INDEX IF NOT EXISTS session_turns_task_idx ON session_turns(task_id, started_at);
    CREATE INDEX IF NOT EXISTS session_turns_session_idx ON session_turns(session_id, started_at);
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
      source_run TEXT, start_low_at TEXT, source_role TEXT,
      source_review_run TEXT, source_review_round INTEGER,
      unit_token TEXT, ended_by TEXT,
      results_abandoned_at TEXT, results_abandoned_reason TEXT,
      result_handoff_at TEXT, result_handoff_text TEXT,
      stop_when TEXT, hit_line TEXT
    );
    CREATE INDEX IF NOT EXISTS monitors_task ON monitors(task_id);
    CREATE TABLE IF NOT EXISTS monitor_reclaim_debts (
      monitor_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
      pid INTEGER NOT NULL, pid_started_at TEXT, spawn_anchor_ms INTEGER,
      command TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
      last_error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, last_attempt_at TEXT,
      unit_token TEXT, closed_at TEXT, closed_note TEXT,
      identity_disproved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_cleanup_debts (
      unit_token TEXT PRIMARY KEY,
      task_id TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL DEFAULT '',
      root_pid INTEGER, root_started_at TEXT,
      track_path TEXT, out_path TEXT,
      state TEXT NOT NULL DEFAULT 'unknown', detail TEXT NOT NULL DEFAULT '',
      unit_verdict TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, last_attempt_at TEXT,
      closed_at TEXT, closed_note TEXT, open_members TEXT
    );
    CREATE TABLE IF NOT EXISTS monitor_pending_calls (
      task_id TEXT NOT NULL, session_key TEXT NOT NULL, tool_use_id TEXT NOT NULL,
      command TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      at TEXT, source_run TEXT NOT NULL DEFAULT '', cli_session_id TEXT,
      PRIMARY KEY (task_id, session_key, source_run, tool_use_id)
    );
    CREATE TABLE IF NOT EXISTS monitor_scan_cursors (
      task_id TEXT NOT NULL, path TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0, read_offset INTEGER NOT NULL DEFAULT 0,
      probe INTEGER NOT NULL DEFAULT 0, gaps TEXT NOT NULL DEFAULT '[]',
      source TEXT, semantics INTEGER,
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
  for (const sql of COLUMN_MIGRATIONS) {
    try {
      await client.execute(sql);
    } catch {
      /* column already exists */
    }
  }
  // claim_origin **没有任何回填扫描** —— 这是刻意的。曾按「created_at 早于
  // MIN(users.created_at)」把无标记行补成 'conversion'(第 9 轮复审 R4),但那条判据默认了
  // claim_origin 列一直存在;列本身就是上面那串容错 ALTER 补出来的,老库(列还没出生的版本)
  // 升级那一刻全部存量行都是 NULL —— 其中带回拨时钟写入的真私有行,当年打标机制不存在、
  // 'user' 戳无从落下,与转换代管行在数据上完全同形(第 10 轮审查 R1 拆列重放实测:升级后
  // 私有行被标成 conversion,可信产物清单一补 taskId 就对项目成员敞开)。时间证明不了来历,
  // NULL 也不等于 conversion。所以共享资格只认**写入时刻记死的显式标记**:claimExistingUploads
  // 统一代管时落 'conversion',registerUpload 本人上传落 'user';证明不了来历的存量行一律按
  // 真私有保守处理,确属旧转换代管的走 POST /uploads/:file/claim 的本人确认出口
  // (uploads.ts repairUploadClaim)补归属。
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
  //
  // **来源不一定是个 CLI 会话号,也可以是「哪个 run 文件」。** 历史文件里有一类记录从头到尾
  // 不报 session_id,这时归属只能留未知(claude-monitor-scan.ts)。按 COALESCE(cli,'') 建
  // 身份的话,两个 run 文件里的同号监听又争同一个唯一键:第二张卡插不进去,而读取位置照常
  // 推到末尾 —— 那张卡再也不会出现(第 8 轮审查 N2)。所以未知归属时拿 `source_run` 顶上:
  // 一个 run 文件 = 一次进程启动 = 一个 CLI 会话,这是手上仅有、也足够的身份依据。
  //
  // 新键比旧键**更细**(已知归属的行一模一样,未知归属的行从「挤在同一个空串」变成按 run
  // 分开),所以存量库一定建得起来,不会因为老数据撞键而失败。
  try {
    await client.execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS monitors_native_source"
      + " ON monitors(task_id, COALESCE(cli_session_id, 'run:' || COALESCE(source_run,'')), native_id)"
      + " WHERE native_id IS NOT NULL",
    );
    // 旧的那两条必须**拆掉**：留着任何一条,它都还在按更粗的身份拦,上面这条等于没加。
    await client.execute("DROP INDEX IF EXISTS monitors_native_session");
    await client.execute("DROP INDEX IF EXISTS monitors_native");
  } catch (e) {
    console.warn("[ash] monitors_native_source 索引创建失败,忽略:", e);
  }
  // 一份结果交接只许对应一条消息（含存量重复时的身份归并，理由在那个文件顶部）。
  await ensureHandoffTokenUnique(client);
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
  await ensureFreeWorkflowSchema(client);
  await ensureAcceptGateSchema(client);
  await ensureTaskBackgroundSchema(client);
  await ensureRegressionChecksSchema(client);
  await ensureRegressionEvidenceSchema(client);
  // DDL 到此为止。剩下那一半(一次性数据搬运 + 退役字段/表清理)在 `migrations.ts`。
  await runDataMigrations(client);
}

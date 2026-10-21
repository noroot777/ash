import * as driverCore from "drizzle-orm/libsql/driver-core";
import type { LibSQLDatabase } from "drizzle-orm/libsql/driver-core";
import { createClient } from "./node-sqlite-client.js";
import * as schema from "./schema.js";
import { ensureAshDbDir, resolveAshDbFile } from "./path.js";
import { runDataMigrations } from "./migrations.js";
import { ensureChatSchema } from "./schema-chat.js";
import { ensureHandoffTokenUnique } from "./handoff-token-index.js";
import { ensureFreeWorkflowSchema } from "./schema-free-workflow.js";
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
      ended_at TEXT
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
      result_handoff_at TEXT, result_handoff_text TEXT
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
  for (const sql of [
    "ALTER TABLE monitors ADD COLUMN kind TEXT NOT NULL DEFAULT 'ash'",
    // 读取层的两份独立状态:可续读位置 probe、永久缺口全集 gaps(JSON 数组)。
    "ALTER TABLE monitor_scan_cursors ADD COLUMN probe INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE monitor_scan_cursors ADD COLUMN gaps TEXT NOT NULL DEFAULT '[]'",
    // 这个文件报的 CLI 身份:来源**全集**的持久依据(第 6 轮审查 N2)。旧行 NULL = 还没读到过,
    // 那时「只有我这一个来源」证明不了,于是不认领无归属的存量行 —— 保守的那一边。
    "ALTER TABLE monitor_scan_cursors ADD COLUMN source TEXT",
    // 这份位置是哪一代消费语义下确认的（第 9/10 轮审查）。旧行 NULL = 第一代,没有当代戳的
    // 一律重放一遍 —— 旧代确认掉的事实（被键挤掉的卡、没合并的终态）只能靠重读补回来。
    "ALTER TABLE monitor_scan_cursors ADD COLUMN semantics INTEGER",
    // 调用发生时那一行报的 CLI 身份。旧行 NULL = 当初没记,那时只能靠 source_run 自证来源
    // (键的重建在 migrations.ts 的 repairPendingCallKey —— SQLite 改不了主键)。
    "ALTER TABLE monitor_pending_calls ADD COLUMN cli_session_id TEXT",
    // 身份还没补全时,把「那一刻 spawn 的」这个时间锚留在债上:哨兵行和身份边条都可能先没了,
    // 而缺了锚,一次查询失败就被永久固化成「这条证不出身份」(第 10 轮审查 F2-B)。
    "ALTER TABLE monitor_reclaim_debts ADD COLUMN spawn_anchor_ms INTEGER",
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
    // 起它的那条会话的角色。审查是旁路回合,跑在自己那条 reviewer 会话上 —— 少了它,
    // 审查者挂的哨兵醒来时叫的是执行者(见 schema-monitors.ts 的 source_role)。
    "ALTER TABLE monitors ADD COLUMN source_role TEXT",
    // 起它的那次审查(free_review_runs.id)。角色说得出「叫审查者」,说不出「叫哪一次审查
    // 的审查者」——而任务终态清理、事件出口、唤醒配置三处都要后者(见 schema-monitors.ts
    // 的 source_review_run)。存量行 NULL。
    "ALTER TABLE monitors ADD COLUMN source_review_run TEXT",
    // 起它的是那次审查的**第几轮**。run.id 跨轮复用(nextRound 把同一个 run 的
    // current_round 加 1、status 推回 reviewing),所以只有 runId 不是跨轮隔离证明:
    // 第 1 轮遗留的事件会在第 2 轮被重新解释成有效输入。存量行 NULL = 只按 run 判。
    "ALTER TABLE monitors ADD COLUMN source_review_round INTEGER",
    // 这一次创建独有的资源记号:归属与整项退出的唯一凭证(见 schema-monitors.ts)。
    // 存量行一律 NULL ⇒ 孤儿后代只能落「证不出」,记责任、不下刀(第 12 轮审查 F1)。
    "ALTER TABLE monitors ADD COLUMN unit_token TEXT",
    // 「谁让它停的」。status=stopped 有三种来由(主动点停 / 推满事件上限 / 系统回收),
    // 拿 status 代替来源会把后两种说成「本回合撤掉了哨兵」(第 1 轮审查 N1)。存量行 NULL
    // = 来源不详,一律不算主动撤。
    "ALTER TABLE monitors ADD COLUMN ended_by TEXT",
    // 「它还没送到的结果我不要了」这句话本体。**不是 ended_by**(那是「谁让进程结束的」):
    // 已经 exited 的哨兵不是被谁停的,拿 ended_by 当放弃凭证就等于那条出路对它永远无效
    // (第 2 轮审查 R2-3)。存量行 NULL = 没人放弃过。
    "ALTER TABLE monitors ADD COLUMN results_abandoned_at TEXT",
    "ALTER TABLE monitors ADD COLUMN results_abandoned_reason TEXT",
    // 「结局已写定、结束通知还没入队」那一瞬的责任凭证(时刻 + 原文)。少了它,那条缝里完成闸
    // 看不见任何东西,任务落 done 把唯一的结果通知吃掉(第 1 轮审查 F1)。存量行 NULL = 不在交接中。
    "ALTER TABLE monitors ADD COLUMN result_handoff_at TEXT",
    "ALTER TABLE monitors ADD COLUMN result_handoff_text TEXT",
    // 「这一行现在是第几版证据」。销账/收档拿它当条件,免得删掉的是别人刚落下的那一版
    // (见 schema-sessions.ts 的 version、第 3 轮审查 F2)。存量行一律 0。
    "ALTER TABLE agent_cleanup_debts ADD COLUMN version INTEGER NOT NULL DEFAULT 0",
    // 即时清理点名了、却排除不掉的那几个号(见 schema-sessions.ts 的 open_members、第 8 轮
    // 审查 F1-A)。少了它,清扫侧用另一套设备的「没有」就把这份责任洗掉了。存量行 NULL =
    // 没点名过谁,判据退回原来那几台设备。
    "ALTER TABLE agent_cleanup_debts ADD COLUMN open_members TEXT",
    "ALTER TABLE monitor_reclaim_debts ADD COLUMN unit_token TEXT",
    // 「线索追到这里为止」的戳。**不是销账**:整项退出在当前平台证不出,所以行留着只盖戳
    // (见 schema-monitors.ts 的 closed_at、第 13 轮审查 F1-B)。存量行 NULL = 还在追。
    "ALTER TABLE monitor_reclaim_debts ADD COLUMN closed_at TEXT",
    "ALTER TABLE monitor_reclaim_debts ADD COLUMN closed_note TEXT",
    // 「这个号已经被反证过」的戳 —— 反证不许在下一次尝试/另一个消费者/重启后退化成「未知」
    // 再走时间锚那条弱判据(见 schema-monitors.ts 的 identity_disproved_at、第 17 轮审查 F1)。
    // 存量行一律 NULL = 还没有过反证。
    "ALTER TABLE monitor_reclaim_debts ADD COLUMN identity_disproved_at TEXT",
    // 这条消息已经把任务行上那段续跑交代**接走了**,正文里带着它(见 schema.ts 的
    // checkpoint_taken)。持久账本:取走只写在内存里的话,送达之前进程一换,那段交代
    // 就两边都不在了(第 2 轮审查 F4)。存量行 NULL。
    "ALTER TABLE scheduled_messages ADD COLUMN checkpoint_taken TEXT",
    // 这条消息承载的是哪一笔结果交接。身份跟入队同一笔落库,于是「这一笔送过没有」有一个原子
    // 的答案——重投器据此不把同一条结束通知送成两条、把 agent 叫醒两次(第 2 轮审查 N1)。
    // 存量行 NULL = 不是交接。
    "ALTER TABLE scheduled_messages ADD COLUMN handoff_token TEXT",
    // 那段续跑交代的随身凭证:来源 + 取走时的占用代次(见 schema.ts)。存量行 NULL = 老账本,
    // 按「来源未知」处理(退回时不改来源列,照旧只认代次)。
    "ALTER TABLE scheduled_messages ADD COLUMN checkpoint_auto INTEGER",
    "ALTER TABLE scheduled_messages ADD COLUMN checkpoint_generation INTEGER",
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
    // 回合计数：产物归属据它判断「有没有回合没落账」（见 schema 上的注释）。
    "ALTER TABLE sessions ADD COLUMN turns_started INTEGER",
    "ALTER TABLE sessions ADD COLUMN turns_base INTEGER",
    "ALTER TABLE sessions ADD COLUMN turns_base_approx INTEGER",
    "ALTER TABLE sessions ADD COLUMN turns_lost INTEGER",
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
    // 那段续跑指令是系统自己写的(哨兵闸)还是人/agent 写的 —— 只有前者可以在阻塞物消失后
    // 自动清掉(第 2 轮审查 R2-2)。存量行一律 0 = 当成人写的,不会被自动抹掉。
    "ALTER TABLE tasks ADD COLUMN resume_prompt_auto INTEGER NOT NULL DEFAULT 0",
    // 这一格被占用的第几次。来源列只在「文字还在」时有意义,所以一段在途的退回必须靠代次
    // 判断自己是否已经过期 —— 否则它会继承到别人的来源(第 2 轮审查 F2)。存量行 0。
    "ALTER TABLE tasks ADD COLUMN resume_prompt_generation INTEGER NOT NULL DEFAULT 0",
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
    // 这一次运行独有的**资源记号**(种进 agent 的环境,见 executors/spawn.ts)。跟上面那几列
    // 一样是「重启后找回」的线索,但它回答的是另一个问题:pid 只认得出根,记号跟着 exec
    // 继承到每一个后代 —— 根死了之后还留在后台的那些仍然自证身份。
    "ALTER TABLE sessions ADD COLUMN agent_unit_token TEXT",
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
    // 这条消息续起来的那一轮审查(run + 轮次)。存量行为空 = 不绑任何一轮,
    // 投递时按显式的「不绑」处理,不退回「查最新那一轮」(本轮审查 F2)。
    "ALTER TABLE scheduled_messages ADD COLUMN review_run TEXT",
    "ALTER TABLE scheduled_messages ADD COLUMN review_round INTEGER",
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
  // DDL 到此为止。剩下那一半(一次性数据搬运 + 退役字段/表清理)在 `migrations.ts`。
  await runDataMigrations(client);
}

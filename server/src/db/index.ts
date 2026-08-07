import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import * as schema from "./schema.js";
import { ensureHarnessDbDir, resolveHarnessDbFile } from "./path.js";

const dbFile = resolveHarnessDbFile();
ensureHarnessDbDir(dbFile);

// libsql: N-API prebuilt binary (no node-gyp), ABI-stable across Node versions.
const client = createClient({ url: `file:${dbFile}` });

export const db = drizzle(client, { schema });

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
      priority TEXT NOT NULL DEFAULT 'none',
      review_of TEXT, review_round INTEGER, review_requested INTEGER NOT NULL DEFAULT 0,
      verify_round INTEGER, verify_rounds INTEGER NOT NULL DEFAULT 0,
      verify_station_rounds INTEGER NOT NULL DEFAULT 0,
      labels TEXT NOT NULL DEFAULT '[]', depends_on TEXT NOT NULL DEFAULT '[]',
      resume_depends_on TEXT NOT NULL DEFAULT '[]',
      agent_type TEXT, executor_id TEXT, model TEXT, reasoning_effort TEXT,
      auto_title INTEGER NOT NULL DEFAULT 0, duet TEXT, schedule_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, ended_at TEXT,
      archived INTEGER NOT NULL DEFAULT 0, archived_at TEXT
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '{"kind":"local"}', model TEXT,
      extra_args TEXT NOT NULL DEFAULT '[]', reasoning_effort TEXT, speed TEXT,
      is_default INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS team_presets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, config TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL,
      agent_type TEXT NOT NULL, executor TEXT NOT NULL, target TEXT NOT NULL,
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
      status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, sent_at TEXT
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
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY, builtin_key TEXT, name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', def TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS workflows_builtin_idx ON workflows (builtin_key);
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
    // 正交验收阶段，只用于展示与协作，不进入 TaskStatus 调度/结算
    "ALTER TABLE tasks ADD COLUMN stage TEXT",
    // 正交列表展示字段：null=未置顶，整数毫秒时间戳用于多个置顶任务排序
    "ALTER TABLE tasks ADD COLUMN pinned_at INTEGER",
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
    // 定时发送的 @指派：连执行器、模型、思考强度一起记住，到点还是跑用户当时选的那一套。
    "ALTER TABLE scheduled_messages ADD COLUMN executor_id TEXT",
    "ALTER TABLE scheduled_messages ADD COLUMN model TEXT",
    "ALTER TABLE scheduled_messages ADD COLUMN reasoning_effort TEXT",
    // 排队追问：运行中发出的消息不看时间，任务一空闲就投递（timed 是老的定时发送）。
    "ALTER TABLE scheduled_messages ADD COLUMN mode TEXT NOT NULL DEFAULT 'timed'",
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
  ]) {
    try {
      await client.execute(sql);
    } catch {
      /* column already exists */
    }
  }
  await migrateLegacyNoteTaskLinks();
  await migrateDebateToDuet();
  await dropRetiredColumns();
  await dropRetiredTables();
}

// 辩论模式更名为讨论(duet,2026-08-07):列、mode 值、会话角色一起迁。全部幂等——
// RENAME 在已迁移/新库上报「no such column」被吞掉,UPDATE 匹配 0 行就是空转。
// tasks.duet JSON 里的旧字段(debaterA…)不迁,由 normalizeDuetConfig 兜底读旧写新;
// transcript.jsonl 里的旧事件类型(debate.*)也不迁,读取端归一。
async function migrateDebateToDuet(): Promise<void> {
  try {
    await client.execute("ALTER TABLE tasks RENAME COLUMN debate TO duet");
    console.log("[harness] tasks.debate 列已更名为 duet");
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
];

// 退役整表与退役列遵循同一原则：新库不创建，老库启动时幂等清理，失败只告警。
// 先删明细表再删主表，兼容未来可能启用外键约束的旧库。
const RETIRED_TABLES: { table: string; why: string }[] = [
  { table: "issue_comments", why: "事项中心已移除" },
  { table: "issues", why: "事项中心已移除" },
];

async function dropRetiredColumns(): Promise<void> {
  for (const { table, column, why } of RETIRED_COLUMNS) {
    const info = await client.execute(`PRAGMA table_info(${table})`);
    if (!info.rows.some((r) => r.name === column)) continue; // 早就清过了
    try {
      await client.execute(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      console.log(`[harness] 清理退役列 ${table}.${column}(${why})`);
    } catch (e) {
      // 清不掉不该拦住启动(比如老 SQLite 不支持 DROP COLUMN):报一声继续跑,
      // 这列本来就没人读。
      console.warn(`[harness] 退役列 ${table}.${column} 没能清掉,忽略:`, e);
    }
  }
}

async function dropRetiredTables(): Promise<void> {
  for (const { table, why } of RETIRED_TABLES) {
    try {
      const found = await client.execute({
        sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        args: [table],
      });
      if (!found.rows.length) continue;
      await client.execute(`DROP TABLE IF EXISTS ${table}`);
      console.log(`[harness] 清理退役表 ${table}(${why})`);
    } catch (e) {
      console.warn(`[harness] 退役表 ${table} 没能清掉,忽略:`, e);
    }
  }
}

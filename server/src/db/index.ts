import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import * as schema from "./schema.js";
import { ensureHarnessDbDir, resolveHarnessDbFile } from "./path.js";

const dbFile = resolveHarnessDbFile();
ensureHarnessDbDir(dbFile);

// libsql: N-API prebuilt binary (no node-gyp), ABI-stable across Node versions.
const client = createClient({ url: `file:${dbFile}` });

export const db = drizzle(client, { schema });

// Minimal bootstrap so the app runs without a separate migration step in dev.
// `npm run db:push` (drizzle-kit) remains the source of truth for migrations.
export async function ensureSchema() {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'parallel',
      paused INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, group_id TEXT, parent_id TEXT,
      title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL DEFAULT 'single',
      status TEXT NOT NULL DEFAULT 'backlog', priority TEXT NOT NULL DEFAULT 'none',
      labels TEXT NOT NULL DEFAULT '[]', depends_on TEXT NOT NULL DEFAULT '[]',
      resume_depends_on TEXT NOT NULL DEFAULT '[]',
      agent_type TEXT, executor_id TEXT, auto_title INTEGER NOT NULL DEFAULT 0, debate TEXT, schedule_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, ended_at TEXT,
      archived INTEGER NOT NULL DEFAULT 0, archived_at TEXT
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '{"kind":"local"}', model TEXT,
      extra_args TEXT NOT NULL DEFAULT '[]', reasoning_effort TEXT, speed TEXT,
      is_default INTEGER NOT NULL DEFAULT 0
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
      attachments TEXT NOT NULL DEFAULT '[]', agent TEXT, send_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, sent_at TEXT
    );
    CREATE TABLE IF NOT EXISTS issues (
      id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '', source_text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open', priority TEXT NOT NULL DEFAULT 'none',
      labels TEXT NOT NULL DEFAULT '[]', ai_backend TEXT,
      attachments TEXT NOT NULL DEFAULT '[]',
      parsed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS issue_comments (
      id TEXT PRIMARY KEY, issue_id TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '{"kind":"human"}',
      body TEXT NOT NULL DEFAULT '', attachments TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL, updated_at TEXT,
      status TEXT
    );
    CREATE TABLE IF NOT EXISTS llm_providers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      protocol TEXT NOT NULL DEFAULT 'openai', base_url TEXT NOT NULL,
      api_key TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
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
    "ALTER TABLE tasks ADD COLUMN issue_id TEXT",
    "ALTER TABLE projects ADD COLUMN api_keys TEXT",
    "ALTER TABLE issues ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE issue_comments ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE issue_comments ADD COLUMN updated_at TEXT",
    "ALTER TABLE tasks ADD COLUMN resume_prompt TEXT",
    "ALTER TABLE tasks ADD COLUMN resume_depends_on TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE issue_comments ADD COLUMN status TEXT",
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
    // 任务执行者 profile。非空时按 agents.id 精确解析；空/悬空时按 agent_type 默认执行者降级。
    "ALTER TABLE tasks ADD COLUMN executor_id TEXT",
    // 续聊：终态任务的追加对话回合，记下续聊前的终态（队列按它看待该成员）
    "ALTER TABLE tasks ADD COLUMN follow_up_from TEXT",
    // 完成确认落库（严格 done 协议），确认与结算跨进程也不丢
    "ALTER TABLE tasks ADD COLUMN complete_confirmed_at TEXT",
  ]) {
    try {
      await client.execute(sql);
    } catch {
      /* column already exists */
    }
  }
  await dropRetiredColumns();
}

// 退役列:功能改掉后没人再读、但老库里还留着的列。放这里一次性清掉,而不是让
// 它们静静躺着 —— 否则 `db:push` 每次都会拿它们吓唬人(「about to delete
// use_worktree column with 13 items / THIS ACTION WILL CAUSE DATA LOSS」),
// 真正该看的 schema 变更反而淹没在里面,久了就养成无脑 abort 的习惯。
// 新建库压根不会有这些列(上面的 CREATE TABLE 里没有),所以只对老库生效。
// 加一条的前提:全仓 grep 确认没有任何读写,且列里的值已无恢复价值。
const RETIRED_COLUMNS: { table: string; column: string; why: string }[] = [
  // worktree 从「按分组配」改成「按任务 opt-in」(tasks.use_worktree)后废弃
  { table: "groups", column: "use_worktree", why: "worktree 改为按任务 opt-in" },
  // 「编排组/协调者」被 /team 团队模式取代(groups.owner_task_id + tasks.parent_id)
  { table: "groups", column: "coordinator_task_id", why: "编排组已被 /team 取代" },
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

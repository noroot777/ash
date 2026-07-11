import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import * as schema from "./schema.js";
import { DATA_DIR } from "../paths.js";

const dbFile = process.env.HARNESS_DB ?? join(DATA_DIR, "harness.db");
mkdirSync(dirname(dbFile), { recursive: true });

// libsql: N-API prebuilt binary (no node-gyp), ABI-stable across Node versions.
const client = createClient({ url: `file:${resolve(dbFile)}` });

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
      agent_type TEXT, auto_title INTEGER NOT NULL DEFAULT 0, debate TEXT, schedule_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, ended_at TEXT,
      archived INTEGER NOT NULL DEFAULT 0, archived_at TEXT
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '{"kind":"local"}', model TEXT,
      extra_args TEXT NOT NULL DEFAULT '[]', speed TEXT, is_default INTEGER NOT NULL DEFAULT 0
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
  ]) {
    try {
      await client.execute(sql);
    } catch {
      /* column already exists */
    }
  }
}

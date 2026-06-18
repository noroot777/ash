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
      mode TEXT NOT NULL DEFAULT 'parallel', use_worktree INTEGER NOT NULL DEFAULT 1,
      paused INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, group_id TEXT, parent_id TEXT,
      title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL DEFAULT 'single',
      status TEXT NOT NULL DEFAULT 'backlog', priority TEXT NOT NULL DEFAULT 'none',
      labels TEXT NOT NULL DEFAULT '[]', depends_on TEXT NOT NULL DEFAULT '[]',
      agent_type TEXT, auto_title INTEGER NOT NULL DEFAULT 0, debate TEXT, schedule_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, ended_at TEXT
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '{"kind":"local"}', model TEXT,
      extra_args TEXT NOT NULL DEFAULT '[]', is_default INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL,
      agent_type TEXT NOT NULL, executor TEXT NOT NULL, target TEXT NOT NULL,
      worktree_path TEXT, branch TEXT, cwd TEXT, cli_session_id TEXT, resume_command TEXT,
      command_line TEXT, started_at TEXT NOT NULL, ended_at TEXT, exit_status INTEGER
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL,
      at TEXT, cron TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT, created_at TEXT NOT NULL
    );
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
  ]) {
    try {
      await client.execute(sql);
    } catch {
      /* column already exists */
    }
  }
}

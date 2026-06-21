import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// JSON columns are stored as text and parsed in the repository layer.
// Schema mirrors shared/src/index.ts.

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  repoPath: text("repo_path").notNull(),
  createdAt: text("created_at").notNull(),
});

export const groups = sqliteTable("groups", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  name: text("name").notNull(),
  mode: text("mode").notNull().default("parallel"), // parallel | serial
  useWorktree: integer("use_worktree", { mode: "boolean" }).notNull().default(true),
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
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
});

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  target: text("target").notNull().default('{"kind":"local"}'), // json ExecTarget
  model: text("model"),
  extraArgs: text("extra_args").notNull().default("[]"), // json
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
  commandLine: text("command_line"),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"), // when this run finished (set with exit_status)
  exitStatus: integer("exit_status"),
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

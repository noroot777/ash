// 「验收前置命令」的一次次执行记录。
//
// 为什么是**一张表**而不是 tasks 上几列：这是一条会跑十几分钟、能失败、能被取消、能
// 跨 ash 重启的外部动作，用户事后要回答的是「上一次跑的是哪棵树、几点跑的、红在哪」
// ——那是一行一行的历史，不是一个当前值。另外 pid 必须落盘：ash 重启后要凭它把上一条
// 命令的残留进程收掉（见 accept-gate-process.ts）。
//
// 语义本体（为什么钉在验收那一刻、判据是什么）在 shared/src/accept-gate.ts 顶部。
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Client } from "./node-sqlite-client.js";

export const acceptGateRuns = sqliteTable(
  "accept_gate_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    projectId: text("project_id").notNull(),
    /** 这一次用的命令原文：项目设置事后改了，历史记录里仍是当初真的跑过的那条。 */
    command: text("command").notNull(),
    cwd: text("cwd").notNull(),
    /** running | passed | failed | interrupted | canceled */
    status: text("status").notNull(),
    exitCode: integer("exit_code"),
    /** exit_code | timeout | spawn_failed | server_restarted | canceled */
    failure: text("failure"),
    pid: integer("pid"),
    /**
     * 那个 pid 的**启动时间**：重启之后拿它核对「这个号还是不是当初那条命令」。
     *
     * 只凭 pid 发信号是会打错人的 —— ash 停了几小时再起来，那个号早被别的进程复用了
     * （同 preview-process-stop.ts 的身份核对）。读不出来就记 null，那时宁可不发信号。
     */
    pidStartedAt: text("pid_started_at"),
    processPending: integer("process_pending", { mode: "boolean" }).notNull().default(false),
    logPath: text("log_path").notNull(),
    /** 被测的那棵树（任务工作区当时的 HEAD）。它一变，这次结果就不再算数。 */
    sourceCommit: text("source_commit"),
    targetBranch: text("target_branch"),
    targetCommit: text("target_commit"),
    /** 当时合并会不会是纯 fast-forward（null = 这个任务没有合并目标）。 */
    fastForward: integer("fast_forward", { mode: "boolean" }),
    /**
     * 用户点那一下带着的验收选择（JSON：by / commit / confirmUnverified）。
     *
     * 必须留：门禁绿了之后是**系统**替他把验收接着做完的，接着做的那一次必须跟他在
     * 确认框里选的一模一样 —— 丢了 commit 选择，就会在他说「先别提交」的目标分支上
     * 落下一个提交。
     */
    acceptOptions: text("accept_options"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    /**
     * 这一次的红**交没交回给 agent**:发起时刻 + 没发出去的原因(null = 发出去了)。
     *
     * 必须落盘:交接是自动发生的,而用户看到那张卡可能已经是几小时后、刷新过好几次。
     * 不落盘就只剩时间线深处一句话,卡上答不出「它到底去修了没有」,于是用户要么干等,
     * 要么重复点(见根 AGENTS.md「停止/暂停必须留下持久可见的状态」)。
     */
    handoffAt: text("handoff_at"),
    handoffError: text("handoff_error"),
  },
  (t) => ({ taskIdx: index("accept_gate_runs_task_idx").on(t.taskId, t.startedAt) }),
);

export async function ensureAcceptGateSchema(client: Client): Promise<void> {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS accept_gate_runs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT NOT NULL,
      command TEXT NOT NULL, cwd TEXT NOT NULL, status TEXT NOT NULL,
      exit_code INTEGER, failure TEXT, pid INTEGER, log_path TEXT NOT NULL,
      source_commit TEXT, target_branch TEXT, target_commit TEXT, fast_forward INTEGER,
      accept_options TEXT, started_at TEXT NOT NULL, finished_at TEXT,
      handoff_at TEXT, handoff_error TEXT, pid_started_at TEXT
    );
    CREATE INDEX IF NOT EXISTS accept_gate_runs_task_idx ON accept_gate_runs (task_id, started_at);
  `);
  // 这张表第一版没有后面这几列,补列即可(空 = 那一次没交接过 / 读不出进程身份)。
  for (const sql of [
    "ALTER TABLE accept_gate_runs ADD COLUMN handoff_at TEXT",
    "ALTER TABLE accept_gate_runs ADD COLUMN handoff_error TEXT",
    "ALTER TABLE accept_gate_runs ADD COLUMN pid_started_at TEXT",
    "ALTER TABLE accept_gate_runs ADD COLUMN process_pending INTEGER NOT NULL DEFAULT 0",
  ]) {
    try { await client.execute(sql); } catch { /* column already exists */ }
  }
}

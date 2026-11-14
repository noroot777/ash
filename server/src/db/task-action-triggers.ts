// 「任务此刻能做什么」依赖的事实一落库就记一笔脏（推送本体在 task-actions-feed.ts）。
//
// 做在库这一层，不做在各个写入点：归档、取回、团队连带、队列推进请求、MCP、调度器……写这些列的
// 地方几十处，挨个补「写完记得通知」迟早漏一处，而漏一处的后果就是另一张开着的页面停在一颗点了必被
// 拒的键上。触发器只认「哪一列变了」，谁写的都一样。
//
// 都是 TEMP 触发器 + 本连接上登记的 JS 函数：只活在 ash 自己这条连接里，不落进库文件（别的进程打开
// 这个库不会撞上「没有这个函数」），每次开机重建。函数和触发器必须一起装：只有触发器没有函数，
// 那几张表的每一次写都会报错。
//
// 判据读哪些事实，这里就盯哪些（task-action-verdicts.ts、task-retry-turn.ts 的 readRetryTurnFacts、
// task-actions.ts 的 readActionFacts）。往判据里加了一样新事实，这里要跟着加一条。
import type { Client, SqlValue } from "./node-sqlite-client.js";
import { markTaskActionsDirty } from "../task-actions-dirty.js";

/** 任务行上判据会读的列。 */
const TASK_COLUMNS = [
  "status", "archived", "stage", "mode", "workflow_mode", "group_id", "parent_id", "review_of", "handoff",
  "question", "resume_prompt", "resume_prompt_generation", "verify_round", "queue_advance_request",
  "agent_type", "executor_id",
];
/** 会话行上判据会读的列（重跑上一回合认的是最近那条会话怎么收的尾、用的哪个执行器）。 */
const SESSION_COLUMNS = [
  "role", "started_at", "turn_started_at", "ended_at", "exit_status", "stopped_as", "side_turn",
  "executor_id", "executor_fingerprint",
];

const changed = (columns: string[]) => columns.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(" OR ");

// 一个任务变了，它的上级（团队的「停止全组」看执行者）和它审的那个任务（「已有一轮审查没结束」）
// 也跟着脏。同队成员、同组成员在推送那一侧按库展开（task-actions-feed.ts 的 affected）。
const task = (row: "NEW" | "OLD") =>
  `SELECT ash_actions_dirty('task', ${row}.id), ash_actions_dirty('task', ${row}.parent_id), ash_actions_dirty('task', ${row}.review_of);`;
// 审查链两张表都挂在任务上；轮次表只有 run_id，按链找回任务。
const roundTask = (row: "NEW" | "OLD") =>
  `SELECT ash_actions_dirty('task', (SELECT task_id FROM free_review_runs WHERE id = ${row}.run_id));`;

const TRIGGERS = `
  CREATE TEMP TRIGGER IF NOT EXISTS ash_actions_tasks_ins AFTER INSERT ON tasks BEGIN ${task("NEW")} END;
  CREATE TEMP TRIGGER IF NOT EXISTS ash_actions_tasks_upd AFTER UPDATE ON tasks
    WHEN ${changed(TASK_COLUMNS)} BEGIN ${task("NEW")} ${task("OLD")} END;
  CREATE TEMP TRIGGER IF NOT EXISTS ash_actions_tasks_del AFTER DELETE ON tasks BEGIN ${task("OLD")} END;

  CREATE TEMP TRIGGER IF NOT EXISTS ash_actions_queue_ins AFTER INSERT ON queue_items
    BEGIN SELECT ash_actions_dirty('task', NEW.task_id); END;
  CREATE TEMP TRIGGER IF NOT EXISTS ash_actions_queue_upd AFTER UPDATE ON queue_items
    BEGIN SELECT ash_actions_dirty('task', NEW.task_id), ash_actions_dirty('task', OLD.task_id); END;
  CREATE TEMP TRIGGER IF NOT EXISTS ash_actions_queue_del AFTER DELETE ON queue_items
    BEGIN SELECT ash_actions_dirty('task', OLD.task_id); END;

  CREATE TEMP TRIGGER IF NOT EXISTS ash_actions_groups_upd AFTER UPDATE OF paused ON groups
    WHEN OLD.paused IS NOT NEW.paused BEGIN SELECT ash_actions_dirty('group', NEW.id); END;

  CREATE TEMP TRIGGER IF NOT EXISTS ash_actions_sessions_ins AFTER INSERT ON sessions
    BEGIN SELECT ash_actions_dirty('task', NEW.task_id); END;
  CREATE TEMP TRIGGER IF NOT EXISTS ash_actions_sessions_upd AFTER UPDATE ON sessions
    WHEN ${changed(SESSION_COLUMNS)} BEGIN SELECT ash_actions_dirty('task', NEW.task_id); END;
  CREATE TEMP TRIGGER IF NOT EXISTS ash_actions_sessions_del AFTER DELETE ON sessions
    BEGIN SELECT ash_actions_dirty('task', OLD.task_id); END;

  CREATE TEMP TRIGGER IF NOT EXISTS ash_actions_turns_ins AFTER INSERT ON session_turns
    BEGIN SELECT ash_actions_dirty('task', NEW.task_id); END;
  CREATE TEMP TRIGGER IF NOT EXISTS ash_actions_turns_upd AFTER UPDATE OF outcome ON session_turns
    WHEN OLD.outcome IS NOT NEW.outcome BEGIN SELECT ash_actions_dirty('task', NEW.task_id); END;

  CREATE TEMP TRIGGER IF NOT EXISTS ash_actions_review_runs_ins AFTER INSERT ON free_review_runs
    BEGIN SELECT ash_actions_dirty('task', NEW.task_id); END;
  CREATE TEMP TRIGGER IF NOT EXISTS ash_actions_review_runs_upd AFTER UPDATE ON free_review_runs
    BEGIN SELECT ash_actions_dirty('task', NEW.task_id); END;
  CREATE TEMP TRIGGER IF NOT EXISTS ash_actions_review_runs_del AFTER DELETE ON free_review_runs
    BEGIN SELECT ash_actions_dirty('task', OLD.task_id); END;
  CREATE TEMP TRIGGER IF NOT EXISTS ash_actions_review_rounds_ins AFTER INSERT ON free_review_rounds
    BEGIN ${roundTask("NEW")} END;
  CREATE TEMP TRIGGER IF NOT EXISTS ash_actions_review_rounds_upd AFTER UPDATE ON free_review_rounds
    BEGIN ${roundTask("NEW")} END;

  CREATE TEMP TRIGGER IF NOT EXISTS ash_actions_agents_upd AFTER UPDATE ON agents
    BEGIN SELECT ash_actions_dirty('all', NULL); END;
  CREATE TEMP TRIGGER IF NOT EXISTS ash_actions_agents_del AFTER DELETE ON agents
    BEGIN SELECT ash_actions_dirty('all', NULL); END;
`;

/** 装触发器。ensureSchema 的最后一步：表和列都已经齐了。 */
export async function installTaskActionTriggers(client: Client): Promise<void> {
  client.defineFunction("ash_actions_dirty", (kind: SqlValue, id: SqlValue) => {
    if (kind === "all") markTaskActionsDirty({ kind: "all" });
    else if (typeof id === "string" && id) markTaskActionsDirty(kind === "group" ? { kind: "group", groupId: id } : { kind: "task", taskId: id });
    return null;
  });
  await client.executeMultiple(TRIGGERS);
}

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

/** 任务行上判据会读的列（含同队成员挡路时那句话点的名字）。 */
const TASK_COLUMNS = [
  "status", "archived", "stage", "mode", "workflow_mode", "group_id", "parent_id", "review_of", "handoff",
  "question", "resume_prompt", "resume_prompt_generation", "verify_round", "queue_advance_request",
  "agent_type", "executor_id", "follow_up_from", "title",
];
/** 会话行上判据会读的列（重跑上一回合认的是最近那条会话怎么收的尾、用的哪个执行器）。 */
const SESSION_COLUMNS = [
  "role", "started_at", "turn_started_at", "ended_at", "exit_status", "stopped_as", "side_turn",
  "executor_id", "executor_fingerprint",
];

const changed = (columns: string[]) => columns.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(" OR ");

// ── 依赖边 ──────────────────────────────────────────────────────────────────────
// 一个任务的结论不只看它自己那一行，还看：同队成员（队列挡路）、名下执行者（团队的停止全组）、
// 审它的历史审查任务（「已有一轮审查没结束」）、所在分组（暂停着不能重跑上一回合）。
//
// **每条边都在行变化的那一刻、用 OLD 和 NEW 两侧的键当场记下**：删行、改队、换上级、挪出分组时，
// 变化之后的库里已经查不到这条边了 —— 事后再按「此刻的关系」去找谁受牵连，找到的永远少一个（第 2 轮
// 审查 F2：删掉挡路的前置任务，后面那个失败任务的「重试」一直灰着）。推送那一侧只做一件事：把记下
// 的队列 / 分组展开成**此刻**的成员（task-actions-feed.ts）；已经离开的成员自己那一行也在变，自己会
// 被记上。
const dirty = (kind: "task" | "queue" | "group", key: string) => `ash_actions_dirty('${kind}', ${key})`;
const queueOf = (taskId: string) => `(SELECT queue_id FROM queue_items WHERE task_id = ${taskId})`;
/** 一个任务变了：它自己、它的上级、它审的那个任务、它所在的那条队列。 */
const taskEdges = (row: "NEW" | "OLD") =>
  `${dirty("task", `${row}.id`)}, ${dirty("task", `${row}.parent_id`)}, ${dirty("task", `${row}.review_of`)}, ${dirty("queue", queueOf(`${row}.id`))}`;
/** 一条队列成员行变了：这个任务，和这条队列上的所有人。 */
const queueEdges = (row: "NEW" | "OLD") => `${dirty("task", `${row}.task_id`)}, ${dirty("queue", `${row}.queue_id`)}`;
/** 一个分组变了：它的成员、它所属的团队。 */
const groupEdges = (row: "NEW" | "OLD") => `${dirty("group", `${row}.id`)}, ${dirty("task", `${row}.owner_task_id`)}`;
/** 挂在任务上的行（会话、回合、审查链……）。 */
const onTask = (row: "NEW" | "OLD") => dirty("task", `${row}.task_id`);
/** 审查轮次只有 run_id，按链找回任务。 */
const roundTask = (row: "NEW" | "OLD") => dirty("task", `(SELECT task_id FROM free_review_runs WHERE id = ${row}.run_id)`);

/** 一张表的增 / 改 / 删各一条触发器；`when` 限定「改」只在判据会读的列变了时才算。 */
function watch(table: string, edges: (row: "NEW" | "OLD") => string, when?: string): string {
  const name = `ash_actions_${table}`;
  return `
  CREATE TEMP TRIGGER IF NOT EXISTS ${name}_ins AFTER INSERT ON ${table} BEGIN SELECT ${edges("NEW")}; END;
  CREATE TEMP TRIGGER IF NOT EXISTS ${name}_upd AFTER UPDATE ON ${table}${when ? ` WHEN ${when}` : ""}
    BEGIN SELECT ${edges("NEW")}, ${edges("OLD")}; END;
  CREATE TEMP TRIGGER IF NOT EXISTS ${name}_del AFTER DELETE ON ${table} BEGIN SELECT ${edges("OLD")}; END;`;
}

const TRIGGERS = [
  watch("tasks", taskEdges, changed(TASK_COLUMNS)),
  watch("queue_items", queueEdges),
  watch("groups", groupEdges, changed(["paused", "owner_task_id"])),
  watch("sessions", onTask, changed(SESSION_COLUMNS)),
  watch("session_turns", onTask, changed(["outcome", "started_at"])),
  watch("free_review_runs", onTask),
  watch("free_review_rounds", roundTask),
  watch("free_review_debates", onTask),
  watch("free_workflow_states", onTask),
  // 执行器 profile 改了 / 删了：重跑上一回合的保真前提（会话记下的指纹）全变，说不清是哪些任务。
  `
  CREATE TEMP TRIGGER IF NOT EXISTS ash_actions_agents_upd AFTER UPDATE ON agents BEGIN SELECT ash_actions_dirty('all', NULL); END;
  CREATE TEMP TRIGGER IF NOT EXISTS ash_actions_agents_del AFTER DELETE ON agents BEGIN SELECT ash_actions_dirty('all', NULL); END;`,
].join("\n");

/** 装触发器。ensureSchema 的最后一步：表和列都已经齐了。 */
export async function installTaskActionTriggers(client: Client): Promise<void> {
  client.defineFunction("ash_actions_dirty", (kind: SqlValue, id: SqlValue) => {
    if (kind === "all") markTaskActionsDirty({ kind: "all" });
    else if (typeof id !== "string" || !id) return null;
    else if (kind === "queue") markTaskActionsDirty({ kind: "queue", queueId: id });
    else if (kind === "group") markTaskActionsDirty({ kind: "group", groupId: id });
    else markTaskActionsDirty({ kind: "task", taskId: id });
    return null;
  });
  await client.executeMultiple(TRIGGERS);
}

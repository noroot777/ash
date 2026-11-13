// 把另一份 ash 的数据导进来之前，先把那份库的**副本**洗成「一份独立实例的数据」。
//
// SQLite 在线备份给的是一致快照，不是独立实例的快照：库里记着源实例手上的进程（pid + 启动时刻、
// 进程记号、输出文件），还记着它下一次开机要接着做的事（接管 agent、接回哨兵、补发通知、推进队列、
// 到点派活）。新实例开机时把这些当成自己的重启现场，就会接管、甚至停掉源实例正在跑的进程，
// 或者在同一个仓库里再起一份 agent（第 1 轮审查 F1 实测：在副本里点停止，源实例的 agent 被 SIGTERM）。
//
// 所以**导入不是重启**：副本里不留任何能认出源进程的线索，在飞的活一律按「被打断」落定，
// 自动续跑的意图一律停用（定义留着，用户自己决定要不要重新开）。这一份只在发布之前对暂存副本跑一次，
// 跑在任何迁移之前，所以每一条都先看列在不在（源库可能是旧版本的表结构）。
//
// 同一趟顺手把落在源数据根下的绝对路径改到新数据根（F6）：数据根是整份搬过来的，库里任何一处
// 指向源数据根的路径，在副本里指的都是副本自己那一份文件；源数据根以外的路径（项目、worktree、
// CLI 的配置目录）一个字不动。
import { DatabaseSync } from "node:sqlite";
import { DIRECTION_REVOKED_SQL } from "./task-direction-epoch.js";

export type ImportPreparation = {
  /** 每一类被停下来的东西各多少条，给导入完成的提示用。 */
  held: Record<string, number>;
  /** 改到新数据根的字段值个数。 */
  relocated: number;
};

const HELD_NOTE = "导入时它还属于原来那份 ash，这份副本没有接管它";

export function prepareImportedSnapshot(file: string, sourceRoots: string[], targetRoot: string): ImportPreparation {
  const db = new DatabaseSync(file);
  try {
    db.exec("BEGIN IMMEDIATE");
    const held = holdRuntime(db);
    const relocated = relocatePaths(db, sourceRoots, targetRoot);
    db.exec("COMMIT");
    return { held, relocated };
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

type Columns = (table: string) => Set<string>;

function columnsOf(db: DatabaseSync): Columns {
  const cache = new Map<string, Set<string>>();
  return (table) => {
    let cols = cache.get(table);
    if (!cols) {
      cols = new Set((db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name));
      cache.set(table, cols);
    }
    return cols;
  };
}

function holdRuntime(db: DatabaseSync): Record<string, number> {
  const cols = columnsOf(db);
  const held: Record<string, number> = {};
  const at = new Date().toISOString();
  /** 表里缺了哪一列就整条跳过（旧版本的库），`label` 非空时把改到的行数记进提示。 */
  const run = (label: string | null, table: string, needs: string[], sql: string, ...params: (string | number | null)[]) => {
    const have = cols(table);
    if (!needs.every((c) => have.has(c))) return;
    const changes = Number(db.prepare(sql).run(...params).changes);
    if (label && changes) held[label] = (held[label] ?? 0) + changes;
  };
  const nullAll = (table: string, columns: string[]) => {
    const present = columns.filter((c) => cols(table).has(c));
    if (present.length) db.prepare(`UPDATE "${table}" SET ${present.map((c) => `"${c}"=NULL`).join(", ")}`).run();
  };

  // ── 认得出源进程的线索：pid、ps 启动时刻、进程记号。没有它们，接管、清扫、停止都找不到人。
  nullAll("sessions", ["agent_pid", "agent_started_at", "agent_unit_token", "agent_offset"]);
  nullAll("monitors", ["pid", "pid_started_at", "unit_token", "source_pid", "source_pid_started_at", "finishing_since"]);
  nullAll("accept_gate_runs", ["pid", "pid_started_at"]);
  // 「上一辈子没收干净的进程」这两本账记的是源实例的进程，副本替它去收就是去杀别人的进程。
  run(null, "agent_cleanup_debts", ["closed_at", "closed_note"],
    `UPDATE agent_cleanup_debts SET closed_at=?, closed_note=? WHERE closed_at IS NULL`, at, HELD_NOTE);
  run(null, "monitor_reclaim_debts", ["closed_at", "closed_note"],
    `UPDATE monitor_reclaim_debts SET closed_at=?, closed_note=? WHERE closed_at IS NULL`, at, HELD_NOTE);
  run(null, "monitor_pending_calls", ["task_id"], `DELETE FROM monitor_pending_calls`);
  run(null, "scheduled_messages", ["delivering_since", "delivering_owner"],
    `UPDATE scheduled_messages SET delivering_since=NULL, delivering_owner=NULL WHERE delivering_since IS NOT NULL OR delivering_owner IS NOT NULL`);

  // ── 在飞的活按「被打断」落定。任务落暂停而不是失败：那一轮多半还在源实例上跑着，没有失败。
  run("tasks", "tasks", ["status", "mode"],
    `UPDATE tasks SET status=CASE WHEN mode='team' THEN 'idle' ELSE 'paused' END WHERE status IN ('running','queued')`);
  run(null, "tasks", ["verify_round"], `UPDATE tasks SET verify_round=NULL WHERE verify_round IS NOT NULL`);
  run("monitors", "monitors", ["status", "ended_at", "ended_reason"],
    `UPDATE monitors SET status='lost', ended_at=COALESCE(ended_at, ?), ended_reason=? WHERE status='running'`, at, HELD_NOTE);
  run("gates", "accept_gate_runs", ["status", "failure", "finished_at"],
    `UPDATE accept_gate_runs SET status='interrupted', failure='server_restarted', finished_at=COALESCE(finished_at, ?) WHERE status='running'`, at);
  // 验收闸的结论只对源实例那一次运行成立：留着 settlement / 放行选项，副本开机会按它去合并真仓库。
  nullAll("accept_gate_runs", ["settlement", "accept_options", "source_fingerprint"]);
  run(null, "accept_gate_runs", ["process_pending"], `UPDATE accept_gate_runs SET process_pending=0 WHERE process_pending<>0`);
  run("reviews", "free_review_runs", ["status", "finished_at", "updated_at"],
    `UPDATE free_review_runs SET status='failed', finished_at=COALESCE(finished_at, updated_at) WHERE status='reviewing'`);
  run(null, "free_review_rounds", ["status", "ended_at", "started_at"],
    `UPDATE free_review_rounds SET status='error', ended_at=COALESCE(ended_at, started_at) WHERE status='reviewing'`);
  run("reviews", "free_review_debates", ["status", "finished_at", "updated_at"],
    `UPDATE free_review_debates SET status='failed', finished_at=COALESCE(finished_at, ?), updated_at=? WHERE status='running'`, at, at);
  run(null, "free_review_debate_turns", ["status", "ended_at"],
    `UPDATE free_review_debate_turns SET status='error', ended_at=COALESCE(ended_at, ?) WHERE status='speaking'`, at);

  // ── 审查链的执行权限（第 2 轮审查 F1）。审查结算、收尾、修复投递、续审都不认 pid，认的是
  // 「任务还停在当初那个方向上」+ 库里那一份计划，开机对账（`reconcileRegressionSettlements`、
  // `reconcileReviewStarts`、`reconcileRegressionFinalizations`，以及之后每 30 秒那一趟）照着计划
  // 接着做：重投修复、推后续站、清合并审查的工作区 —— 而工作区、仓库都不随数据根搬过来，做的就是
  // 源实例的事。所以两头一起封：
  //   · 权限：每个任务的方向世代 +1，导入前记下的方向身份从此一律对不上（审查那一侧见 `reviewIdentityMatches`）；
  //   · 计划：收尾计划标成已了结（被取代），待补的结算不再补，续审 / 派审在途的凭据全部撤掉。
  //     有几步（停哨兵、清工作区）不过身份那一关，光推世代挡不住它们，所以计划本身也要封。
  run(null, "tasks", ["direction_epoch", "active_turn_token", "active_direction_token", "active_direction_version"],
    `UPDATE tasks SET ${DIRECTION_REVOKED_SQL}`);
  run("reviews", "regression_evidence", ["finalization"],
    `UPDATE regression_evidence SET finalization=json_set(json_remove(finalization, '$.runningStep', '$.blockedStep'),
       '$.completed', json('true'), '$.superseded', json('true'))
     WHERE json_valid(finalization) AND json_type(finalization) = 'object'
       AND COALESCE(json_extract(finalization, '$.completed'), 0) = 0`);
  run(null, "regression_evidence", ["settlement"],
    `UPDATE regression_evidence SET settlement=json_set(settlement, '$.pending', json('false'))
     WHERE json_valid(settlement) AND json_extract(settlement, '$.pending') = 1`);
  run(null, "regression_evidence", ["continuation"],
    `UPDATE regression_evidence SET continuation=NULL WHERE continuation IS NOT NULL`);
  // 等待归属里属于审查链的那几格：派审 / 修复投递 / 验收收尾 / 回合归属 / 已送达的审查输入（带源进程 pid）。
  // 提问和检查点留着 —— 那是任务停在那里等人的状态，续不续由用户在这一份里决定。
  run(null, "tasks", ["wait_ownership"],
    `UPDATE tasks SET wait_ownership=json_remove(wait_ownership, '$.start', '$.repairDelivery',
       '$.acceptedFinalization', '$.turn', '$.deliveredReview')
     WHERE json_valid(wait_ownership)`);
  run(null, "tasks", ["wait_ownership"], `UPDATE tasks SET wait_ownership=NULL WHERE wait_ownership='{}'`);
  run(null, "free_review_rounds", ["dispatch"], `UPDATE free_review_rounds SET dispatch=NULL WHERE dispatch IS NOT NULL`);

  // ── 开机或到点会自己动起来的意图：停用，定义留着。
  run("schedules", "schedules", ["enabled"], `UPDATE schedules SET enabled=0 WHERE enabled<>0`);
  run("messages", "scheduled_messages", ["status"], `UPDATE scheduled_messages SET status='canceled' WHERE status='pending'`);
  // 回合里交出去、还没确认送到的那几条，开机会被退回待发送再送一遍。
  run(null, "scheduled_messages", ["turn_taken_by", "status"],
    `UPDATE scheduled_messages SET turn_taken_by=NULL WHERE status='sent' AND turn_taken_by IS NOT NULL`);
  run(null, "monitors", ["result_handoff_at", "result_handoff_text"],
    `UPDATE monitors SET result_handoff_at=NULL, result_handoff_text=NULL WHERE result_handoff_at IS NOT NULL`);
  run(null, "queue_advance_intents", ["queue_id"], `DELETE FROM queue_advance_intents`);
  run(null, "tasks", ["queue_advance_request"], `UPDATE tasks SET queue_advance_request=NULL WHERE queue_advance_request IS NOT NULL`);
  run("reviews", "free_workflow_states", ["review_armed", "review_held_token"],
    `UPDATE free_workflow_states SET review_armed=0, review_held_token=NULL WHERE review_held_token IS NOT NULL`);
  return held;
}

/**
 * 库里所有文本值里，落在源数据根下的绝对路径改到新数据根。认路径的边界：根前面不能紧挨着
 * 路径字符（否则是更长路径的一截；`file://` 例外），后面只能是 `/` 或路径结束（`data` 不会吃掉 `data2`）。
 */
function relocatePaths(db: DatabaseSync, sourceRoots: string[], targetRoot: string): number {
  const roots = [...new Set(sourceRoots.map(trimSlash))].filter((root) => root.startsWith("/") && root !== trimSlash(targetRoot));
  if (!roots.length) return 0;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:(?<=file://)|(?<![\\w./~-]))(?:${roots.sort((a, b) => b.length - a.length).map(escape).join("|")})(?=/|$|[^\\w.~-])`, "g");
  const target = trimSlash(targetRoot);
  let relocated = 0;
  const tables = db.prepare(`SELECT name, wr FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string; wr: number }[];
  for (const { name: table, wr } of tables) {
    const info = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string; pk: number }[];
    const keys = wr ? info.filter((c) => c.pk > 0).map((c) => c.name) : ["rowid"];
    if (!keys.length) continue;
    // 键一律起别名：带 INTEGER PRIMARY KEY 的表，`SELECT rowid` 回来的列名是那个主键列的名字。
    const keyRefs = keys.map((k) => (k === "rowid" ? "rowid" : `"${k}"`));
    const keyList = keyRefs.map((ref, i) => `${ref} AS k${i}`).join(", ");
    for (const { name } of info) {
      const hits = roots.map((root) => `instr("${name}", '${root.replace(/'/g, "''")}') > 0`).join(" OR ");
      const rows = db.prepare(`SELECT ${keyList}, "${name}" AS v FROM "${table}" WHERE typeof("${name}")='text' AND (${hits})`)
        .all() as Record<string, string>[];
      if (!rows.length) continue;
      const update = db.prepare(`UPDATE "${table}" SET "${name}"=? WHERE ${keyRefs.map((ref) => `${ref}=?`).join(" AND ")}`);
      for (const row of rows) {
        // 回调返回字面量：目标路径里的 `$&`、`$$` 之类不能被当成替换模板展开（第 2 轮审查 F4）。
        const next = row.v.replace(pattern, () => target);
        if (next === row.v) continue;
        update.run(next, ...keys.map((_, i) => row[`k${i}`]));
        relocated++;
      }
    }
  }
  return relocated;
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

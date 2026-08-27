import { DatabaseSync } from "node:sqlite";

const TASK_FIELDS = [
  "group_id", "parent_id", "review_of", "review_round", "verify_round", "review_requested",
  "depends_on", "resume_depends_on", "duet", "team", "archived", "archived_at", "origin_task_id",
  "follow_up_from", "complete_confirmed_at", "native_turn", "accepted_target_branch",
  "accepted_base_commit", "accepted_merge_commit", "accepted_tail_pending", "accepted_tail_done",
  "executor_id", "report_back", "handoff_audit",
].join(", ");

export interface ReturnLocalState {
  task: Record<string, unknown>;
  freeWorkflowStates: number;
  freeWorkflowEvents: number;
  freeReviewRuns: number;
  freeReviewRounds: number;
  ownedGroups: number;
}

function count(db: DatabaseSync, sql: string, value: string): number {
  return Number((db.prepare(sql).get(value) as { count: number }).count);
}

export function readReturnLocalState(dbPath: string, taskId: string): ReturnLocalState {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=5000");
  try {
    return {
      task: db.prepare(`SELECT ${TASK_FIELDS} FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown>,
      freeWorkflowStates: count(db, "SELECT COUNT(*) AS count FROM free_workflow_states WHERE task_id = ?", taskId),
      freeWorkflowEvents: count(db, "SELECT COUNT(*) AS count FROM free_workflow_events WHERE task_id = ?", taskId),
      freeReviewRuns: count(db, "SELECT COUNT(*) AS count FROM free_review_runs WHERE task_id = ?", taskId),
      freeReviewRounds: count(db, "SELECT COUNT(*) AS count FROM free_review_rounds WHERE run_id = ?", `return-run-${taskId}`),
      ownedGroups: count(db, "SELECT COUNT(*) AS count FROM groups WHERE owner_task_id = ?", taskId),
    };
  } finally {
    db.close();
  }
}

/** 把接入标记里的回程地址抹掉,还原成「旧接力记录只有指纹、没有来源机端口」的样子。 */
export function stripHandoffPeerUrl(dbPath: string, taskId: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=5000");
  try {
    const row = db.prepare("SELECT handoff FROM tasks WHERE id = ?").get(taskId) as { handoff: string | null };
    if (!row?.handoff) throw new Error(`任务 ${taskId} 没有接力标记`);
    const marker = JSON.parse(row.handoff) as { peerUrl?: string | null };
    marker.peerUrl = null;
    db.prepare("UPDATE tasks SET handoff = ? WHERE id = ?").run(JSON.stringify(marker), taskId);
  } finally {
    db.close();
  }
}

export function seedReturnLocalState(dbPath: string, taskId: string, projectId: string): ReturnLocalState {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
  const at = "2026-08-25T00:00:00.000Z";
  try {
    db.prepare("INSERT INTO groups (id, project_id, name, mode, paused, created_at) VALUES (?, ?, ?, 'parallel', 0, ?)")
      .run(`return-group-${taskId}`, projectId, "原机分组", at);
    db.prepare("INSERT INTO groups (id, project_id, name, mode, paused, owner_task_id, created_at) VALUES (?, ?, ?, 'parallel', 0, ?, ?)")
      .run(`return-owned-${taskId}`, projectId, "原机内部组", taskId, at);
    db.prepare(`UPDATE tasks SET group_id=?, parent_id='local-parent', review_of='local-review', review_round=7,
      review_requested=1, depends_on='["local-dep"]', resume_depends_on='["local-resume"]', duet='{}', team='{}',
      archived=0, archived_at=?, origin_task_id='local-origin', follow_up_from='done', complete_confirmed_at=?,
      native_turn=1, accepted_target_branch='local-target', accepted_base_commit='local-base',
      accepted_merge_commit='local-merge', accepted_tail_pending=1, accepted_tail_done='["local-tail"]',
      executor_id='local-executor', report_back=1, handoff_audit=? WHERE id=?`)
      .run(`return-group-${taskId}`, at, at, JSON.stringify({
        kind: "forced-recovery", at, returning: false, peerName: "原机记录", forceReason: "unreachable",
      }), taskId);
    db.prepare("INSERT INTO free_workflow_states (task_id, review_armed, updated_at) VALUES (?, 0, ?)").run(taskId, at);
    db.prepare("INSERT INTO free_workflow_events (id, task_id, kind, source, detail, occurred_at) VALUES (?, ?, 'review_started', 'user', 'local', ?)")
      .run(`return-event-${taskId}`, taskId, at);
    db.prepare(`INSERT INTO free_review_runs
      (id, task_id, reviewer_name, agent_type, check_mode, retry_limit, current_round, status, created_at, updated_at, finished_at)
      VALUES (?, ?, '本机审查者', 'codex', 'full', 1, 1, 'passed', ?, ?, ?)`)
      .run(`return-run-${taskId}`, taskId, at, at, at);
    db.prepare("INSERT INTO free_review_rounds (id, run_id, round, status, conclusion, started_at, ended_at) VALUES (?, ?, 1, 'passed', 'local', ?, ?)")
      .run(`return-round-${taskId}`, `return-run-${taskId}`, at, at);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
  return readReturnLocalState(dbPath, taskId);
}

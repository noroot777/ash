import type { AnnotationReview, AnnotationReviewStatus, AnnotationVerdict } from "@ash/shared/page-annotation-review";
import { dbClient } from "./db/index.js";
import { isRunning, isTurnClaimed } from "./runs.js";
import { rerunGateClosed } from "./rerun-gate.js";
import { now } from "./util.js";

export async function annotationReviewStatus(taskId: string): Promise<AnnotationReviewStatus> {
  const result = await dbClient.execute({ sql: `SELECT mode, status, archived, workflow_mode,
    (SELECT COUNT(*) FROM scheduled_messages WHERE task_id = tasks.id AND status = 'pending') AS pending
    FROM tasks WHERE id = ?`, args: [taskId] });
  const task = result.rows[0];
  const busy = rerunGateClosed(taskId) || isTurnClaimed(taskId) || (task?.mode !== "team" && isRunning(taskId));
  const reason = !task ? "任务不存在" : task.archived ? "任务已归档" : busy || task.status === "running" || task.status === "queued"
    ? "智能体回合尚未释放" : Number(task.pending) > 0 ? "还有待投递的后续消息，投递完成后再复看" : "";
  return { canReopen: !reason, reason, taskStatus: String(task?.status ?? ""), previewKind: task?.workflow_mode === "free" ? "free" : "workflow" };
}

export async function readAnnotationReview(batchId: string, releasedStatus?: string): Promise<AnnotationReview> {
  if (releasedStatus) await dbClient.execute({ sql: `INSERT INTO page_annotation_rounds (batch_id, released_at, round_status)
    VALUES (?, ?, ?) ON CONFLICT(batch_id) DO NOTHING`, args: [batchId, now(), releasedStatus] });
  const round = (await dbClient.execute({ sql: "SELECT * FROM page_annotation_rounds WHERE batch_id = ?", args: [batchId] })).rows[0];
  const decisions = (await dbClient.execute({ sql: "SELECT * FROM page_annotation_decisions WHERE batch_id = ?", args: [batchId] })).rows;
  return { releasedAt: round ? String(round.released_at) : null, roundStatus: round ? String(round.round_status) : null,
    decisions: decisions.map((row) => ({ itemId: String(row.item_id), verdict: row.verdict as AnnotationVerdict,
      savedAt: String(row.saved_at), gen: String(row.gen) })) };
}

export async function saveAnnotationDecision(batchId: string, itemId: string, verdict: AnnotationVerdict, gen: string): Promise<void> {
  await dbClient.execute({ sql: `INSERT INTO page_annotation_decisions (batch_id, item_id, verdict, saved_at, gen)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(batch_id, item_id) DO UPDATE SET
    verdict = excluded.verdict, saved_at = excluded.saved_at, gen = excluded.gen
    WHERE verdict != excluded.verdict OR gen != excluded.gen`, args: [batchId, itemId, verdict, now(), gen] });
}

import { and, desc, eq } from "drizzle-orm";
import type { AnnotationBatch, AnnotationBatchRecord } from "@ash/shared/page-annotation-batch";
import { annotationBatchPrompt } from "@ash/shared/page-annotation-batch";
import { db, dbClient } from "./db/index.js";
import { pageAnnotationBatches as batches } from "./db/schema-page-annotation.js";
import { scheduledMessages } from "./db/schema.js";
import { pendingMessageRow, publishPendingMessages } from "./pending-messages.js";
import { annotationReviewStatus, readAnnotationReview } from "./page-annotation-review.js";
import { now } from "./util.js";

type Row = typeof batches.$inferSelect;
export class AnnotationConflict extends Error {}

async function view(row: Row): Promise<AnnotationBatchRecord> {
  const record: AnnotationBatchRecord = { batch: JSON.parse(row.payload), revision: row.revision, state: "saved",
    messageId: row.messageId, savedAt: row.savedAt, deliveredAt: row.deliveredAt, error: null };
  if (!row.messageId) return record;
  const message = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, row.messageId)))[0];
  if (!message || message.status === "canceled") {
    record.review = await readAnnotationReview(row.id);
    record.error = "投递未完成或已取消；批注草稿仍保留。可复制为新批次后重新确认发送。";
    return record;
  }
  record.state = message.status === "sent" ? "modifying" : "delivered";
  if (message.status === "sent") {
    const status = await annotationReviewStatus(row.taskId);
    if (status.canReopen) record.state = "reviewable";
    record.review = await readAnnotationReview(row.id, status.canReopen ? status.taskStatus : undefined);
  }
  return record;
}

export async function getAnnotationBatch(taskId: string, batchId: string): Promise<AnnotationBatchRecord | null> {
  const row = (await db.select().from(batches).where(and(eq(batches.taskId, taskId), eq(batches.id, batchId))))[0];
  return row ? view(row) : null;
}

export async function listAnnotationBatches(taskId: string): Promise<AnnotationBatchRecord[]> {
  const rows = await db.select().from(batches).where(eq(batches.taskId, taskId)).orderBy(desc(batches.savedAt)).limit(100);
  return Promise.all(rows.map(view));
}

export async function saveAnnotationBatch(batch: AnnotationBatch, revision: number, ownerUserId: string | null): Promise<AnnotationBatchRecord> {
  const payload = JSON.stringify(batch);
  const old = (await db.select().from(batches).where(eq(batches.id, batch.id)))[0];
  if (old && (old.taskId !== batch.taskId || old.ownerUserId !== ownerUserId)) throw new AnnotationConflict("批次属于另一任务或用户");
  if (old?.payload === payload && old.revision === revision) return view(old);
  if (old?.messageId) throw new AnnotationConflict("此批次已经确认投递，请创建新批次");
  if (revision !== (old?.revision ?? 0) + 1) throw new AnnotationConflict("草稿版本已变化，请重新打开批次后继续");
  const [changed] = await dbClient.atomicBatch([{ sql: `
      INSERT INTO page_annotation_batches (id, task_id, owner_user_id, payload, revision, saved_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, revision = excluded.revision, saved_at = excluded.saved_at
      WHERE task_id = ? AND owner_user_id IS ? AND revision = ? AND message_id IS NULL RETURNING id`,
    args: [batch.id, batch.taskId, ownerUserId, payload, revision, now(), batch.taskId, ownerUserId, revision - 1] }]);
  if (!changed.rows.length) {
    const current = await getAnnotationBatch(batch.taskId, batch.id);
    if (current?.revision === revision && JSON.stringify(current.batch) === payload) return current;
    throw new AnnotationConflict("草稿版本已变化，请重新打开批次后继续");
  }
  return (await getAnnotationBatch(batch.taskId, batch.id))!;
}

export async function submitAnnotationBatch(taskId: string, batchId: string, revision: number, ownerUserId: string | null): Promise<AnnotationBatchRecord> {
  const row = (await db.select().from(batches).where(and(eq(batches.taskId, taskId), eq(batches.id, batchId))))[0];
  if (!row || row.ownerUserId !== ownerUserId) throw new AnnotationConflict("批次不存在或不可投递");
  if (row.messageId) return view(row);
  if (row.revision !== revision) throw new AnnotationConflict("批次内容已改变，请重新预览并确认");
  const batch = JSON.parse(row.payload) as AnnotationBatch;
  if (!batch.items.length || batch.items.some((item) => !item.comment.trim())) throw new AnnotationConflict("请为每条标注填写修改意见");
  const message = pendingMessageRow({ taskId, text: annotationBatchPrompt(batch), ownerUserId,
    attachments: [...new Set(batch.evidence.flatMap((entry) => entry.path ? [entry.path] : []))] });
  message.id = `annotation-${batchId}`;
  // One synchronous database batch makes queue insertion and its receipt indivisible, including across process death.
  await dbClient.atomicBatch([
    { sql: `INSERT INTO scheduled_messages (id, task_id, text, attachments, owner_user_id, mode, send_at, status, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? FROM page_annotation_batches
        WHERE id = ? AND task_id = ? AND owner_user_id IS ? AND revision = ? AND message_id IS NULL
        ON CONFLICT(id) DO NOTHING`, args: [message.id, taskId, message.text, message.attachments, ownerUserId,
        message.mode, message.sendAt, message.status, message.createdAt, batchId, taskId, ownerUserId, revision] },
    { sql: `UPDATE page_annotation_batches SET message_id = ?, delivered_at = ?
        WHERE id = ? AND message_id IS NULL AND EXISTS (SELECT 1 FROM scheduled_messages WHERE id = ?)`,
      args: [message.id, now(), batchId, message.id] },
  ]);
  const record = (await getAnnotationBatch(taskId, batchId))!;
  if (!record.messageId) throw new AnnotationConflict("批次内容已改变，请重新预览并确认");
  publishPendingMessages(taskId);
  return record;
}

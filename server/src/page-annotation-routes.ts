import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { parseAnnotationBatch } from "@ash/shared/page-annotation-batch";
import { actorOf, ownerIdOf } from "./auth/context.js";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { UPLOADS_DIR } from "./paths.js";
import { bindUploadsToTask, canReadUpload, uploadFileName } from "./uploads.js";
import { AnnotationConflict, getAnnotationBatch, listAnnotationBatches, saveAnnotationBatch, submitAnnotationBatch } from "./page-annotation-store.js";
import { deliverPendingMessages } from "./pending-messages.js";
import { annotationReviewStatus, saveAnnotationDecision } from "./page-annotation-review.js";
import { captureAnnotationReference } from "./page-annotation-reference.js";

export function mountPageAnnotationRoutes(api: Hono): void {
  api.get("/tasks/:id/annotation-review-status", async (c) => {
    c.header("cache-control", "no-store");
    return c.json(await annotationReviewStatus(c.req.param("id")));
  });
  api.put("/tasks/:id/annotation-batches/:batchId/review/:itemId", async (c) => {
    const taskId = c.req.param("id"), batchId = c.req.param("batchId"), itemId = c.req.param("itemId");
    const body = await c.req.json().catch(() => null);
    if (!body || !["satisfied", "continue"].includes(body.verdict) || typeof body.gen !== "string"
      || !/^[\w-]{1,160}$/.test(body.gen)) return c.json({ error: "复看记录无效" }, 400);
    const record = await getAnnotationBatch(taskId, batchId);
    if (!record?.messageId || !record.batch.items.some((item) => item.id === itemId)) return c.json({ error: "批注不存在或尚未发送" }, 404);
    const status = await annotationReviewStatus(taskId);
    if (!status.canReopen) return c.json({ error: status.reason }, 409);
    if (!record.review?.releasedAt) return c.json({ error: "批次尚未进入复看阶段" }, 409);
    await saveAnnotationDecision(batchId, itemId, body.verdict, body.gen);
    return c.json(await getAnnotationBatch(taskId, batchId));
  });
  api.get("/tasks/:id/annotation-batches", async (c) => {
    c.header("cache-control", "no-store");
    return c.json(await listAnnotationBatches(c.req.param("id")));
  });
  api.put("/tasks/:id/annotation-batches/:batchId", async (c) => {
    try {
      if (Number(c.req.header("content-length")) > 2_000_000) return c.json({ error: "批次过大" }, 413);
      const raw = await c.req.text();
      if (raw.length > 2_000_000) return c.json({ error: "批次过大" }, 413);
      const body = JSON.parse(raw);
      const batch = parseAnnotationBatch(body.batch);
      if (batch.id !== c.req.param("batchId") || batch.taskId !== c.req.param("id") || !Number.isSafeInteger(body.revision)) return c.json({ error: "批次身份无效" }, 400);
      if (!(await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, batch.taskId))).length) return c.json({ error: "not found" }, 404);
      const paths = batch.evidence.flatMap((entry) => entry.path ? [entry.path] : []);
      for (const path of paths) {
        if (path !== join(UPLOADS_DIR, uploadFileName(path)) || !(await canReadUpload(actorOf(c), path))) return c.json({ error: "附件不存在或不可访问" }, 404);
      }
      await bindUploadsToTask(paths, batch.taskId, ownerIdOf(actorOf(c)));
      return c.json(await saveAnnotationBatch(batch, body.revision, ownerIdOf(actorOf(c))));
    } catch (reason) {
      return c.json({ error: reason instanceof Error ? reason.message : "保存失败" }, reason instanceof AnnotationConflict ? 409 : 400);
    }
  });
  api.post("/tasks/:id/annotation-reference", async (c) => {
    const input = await c.req.json();
    return c.json(await captureAnnotationReference(c.req.param("id"), input));
  });
}

export async function replyWithAnnotationBatch(c: Context, taskId: string, batchId: string, revision: number): Promise<Response> {
  try {
    if (typeof batchId !== "string" || !/^[\w-]{1,160}$/.test(batchId) || !Number.isSafeInteger(revision)) return c.json({ error: "批次身份无效" }, 400);
    const existing = await getAnnotationBatch(taskId, batchId);
    if (!existing) return c.json({ error: "请先保存批次" }, 409);
    const record = await submitAnnotationBatch(taskId, batchId, revision, ownerIdOf(actorOf(c)));
    // The response records queue acceptance; actual delivery remains owned by the existing queue.
    void deliverPendingMessages(taskId).catch((error) => console.error("[ash] 批注队列投递失败", error));
    return c.json({ annotationBatch: record }, 202);
  } catch (reason) {
    return c.json({ error: reason instanceof Error ? reason.message : "投递失败，草稿仍保留" }, reason instanceof AnnotationConflict ? 409 : 500);
  }
}

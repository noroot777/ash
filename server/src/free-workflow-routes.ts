import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { FreeReviewDispatchInput } from "@ash/shared";
import { and, eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { db } from "./db/index.js";
import { freeReviewRounds, freeReviewRuns, tasks } from "./db/schema.js";
import {
  cancelFreeReviewReservation,
  reserveFreeReview,
  startFreeReview,
  startManualFreeReviewRepair,
} from "./free-workflow.js";
import { freeReviewFile } from "./free-review-files.js";
import { mountFreePreviewRoutes } from "./free-workflow-preview.js";
import { freeWorkflowState } from "./free-workflow-state.js";
import { handoffBlockReasonById } from "./handoff-guard.js";
import { createPostMergeRepairTask, startPostMergeReview } from "./post-merge-review.js";
import { REVIEW_MIME } from "./review-evidence.js";
import { actorOf } from "./auth/context.js";

const errorBody = (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) });

// 派审/修复/预约都会往任务和 worktree 里写东西——接力出去的「历史存档」一律 409,
// 只留只读查看与取消预约(取消是清理,清理不拦)。
// 泛型 Context 读不出路由形状,param 类型是 string | undefined;查无此任务本来就按
// 不拦处理(让入口自己 404),空串走同一条路。
const blockedByHandoff = async (c: Context) => {
  const reason = await handoffBlockReasonById(c.req.param("id") ?? "");
  return reason ? c.json({ error: reason, handoff: true }, 409) : null;
};

export function mountFreeWorkflowRoutes(api: Hono): void {
  mountFreePreviewRoutes(api);
  api.get("/tasks/:id/free-workflow", async (c) => {
    const task = (await db.select({ workflowMode: tasks.workflowMode }).from(tasks).where(eq(tasks.id, c.req.param("id")))).at(0);
    if (!task) return c.json({ error: "not found" }, 404);
    if (task.workflowMode !== "free") return c.json({ error: "当前任务不是自由工作流" }, 409);
    return c.json(await freeWorkflowState(c.req.param("id")));
  });
  api.post("/tasks/:id/free-workflow/review", async (c) => {
    const blocked = await blockedByHandoff(c);
    if (blocked) return blocked;
    try { return c.json(await startFreeReview(c.req.param("id"), await c.req.json<FreeReviewDispatchInput>(), { holdTurn: true, actor: actorOf(c) }), 201); }
    catch (error) { return c.json(errorBody(error), 409); }
  });
  api.post("/tasks/:id/free-workflow/post-merge-review", async (c) => {
    const blocked = await blockedByHandoff(c);
    if (blocked) return blocked;
    try { return c.json(await startPostMergeReview(c.req.param("id"), await c.req.json<FreeReviewDispatchInput>(), actorOf(c)), 201); }
    catch (error) { return c.json(errorBody(error), 409); }
  });
  api.post("/tasks/:id/free-workflow/post-merge-review/repair", async (c) => {
    const blocked = await blockedByHandoff(c);
    if (blocked) return blocked;
    try {
      const body = await c.req.json<{ runId?: string }>();
      return c.json(await createPostMergeRepairTask(c.req.param("id"), body.runId ?? ""), 201);
    } catch (error) { return c.json(errorBody(error), 409); }
  });
  api.post("/tasks/:id/free-workflow/review/repair", async (c) => {
    const blocked = await blockedByHandoff(c);
    if (blocked) return blocked;
    try { return c.json(await startManualFreeReviewRepair(c.req.param("id"), { holdTurn: true })); }
    catch (error) { return c.json(errorBody(error), 409); }
  });
  api.put("/tasks/:id/free-workflow/review-reservation", async (c) => {
    const blocked = await blockedByHandoff(c);
    if (blocked) return blocked;
    try { return c.json(await reserveFreeReview(c.req.param("id"), await c.req.json<FreeReviewDispatchInput>(), actorOf(c))); }
    catch (error) { return c.json(errorBody(error), 409); }
  });
  api.delete("/tasks/:id/free-workflow/review-reservation", async (c) => {
    try { return c.json(await cancelFreeReviewReservation(c.req.param("id"))); }
    catch (error) { return c.json(errorBody(error), 409); }
  });
  api.get("/tasks/:id/free-workflow/review-file", async (c) => {
    const taskId = c.req.param("id");
    const runId = c.req.query("run") ?? "";
    const round = Number(c.req.query("round"));
    const name = c.req.query("name") ?? "";
    const owned = Number.isInteger(round) && round > 0
      ? (await db.select({ id: freeReviewRounds.id }).from(freeReviewRounds)
        .innerJoin(freeReviewRuns, eq(freeReviewRounds.runId, freeReviewRuns.id))
        .where(and(eq(freeReviewRuns.id, runId), eq(freeReviewRuns.taskId, taskId), eq(freeReviewRounds.round, round)))
        .limit(1)).at(0)
      : null;
    const file = owned ? freeReviewFile(taskId, runId, round, name) : null;
    if (!file) return c.json({ error: "not found" }, 404);
    const mime = REVIEW_MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    return c.body(Uint8Array.from(readFileSync(file)), 200, { "content-type": mime });
  });
}

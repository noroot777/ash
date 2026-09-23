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
import { startFreeReviewDebate, submitDebateStatement } from "./free-review-debate.js";
import {
  disputeFreeReview,
  disputeReasonOf,
  disputeResolutionOf,
  resolveFreeReviewDispute,
} from "./free-review-dispute.js";
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

/**
 * agent 自己在回合里调的那两个口子（驳回 / 辩论发言）共用的回合身份核对：与
 * `report_stage`（task-stage.ts）逐条同源——迟到重放的调用、被引导掉的旧回合、
 * 方向身份过期的调用一律不落账。返回错误文案或 null。
 *
 * 与那边的差别只有一处：这两个动作**不要求 status === running**。旁路回合的任务
 * 状态停在它自己的终态，拿 status 当「有没有回合在跑」用会把每一次合法调用都拒掉；
 * 「回合是不是活的」由 activeTurnToken 与各自的 turnRole 判据回答。
 */
async function turnIdentityError(c: Context, taskId: string, what: string): Promise<string | null> {
  const task = (await db.select({
    activeTurnToken: tasks.activeTurnToken,
    activeDirectionToken: tasks.activeDirectionToken,
  }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return "任务不存在";
  const turnToken = c.req.header("x-ash-turn-token");
  if (task.activeTurnToken && turnToken !== task.activeTurnToken) {
    return turnToken
      ? `${what}来自已结束的回合，已拒绝写入当前会话`
      : `MCP 未携带当前回合身份（执行器可能过滤了 ASH_TURN_TOKEN），${what}已拒绝写入`;
  }
  const direction = c.req.header("x-ash-direction-token");
  if (task.activeDirectionToken && direction !== task.activeDirectionToken) {
    return direction
      ? `${what}的方向身份已过期；请从最新用户消息的【当前方向身份】复制 directionToken 后重试`
      : `MCP 未携带当前方向身份（请传当前消息附带的 directionToken），${what}已拒绝写入`;
  }
  return null;
}

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

  // ── 驳回与辩论 ──
  // 两条口子分得很清：`dispute` / `debate/reply` 是 **agent 在自己回合里**调的（MCP），
  // 所以要核对回合身份；`debate` / `dispute/resolution` 是**用户点的**，不核对。
  api.post("/tasks/:id/free-workflow/review/dispute", async (c) => {
    const blocked = await blockedByHandoff(c);
    if (blocked) return blocked;
    const taskId = c.req.param("id");
    const identity = await turnIdentityError(c, taskId, "驳回");
    if (identity) return c.json({ error: identity }, 409);
    try {
      const body = await c.req.json<{ reason?: unknown }>().catch(() => ({} as { reason?: unknown }));
      const result = await disputeFreeReview(taskId, disputeReasonOf(body.reason));
      return c.json({ disputed: true, taskId, ...result });
    } catch (error) { return c.json(errorBody(error), 409); }
  });
  api.post("/tasks/:id/free-workflow/review/dispute/resolution", async (c) => {
    const blocked = await blockedByHandoff(c);
    if (blocked) return blocked;
    try {
      const body = await c.req.json<{ resolution?: unknown }>().catch(() => ({} as { resolution?: unknown }));
      const result = await resolveFreeReviewDispute(c.req.param("id"), disputeResolutionOf(body.resolution));
      return c.json({ ...result, state: await freeWorkflowState(c.req.param("id")) });
    } catch (error) { return c.json(errorBody(error), 409); }
  });
  api.post("/tasks/:id/free-workflow/review/debate", async (c) => {
    const blocked = await blockedByHandoff(c);
    if (blocked) return blocked;
    try {
      const body = await c.req.json<{ exchanges?: unknown }>().catch(() => ({} as { exchanges?: unknown }));
      const started = await startFreeReviewDebate(c.req.param("id"), body, { holdTurn: true });
      return c.json({ ...started, state: await freeWorkflowState(c.req.param("id")) }, 201);
    } catch (error) { return c.json(errorBody(error), 409); }
  });
  api.post("/tasks/:id/free-workflow/review/debate/reply", async (c) => {
    const blocked = await blockedByHandoff(c);
    if (blocked) return blocked;
    const taskId = c.req.param("id");
    const identity = await turnIdentityError(c, taskId, "辩论发言");
    if (identity) return c.json({ error: identity }, 409);
    try {
      const body = await c.req.json<{ statement?: unknown; verdict?: unknown }>().catch(() => ({} as { statement?: unknown; verdict?: unknown }));
      return c.json({ recorded: true, taskId, ...(await submitDebateStatement(taskId, body)) });
    } catch (error) { return c.json(errorBody(error), 409); }
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

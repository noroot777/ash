import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { actorOf } from "./auth/context.js";
import { humanActionOrigin } from "./auth/human-action-token.js";
import { humanApproval, humanApprovalUnavailableReason } from "./auth/human-approval.js";
import { humanRequestRejection } from "./auth/human-request.js";
import { canSeeProject } from "./auth/visibility.js";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { inspectTurnReclaim, releaseSuspectTurn } from "./turn-lock-reclaim.js";
import { noteRejectedUserAction, noteUserActionOutcome } from "./user-action-rejection.js";

export function mountTurnReclaimRoutes(api: Hono): void {
  api.post("/tasks/:id/reclaim-turn/approval", async (context) => {
    const taskId = context.req.param("id");
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task || !(await canSeeProject(actorOf(context), task.projectId))) return context.json({ error: "not found" }, 404);
    const reject = async (error: string, status: 403 | 409 | 503) => {
      await noteRejectedUserAction(taskId, "申请人工授权", error);
      return context.json({ error }, status);
    };
    context.header("Cache-Control", "no-store");
    const rejection = humanRequestRejection(context);
    if (rejection) return reject(rejection, 403);
    if (!humanApproval.fingerprint) return reject(humanApprovalUnavailableReason(), 503);
    const inspection = inspectTurnReclaim(taskId);
    if (!inspection.ok) return reject(inspection.reason, 409);
    const turn = inspection.turn;
    const challenge = humanApproval.issue({
      action: "reclaim-turn", taskId, turnSeq: turn.seq, claimedAt: turn.claimedAt, userId: actorOf(context).userId,
    }, task.title);
    if (!challenge) return reject(humanApprovalUnavailableReason(), 503);
    return context.json(challenge);
  });

  api.post("/tasks/:id/reclaim-turn", async (context) => {
    const taskId = context.req.param("id");
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task || !(await canSeeProject(actorOf(context), task.projectId))) return context.json({ error: "not found" }, 404);
    const reject = async (error: string, status: 400 | 403 | 409 | 503) => {
      await noteRejectedUserAction(taskId, "放开回合占位", error);
      return context.json({ error, reclaimed: false }, status);
    };
    const rejection = humanRequestRejection(context);
    if (rejection) return reject(rejection, 403);
    if (!humanApproval.fingerprint) return reject(humanApprovalUnavailableReason(), 503);
    const consent = await context.req.json().catch(() => null);
    if (consent?.acknowledgeDuplicateRisk !== true) {
      return reject("请先确认：放开互斥可能导致同一个任务的两个回合并行修改工作区", 400);
    }
    const inspection = inspectTurnReclaim(taskId);
    if (!inspection.ok) return reject(inspection.reason, 409);
    const turn = inspection.turn;
    const authorization = humanApproval.consume(consent.approval, {
      action: "reclaim-turn", taskId, turnSeq: turn.seq, claimedAt: turn.claimedAt, userId: actorOf(context).userId,
    });
    if (!authorization) return reject("缺少有效的离机人工授权，或授权已过期、已使用、占位已变化；请重新申请", 403);
    const outcome = await releaseSuspectTurn(taskId, undefined, humanActionOrigin(context), { seq: turn.seq, ...authorization });
    if (!outcome.ok) return reject(outcome.reason, 409);
    const effect = "；如果原来那一位其实还活着，互斥就没了，同一个任务可能有两个回合并行改同一个工作区";
    const note = outcome.runnable
      ? "已放开这个任务的回合占位，现在可以继续运行" + effect
      : `已放开这个任务的回合占位，但它还点不动运行：${outcome.nextStep ?? "请刷新查看当前状态"}` + effect;
    if (!outcome.runnable) await noteUserActionOutcome(taskId, "放开回合占位", "incomplete", note);
    return context.json({ reclaimed: true, ...outcome, note });
  });
}

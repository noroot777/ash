// 派活单的三个端点（逻辑在 dispatch-plan.ts / dispatch-plan-launch.ts）：
//   POST /tasks/:id/dispatch-plan          智能体摆单（MCP propose_dispatch），跟提问同一套回合与方向身份核对
//   POST /tasks/:id/dispatch-plan/launch   用户按「派出去」：ash 照卡上此刻的样子建任务并续上会话
//   PUT  /tasks/:id/dispatch-target        「派出去的活交给谁」（回复框胶囊点开那一层里的一行）
// 「发回去改」不在这里：它就是对那一问的普通答复（POST /tasks/:id/answer），一条任务都不建。
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { AGENT_TYPES, type AgentType } from "@ash/shared";
import { activeDispatchPlan, parseDispatchPlan } from "@ash/shared/dispatch-plan";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { executorScopeForOwner } from "./auth/owned-executors.js";
import { handoffBlockReason } from "./handoff-guard.js";
import { turnRole } from "./turn-lock.js";
import { setTaskQuestion, waitSlotTaken } from "./task-question.js";
import { publishTaskUpdated } from "./task-store.js";
import { now } from "./util.js";
import { batchPrerequisiteEdges } from "./prerequisite-routes.js";
import { newPlan, normalizeLaunch, normalizeProposal, normalizeTarget, planQuestionText, QUESTION_BLOCKS_PLAN } from "./dispatch-plan.js";
import { launchDispatchPlan, proposedTarget, targetLabeler } from "./dispatch-plan-launch.js";
import { NAVI_HEADERS, requestHeader } from "./request-headers.js";
import { pinReviewChoice, ReviewOnCreateError } from "./review-on-create.js";

export function mountDispatchPlanRoutes(api: Hono): void {
api.post("/tasks/:id/dispatch-plan", async (c) => {
  const taskId = c.req.param("id");
  const b = await c.req.json<{ order?: unknown; tasks?: unknown }>().catch(() => ({}) as { order?: unknown; tasks?: unknown });
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  // 建出来的任务要收在这条名下：只有普通的独立任务能派（团队、讨论、团队执行者各有各的归属，见 task-dispatch.ts）。
  if (r.mode !== "single" || r.parentId) return c.json({ error: "只有普通任务能摆派活单；团队调度台派活用 dispatch" }, 409);
  if (r.status !== "running") return c.json({ error: "只能在任务正在运行时摆派活单", status: r.status }, 409);
  const token = requestHeader(c, NAVI_HEADERS.turnToken);
  if (r.activeTurnToken && token !== r.activeTurnToken) {
    return c.json({ error: token ? "派活单来自已结束的回合，已拒绝写入" : "MCP 未携带当前回合身份，派活单已拒绝写入" }, 409);
  }
  const direction = requestHeader(c, NAVI_HEADERS.directionToken);
  if (r.activeDirectionToken && direction !== r.activeDirectionToken) {
    return c.json({ error: direction
      ? "派活单的方向身份已过期；请从最新用户消息的【当前方向身份】复制 directionToken 后重试"
      : "MCP 未携带当前方向身份（请传当前消息附带的 directionToken），派活单已拒绝写入" }, 409);
  }
  if (turnRole(taskId) === "reviewer") return c.json({ error: "审查回合不派活" }, 409);
  // 同一时刻只等用户一样东西。这一回合自己摆过的那张可以换一张（同一条路再摆一次就是改）。
  if (r.question && !activeDispatchPlan({ question: r.question, dispatchPlan: parseDispatchPlan(r.dispatchPlan) })) {
    return c.json({ error: QUESTION_BLOCKS_PLAN }, 409);
  }
  const scope = await executorScopeForOwner(r.ownerUserId);
  const proposal = normalizeProposal(b, scope);
  if ("error" in proposal) return c.json({ error: proposal.error }, 400);
  // 指定了审查者的那几条：名字换成 id、找不到当场退回（卡上要画得出是谁）。新任务归按「派出去」的人，
  // 这里先按这条任务的归属人核 —— 普通情况下是同一个人；不同时派出那一下还会按派的人再认一遍。
  try {
    for (const item of proposal.items) item.review = await pinReviewChoice(item.review, r.ownerUserId);
  } catch (error) {
    if (error instanceof ReviewOnCreateError) return c.json({ error: error.message }, 400);
    throw error;
  }
  // 前置先核一遍形状（同一批里的 key、不重复），派出去那一下还会按留下的几条再核。
  const shape = batchPrerequisiteEdges(proposal.items, proposal.items.map((_item, index) => `#${index}`));
  if (typeof shape === "string") return c.json({ error: shape }, 400);
  const label = await targetLabeler();
  const proposed = proposedTarget(r);
  const question = planQuestionText(proposal.order, proposal.items, (item) => {
    const target = proposed(item);
    return target ? label(target) : "默认执行器";
  });
  const plan = newPlan(proposal.order, proposal.items, question);
  const written = await setTaskQuestion({
    taskId, question, dispatchPlan: plan,
    currentTurn: { token: r.activeTurnToken, directionToken: r.activeDirectionToken },
  });
  if (!written) {
    const latest = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (latest && waitSlotTaken(latest, true)) return c.json({ error: QUESTION_BLOCKS_PLAN }, 409);
    return c.json({ error: "当前回合已经结束或已被引导，派活单未写入" }, 409);
  }
  return c.json({ proposed: true, planId: plan.id, tasks: plan.items.length, willSettleAs: "paused" });
});

api.post("/tasks/:id/dispatch-plan/launch", async (c) => {
  const taskId = c.req.param("id");
  const b = await c.req.json<{ planId?: unknown; order?: unknown; items?: unknown }>()
    .catch(() => ({}) as { planId?: unknown; order?: unknown; items?: unknown });
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return c.json({ error: "not found" }, 404);
  if (task.archived) return c.json({ error: "任务已归档，先取消归档再派", archived: true }, 409);
  const blocked = handoffBlockReason(task.handoff);
  if (blocked) return c.json({ error: blocked, handoff: true }, 409);
  const plan = activeDispatchPlan({ question: task.question, dispatchPlan: parseDispatchPlan(task.dispatchPlan) });
  if (!plan) return c.json({ error: "这条任务没有在等你过目的派活单，请刷新后再看" }, 409);
  if (task.status === "running" || task.status === "queued") {
    return c.json({ error: "摆单的那一轮还没结束，等它停下再派", status: task.status }, 409);
  }
  const launch = normalizeLaunch(plan, b, await executorScopeForOwner(task.ownerUserId));
  if ("error" in launch) return c.json({ error: launch.error }, launch.status);
  const result = await launchDispatchPlan(c, task, plan, launch.order, launch.picks);
  return c.json(result.body, result.status);
});

api.put("/tasks/:id/dispatch-target", async (c) => {
  const taskId = c.req.param("id");
  const b = await c.req.json<{ target?: unknown }>().catch(() => ({}) as { target?: unknown });
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return c.json({ error: "not found" }, 404);
  if (task.archived) return c.json({ error: "任务已归档，先取消归档再改", archived: true }, 409);
  if (task.mode !== "single" || task.parentId) return c.json({ error: "只有普通任务能设派出去的活交给谁" }, 409);
  let stored: string | null = null;
  if (b.target !== null && b.target !== undefined) {
    const raw = b.target as { agentType?: unknown };
    if (typeof raw.agentType !== "string" || !AGENT_TYPES.includes(raw.agentType as AgentType)) {
      return c.json({ error: "target.agentType 要写明交给哪种智能体；改回同这里传 null" }, 400);
    }
    const target = normalizeTarget(raw, await executorScopeForOwner(task.ownerUserId), "target");
    if (!target || "error" in target) return c.json({ error: target ? target.error : "target 要写明交给谁" }, 400);
    stored = JSON.stringify(target);
  }
  await db.update(tasks).set({ dispatchTarget: stored, updatedAt: now() }).where(eq(tasks.id, taskId));
  return c.json(await publishTaskUpdated(taskId));
});
}

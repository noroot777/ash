import type { TaskStage } from "@harness/shared";
import { isTaskStage, STAGE_LABELS, STAGE_ORDER } from "@harness/shared";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";

export async function setTaskStage(
  taskId: string,
  stage: TaskStage,
): Promise<{ updatedAt: string; timelineRecorded: boolean }> {
  const updatedAt = now();
  await db.update(tasks).set({ stage, updatedAt }).where(eq(tasks.id, taskId));
  bus.publish({ type: "task.stage", taskId, stage, updatedAt });
  const timelineRecorded = await appendTaskTimeline(taskId, `验收阶段更新：${STAGE_LABELS[stage]}（${stage}）`);
  return { updatedAt, timelineRecorded };
}

/**
 * 把验收阶段清回「进行中」并广播。
 *
 * 两个调用方：已验收任务被重新唤醒（下面那个），以及**中途人工关口放行**（一条线上写了
 * 不止一道「等我点头」时，前面那几道点完只是放行，任务得从「待验收」回到进行中，不然
 * 它会一直挂着一句「待验收」而线其实已经往下走了）。广播一步都不能省，否则列表分组
 * 要等下次全量拉取才动。
 */
export async function clearTaskStage(taskId: string, note: string): Promise<void> {
  const updatedAt = now();
  await db.update(tasks).set({ stage: null, updatedAt }).where(eq(tasks.id, taskId));
  bus.publish({ type: "task.stage", taskId, stage: null, updatedAt });
  await appendTaskTimeline(taskId, note);
}

// 已验收的任务又被唤醒 —— 用户发来真人消息、或调度者接着派活 —— 就把 stage 清回
// null,列表把它从「已验收」挪回「进行中」;干完再验收一次即可翻篇。accepted 只代表
// 上一版产物已经验收,不能覆盖验收后的新增改动;这条规则对 single/team/debate 一致。
// 走内部更新而不是 POST /tasks/:id/stage:那道 mode==="team" 的 409 是挡 **agent 自报**
// 的外部协议入口(调度台没有实现/验证语义),挡的不是这条内部规则;广播必须保留,
// 否则前端分组要等下次全量拉取才动。
export async function reopenAcceptedStage(taskId: string): Promise<boolean> {
  const t = (await db.select({ stage: tasks.stage }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!t || t.stage !== "accepted") return false;
  await clearTaskStage(taskId, "任务又被唤醒，验收阶段清回进行中（完成后重新验收即可再次翻篇）");
  return true;
}

export function mountTaskStageRoutes(api: Hono): void {
  api.post("/tasks/:id/stage", async (c) => {
    const taskId = c.req.param("id");
    const body = await c.req
      .json<{ stage?: unknown }>()
      .catch(() => ({}) as { stage?: unknown });
    if (!isTaskStage(body.stage)) {
      return c.json({ error: `stage 非法，只能是：${STAGE_ORDER.join(" | ")}` }, 400);
    }

    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task) return c.json({ error: "not found" }, 404);
    // 团队调度台是常驻协调角色，没有「实现/验证/验收」语义。验证阶段现在由被验任务
    // 在自己的验证回合里上报（存量的独立审查任务仍给被审对象上报）；服务端保留兼容
    // 入口，不硬封普通任务调用。
    if (task.mode === "team") {
      return c.json({ error: "团队调度台不适用验收阶段，请在被验任务的验证回合里上报", mode: task.mode }, 409);
    }
    if (task.archived) return c.json({ error: "归档任务不能再上报验收阶段" }, 409);

    const { updatedAt, timelineRecorded } = await setTaskStage(taskId, body.stage);
    return c.json({ reported: true, taskId, stage: body.stage, updatedAt, timelineRecorded });
  });
}

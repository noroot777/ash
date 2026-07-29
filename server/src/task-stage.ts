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
  bus.publish({ type: "task.stage", taskId, stage });
  const timelineRecorded = await appendTaskTimeline(taskId, `验收阶段更新：${STAGE_LABELS[stage]}（${stage}）`);
  return { updatedAt, timelineRecorded };
}

// 已验收的协作任务(team/debate)又被唤醒 —— 用户发来真人消息、或调度者接着派活 ——
// 就把 stage 清回 null,列表把它从「已验收」挪回「进行中」;干完再验收一次即可翻篇。
// 理由:团队级验收把调度台标成 accepted,可用户验收后照样能继续使唤这支队伍,那时
// 它明明在干活却还挂在已验收组里(用户实测困惑「怎么不见进行中」)。
// 走内部更新而不是 POST /tasks/:id/stage:那道 mode==="team" 的 409 是挡 **agent 自报**
// 的外部协议入口(调度台没有实现/验证语义),挡的不是这条内部规则;广播必须保留,
// 否则前端分组要等下次全量拉取才动。
export async function reopenAcceptedStage(taskId: string): Promise<boolean> {
  const t = (
    await db.select({ mode: tasks.mode, stage: tasks.stage }).from(tasks).where(eq(tasks.id, taskId))
  ).at(0);
  if (!t || t.stage !== "accepted") return false;
  if (t.mode !== "team" && t.mode !== "debate") return false;
  await db.update(tasks).set({ stage: null, updatedAt: now() }).where(eq(tasks.id, taskId));
  bus.publish({ type: "task.stage", taskId, stage: null });
  await appendTaskTimeline(taskId, "任务又被唤醒，验收阶段清回进行中（完成后重新验收即可再次翻篇）");
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
    // 团队调度台是常驻协调角色，没有「实现/验证/验收」语义；它派出的执行者仍是
    // 普通任务，会正常走这里。stage 与 status 正交，所以除此之外不做状态机校验。
    if (task.mode === "team") {
      return c.json({ error: "团队调度台不适用验收阶段，请由具体执行者上报", mode: task.mode }, 409);
    }
    if (task.archived) return c.json({ error: "归档任务不能再上报验收阶段" }, 409);

    const { updatedAt, timelineRecorded } = await setTaskStage(taskId, body.stage);
    return c.json({ reported: true, taskId, stage: body.stage, updatedAt, timelineRecorded });
  });
}

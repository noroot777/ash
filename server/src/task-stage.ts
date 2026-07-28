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

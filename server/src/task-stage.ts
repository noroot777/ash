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

// 已翻篇的任务又被唤醒 —— 用户发来真人消息、或调度者接着派活 —— 就把 stage 清回
// null,列表把它从「已验收」挪回「进行中」;干完再验收一次即可翻篇。
//
// **accepted 和 merged 都要清**:merged 是「已经合进去了、只差最后落个验收章」,同样是
// 上一版的结论。留着它的后果不只是显示不准 —— `enterHumanGate` 见到 merged 会**静默
// 跳过**「等我点头」那道关口(review.ts),于是新一版改动一路走到底、连问都不问用户一句。
// accepted 只代表上一版产物已经验收,不能覆盖验收后的新增改动;这条规则对
// single/team/duet 一致。
// 走内部更新而不是 POST /tasks/:id/stage:那道 mode==="team" 的 409 是挡 **agent 自报**
// 的外部协议入口(调度台没有实现/验证语义),挡的不是这条内部规则;广播必须保留,
// 否则前端分组要等下次全量拉取才动。
//
// **返回摘掉的是哪块牌子**（没摘则 null）：摘牌发生在回合最前面，那时还不知道这一轮
// 会不会真产出改动。调用方要能在结算时发现「白摘了」并原样挂回去（见 turn-baseline.ts
// 与下面的 restoreTaskStage）。旧调用方只判真假的话语义不变 —— 摘到了就是真值。
export async function reopenAcceptedStage(taskId: string): Promise<"accepted" | "merged" | null> {
  const t = (await db.select({ stage: tasks.stage }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!t || (t.stage !== "accepted" && t.stage !== "merged")) return null;
  await clearTaskStage(taskId, "任务又被唤醒，验收阶段清回进行中（完成后重新验收即可再次翻篇）");
  return t.stage;
}

/**
 * 把 `reopenAcceptedStage` 摘掉的牌子原样挂回去，与 clearTaskStage 对称（同样自带 note
 * 和广播）。用在「这一轮结算下来工作目录一个字节没变」——用户只是问了句话，摘牌是白摘的。
 *
 * **只在牌子位还空着时放回**：这一轮 agent 自己上报过新阶段（report_stage）的话，那是更
 * 新的结论，不能被一张旧牌子盖掉。
 */
export async function restoreTaskStage(taskId: string, stage: TaskStage, note: string): Promise<boolean> {
  const t = (await db.select({ stage: tasks.stage }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!t || t.stage) return false;
  const updatedAt = now();
  await db.update(tasks).set({ stage, updatedAt }).where(eq(tasks.id, taskId));
  bus.publish({ type: "task.stage", taskId, stage, updatedAt });
  await appendTaskTimeline(taskId, note);
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

    try {
      const { reportFreeReviewConclusion } = await import("./free-workflow.js");
      const freeReview = await reportFreeReviewConclusion(taskId, body.stage);
      if (freeReview) {
        return c.json({ reported: true, taskId, stage: body.stage, freeReview, timelineRecorded: false });
      }
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
    if (task.workflowMode === "free") {
      return c.json({ error: "自由工作流不使用起手式 stage；请由页面快捷按钮按需派审、预览或合并" }, 409);
    }

    const { updatedAt, timelineRecorded } = await setTaskStage(taskId, body.stage);
    return c.json({ reported: true, taskId, stage: body.stage, updatedAt, timelineRecorded });
  });
}

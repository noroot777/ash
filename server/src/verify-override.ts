// 人工替一站「自动验证」签字放行。
//
// 为什么非有不可：验证站是会停下来等的锚点，而它停下来的方式有三种——验证器给了
// verify_failed、自动复审轮数用尽、以及那一轮跑完了但谁也没给结论（验证器没上报）。
// 三种的共同点是**这条线不会自己再往下走了**，而原先界面上唯一的出路是「再验一轮」；
// 验证器不认账的东西，多验几轮它还是不认，于是任务就永远停在第四站。人得能替它签字。
//
// 三条口径：
// ① **签字的是人，不是验证器**：绝不改那一轮的证据（`review/round-<n>/` 里 verify_failed
//    的报告原样留着），只在任务身上落 `verified`，并往时间线写明这是人工强制通过。
//    回头改证据等于伪造验证结论，日后没人分得清哪一轮是真验过的。
// ② **往下走必须走 `advanceWorkflowFrom`**（推进的唯一实现处），不许自己挪游标：这一站
//    之后那一段（跑构建、开预览、**合并并清理**）归它跑。绕过去等于这条线画了跟没画一
//    样。所以在「验证 → 合并」这种线上，强制通过是**不可逆**的，前端确认框必须照实说。
// ③ **判据是游标**，不是 stage：只有游标真停在某个 verify 站上才受理。跟人工关口那两个
//    真按钮同一条规矩——stage 可能是 agent 自报的，也可能属于线上另一站。
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { STEP_LABELS } from "@harness/shared/workflow";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { setTaskStage } from "./task-stage.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";
import { advanceWorkflowFrom } from "./workflow-advance.js";
import { taskWorkflowDef } from "./workflows.js";

export interface VerifyOverrideResult {
  forced: true;
  taskId: string;
  /** 被签字放行的那一站 */
  station: string;
  /** 推进之后游标停在哪一站（null = 这条线没有编排/没动） */
  workflowAt: string | null;
  /** 推进之后的验收阶段（走到人工关口是 awaiting_acceptance，合并完是 merged/accepted） */
  stage: string | null;
  /** 往下走的时候出错了：签字已经落下，但这一段没跑完，如实带回去 */
  advanceError?: string;
}

export type VerifyOverrideFailure = { error: string; httpStatus: 404 | 409 } & Record<string, unknown>;

/**
 * 强制通过游标所在的那一站验证，然后照常往下走。
 *
 * 返回失败对象而不是抛异常：调用方（HTTP 路由）要把不同的挡回理由原样转成 404/409，
 * 用异常传就只能靠比对错误文案。
 */
export async function forcePassVerifyStation(
  taskId: string,
): Promise<VerifyOverrideResult | VerifyOverrideFailure> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return { error: "not found", httpStatus: 404 };
  if (task.reviewOf) return { error: "审查任务自身没有验证站", httpStatus: 409 };
  if (task.mode !== "single") {
    return { error: "只有 single 任务有验证站", mode: task.mode, httpStatus: 409 };
  }
  if (task.archived) return { error: "归档任务不能强制通过验证", httpStatus: 409 };
  // 还在跑就不受理：那一轮验证可能下一秒就给出结论，此刻签字等于跟它抢方向盘，
  // 而 `advanceWorkflowFrom` 跑的那一段又会跟正在跑的回合撞进同一个工作目录。
  if (task.status === "running" || task.status === "queued") {
    return { error: "任务仍在运行或排队，结束后再强制通过", status: task.status, httpStatus: 409 };
  }

  const def = taskWorkflowDef(task.workflow);
  const station = def?.steps.find((step) => step.id === task.workflowAt) ?? null;
  if (!def || !station) {
    return { error: "这个任务没有编排，或者游标没停在任何一站上", httpStatus: 409 };
  }
  if (station.kind !== "verify") {
    return {
      error: `这条线此刻停在「${STEP_LABELS[station.kind]}」，不是「${STEP_LABELS.verify}」`,
      station: station.id,
      kind: station.kind,
      httpStatus: 409,
    };
  }

  // 有一轮验证卡在半路（任务已经不跑了，`verify_round` 却还挂着）：那一轮不会再有结论
  // 了，签字之前先把这把锁摘掉，否则任务身上会一直显示「正在验证」。**不加 verify_rounds
  // 计数**——它没跑完，不该占掉用户写的轮数额度。
  if (task.verifyRound) {
    await db.update(tasks).set({ verifyRound: null, updatedAt: now() }).where(eq(tasks.id, taskId));
    await appendTaskTimeline(taskId, `第 ${task.verifyRound} 轮验证没有给出结论就停了，人工强制通过时一并收尾。`);
    bus.publish({ type: "task.review", taskId });
  }
  // 验证回合中途提过问、人却选择直接放行：卡片留着会显示成「还等着你答」，但那个回合
  // 早已结束，没有任何人在等这个答复了。撤下来并说明。
  if (task.question) {
    const updatedAt = now();
    await db
      .update(tasks)
      .set({ question: null, questionOptions: null, questionItems: null, updatedAt })
      .where(eq(tasks.id, taskId));
    bus.publish({ type: "task.question", taskId, updatedAt, question: null, questionOptions: null, questionItems: null });
    await appendTaskTimeline(taskId, "验证轮里提的那个问题随强制通过一并撤下（那一回合已经结束，没人在等答复）。");
  }

  await appendTaskTimeline(
    taskId,
    `人工强制通过「${STEP_LABELS.verify}」这一站：这不是验证器给的结论，`
    + `第 ${task.verifyRounds ?? 0} 轮验证的报告与证据原样保留，由人签字放行后接着往下走。`,
  );
  await setTaskStage(taskId, "verified");

  // 重读一遍再推进：stage 刚改过，而 `advanceWorkflowFrom` 拿这一行去判下一站怎么办
  // （verifyStationAction 要读 stage），塞一份旧的进去就白改了。
  const fresh = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  let advanceError: string | undefined;
  if (fresh) {
    await advanceWorkflowFrom(fresh, def, station.id).catch(async (error) => {
      advanceError = error instanceof Error ? error.message : String(error);
      await appendTaskTimeline(taskId, `强制通过之后想接着往下走，但出错了（${advanceError}），请手动续跑。`);
    });
  }

  const after = (await db
    .select({ workflowAt: tasks.workflowAt, stage: tasks.stage })
    .from(tasks)
    .where(eq(tasks.id, taskId))).at(0);
  return {
    forced: true,
    taskId,
    station: station.id,
    workflowAt: after?.workflowAt ?? null,
    stage: after?.stage ?? null,
    ...(advanceError ? { advanceError } : {}),
  };
}

export function mountVerifyOverrideRoutes(api: Hono): void {
  api.post("/tasks/:id/workflow/verify-override", async (c) => {
    const result = await forcePassVerifyStation(c.req.param("id"));
    if ("forced" in result) return c.json(result);
    const { httpStatus, ...body } = result;
    return c.json(body, httpStatus);
  });
}

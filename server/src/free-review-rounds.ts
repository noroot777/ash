// 审查进行中调整这条审查链的轮数上限（run.retryLimit）。
//
// 这一轮的「未通过之后怎么办」完全由轮数上限决定：还有轮数 → 意见交给执行者修复、修完自动
// 续审；用完 → 停下来等用户。上限原先只能在派审那一刻定死，于是最后一轮跑着时用户想多给
// 一轮，唯一的办法是等它判完「用完」、再手动按意见修复、再预约复审——三步才补回一个数字。
//
// 改的是 run 行本身而不是预约槽：续轮在同一个 run 上跑（审查者、执行器、会话都冻结在
// run 行里），轮数只是这条链的一个参数。结算那一侧在落笔事务里重读 run 行的上限（见
// handleFreeWorkflowSettlement），所以这里只要在「这一轮还没结算」时写进去就一定生效；
// 晚了一步（结算已经把 run 收成 stopped/passed）就如实拒掉，不假装改上了。
import type { FreeReviewRoundsInput } from "@ash/shared";
import { and, eq } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { freeReviewRuns, tasks } from "./db/schema.js";
import { retryLimit } from "./free-review-input.js";
import { releaseFreeWorkflowAction, tryAcquireFreeWorkflowAction } from "./free-workflow-lock.js";
import { freeWorkflowState, type FreeWorkflowApiState } from "./free-workflow-state.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";

export async function adjustFreeReviewRounds(
  taskId: string,
  input: Partial<FreeReviewRoundsInput>,
): Promise<FreeWorkflowApiState> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) throw new Error("任务不存在");
  if (task.mode !== "single" || task.parentId || task.reviewOf || task.workflowMode !== "free") throw new Error("当前任务不支持自由审查");
  if (task.archived) throw new Error("归档任务不能调整审查");
  if (task.stage === "accepted" || task.stage === "merged") throw new Error("任务已进入验收结果，不能调整审查");
  const runId = typeof input.runId === "string" ? input.runId : "";
  const retries = retryLimit(input.retryLimit);
  if (!tryAcquireFreeWorkflowAction(taskId)) throw new Error("当前已有自由工作流操作正在进行");
  try {
    const run = (await db.select().from(freeReviewRuns)
      .where(and(eq(freeReviewRuns.id, runId), eq(freeReviewRuns.taskId, taskId)))).at(0);
    if (!run) throw new Error("审查记录不存在");
    if (run.targetKind === "accepted_merge") throw new Error("合并结果审查只跑一轮，不能调整轮数");
    if (run.status !== "reviewing") throw new Error("这条审查已经结束，轮数没有改动");
    // 正在跑的这一轮本身就占一轮：上限不能低于它，否则「第 3 轮 / 最多 2 轮」自相矛盾。
    if (retries + 1 < run.currentRound) {
      throw new Error(`已经跑到第 ${run.currentRound} 轮，最多轮数不能少于 ${run.currentRound}`);
    }
    if (retries !== run.retryLimit) {
      // 条件写：只在「还是这一轮、还在审查中」时改。结算的落笔事务与这一笔互斥（SQLite 单写者），
      // 谁先落谁算数——结算先落，这里改不上，如实告诉用户；这里先落，结算读到的就是新上限。
      const updated = await db.update(freeReviewRuns).set({ retryLimit: retries, updatedAt: now() })
        .where(and(eq(freeReviewRuns.id, run.id), eq(freeReviewRuns.status, "reviewing"),
          eq(freeReviewRuns.currentRound, run.currentRound)))
        .returning({ id: freeReviewRuns.id });
      if (!updated.length) throw new Error("这一轮审查刚刚结束，轮数没有改动");
      const last = retries + 1 === run.currentRound;
      await appendTaskTimeline(taskId, `审查轮数已调整：最多 ${retries + 1} 轮（原 ${run.retryLimit + 1} 轮）。` +
        (last ? `第 ${run.currentRound} 轮是最后一轮，未通过就停下来等你处理。`
          : `第 ${run.currentRound} 轮未通过时，意见交给执行者修复，修完自动续审。`));
      bus.publish({ type: "task.review", taskId });
    }
    return freeWorkflowState(taskId);
  } finally {
    releaseFreeWorkflowAction(taskId);
  }
}

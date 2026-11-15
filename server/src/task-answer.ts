import { eq } from "drizzle-orm";
import type { QuestionAnswerInput } from "@ash/shared/questions";
import type { Context } from "hono";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { freeReviewResumeOptions } from "./free-workflow.js";
import { handoffBlockReason } from "./handoff-guard.js";
import { continueTask } from "./orchestrator.js";
import { enqueueMessage, pendingMessageRow, publishPendingMessages, deliverPendingMessages, flushPendingWhenTurnIdle } from "./pending-messages.js";
import { claimQueueSeat } from "./queue-seat.js";
import { askingAgentFor } from "./task-question.js";
import { actorOf, ownerIdOf } from "./auth/context.js";
import { claimQuestionAnswer, prepareQuestionRecord } from "./task-question-record.js";
import { queueReviewAnswer } from "./review-continuation.js";
import { ReviewSuperseded } from "./review-ownership.js";
import { questionWaitOrigin } from "./task-wait-ownership.js";

export type TaskAnswerBody = QuestionAnswerInput & { answer?: string; attachments?: string[] };

/** 普通答复路由和远程接力代理共用的提问 CAS + 续会话实现。 */
export async function answerTask(c: Context, taskId: string, body?: TaskAnswerBody): Promise<Response> {
  const b = body ?? await c.req.json<TaskAnswerBody>().catch(() => ({} as TaskAnswerBody));
  if (b.answer !== undefined && typeof b.answer !== "string") return c.json({ error: "answer 必须是文本" }, 400);
  const answer = (b.answer ?? "").trim();
  if (!answer && b.answers === undefined) return c.json({ error: "answer 不能为空" }, 400);
  if (b.attachments !== undefined && (!Array.isArray(b.attachments) || b.attachments.some((path) => typeof path !== "string"))) {
    return c.json({ error: "attachments 必须是路径数组" }, 400);
  }
  if (b.questionOccurrence !== undefined && typeof b.questionOccurrence !== "string") return c.json({ error: "questionOccurrence 必须是文本" }, 400);
  // 附件随答复一起进那一轮（与回复同一条路：投递时拼进提示词、文件归到这个任务）。
  const attachments = b.attachments?.length ? { attachments: b.attachments } : {};
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return c.json({ error: "not found" }, 404);
  if (task.archived) return c.json({ error: "任务已归档，先取消归档再答复", archived: true }, 409);
  const blocked = handoffBlockReason(task.handoff);
  if (blocked) return c.json({ error: blocked, handoff: true }, 409);
  if (!task.question) return c.json({ error: "该任务没有待答复的问题", status: task.status }, 409);
  if (task.mode !== "team" && (task.status === "running" || task.status === "queued")) {
    return c.json({ error: "提问回合还没结束,等任务落 paused 再答复", status: task.status }, 409);
  }

  let record;
  try {
    record = prepareQuestionRecord(task, answer, b);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, error instanceof TypeError ? 400 : 409);
  }
  const origin = await db.transaction((transaction) => questionWaitOrigin(transaction, task), { behavior: "immediate" });
  const asker = task.mode === "single" ? await askingAgentFor(taskId, origin.kind === "ordinary" ? "single" : undefined) : null;
  const reviewRoute = origin.kind === "review" && asker?.role === "reviewer" ? await freeReviewResumeOptions(taskId) : null;
  const route = reviewRoute ?? (asker && asker.agent !== task.agentType
    ? { agent: asker.agent, executorId: asker.executorId, model: null, reasoningEffort: null }
    : {});
  const answerText = record.reply;
  // 这条答复的身份跟着原话走（排队的那一路在 answer_id 列上），落进会话那条用户回合：删除消息与
  // 问答卡都按它认记录，不按原文猜（两次都答「可以」时原文一模一样）。
  const answerIds = [record.id];
  // 答复也是真人回合:共享项目里给别人的任务答疑,烧的是**我**的 key(§八)。
  const acting = ownerIdOf(actorOf(c));
  let reviewQueued = false;
  try {
    if (!await claimQuestionAnswer(task, record, async (transaction) => {
      reviewQueued = await queueReviewAnswer(transaction, task,
        pendingMessageRow({ taskId, text: answerText, ...attachments, ...route, ownerUserId: acting, answerId: record.id }));
    })) return c.json({ error: "问题已更新或已被答复，本次未投递，请刷新后查看" }, 409);
  } catch (error) {
    if (error instanceof ReviewSuperseded) {
      await (await import("./regression-settlement.js")).reconcileRegressionSettlements(taskId)
        .catch((failure) => console.error(`[ash] 失效审查收口待重试 ${taskId}:`, failure));
      return c.json({ error: error.message }, 409);
    }
    throw error;
  }
  bus.publish({ type: "task.question", taskId, updatedAt: record.answeredAt, question: null, questionOptions: null, questionItems: null, answeredQuestion: record });
  if (reviewQueued) {
    publishPendingMessages(taskId);
    void deliverPendingMessages(taskId).catch((error) => console.error(`[ash] 审查答复待投递 ${taskId}:`, error));
    return c.json({ answered: true, resumed: false, queued: true, record });
  }
  // paused 的提问任务,答复续跑**是任务的执行回合**(selectNextInQueue 对 paused+question
  // 停队等它,它占着队列位置),必须过共用的队列认领(queue-seat.ts)——此前这里直接
  // continueTask,B 自身空闲就续跑成功,同队前项还在跑也拦不住(第 8 轮审查拦验收 2:
  // 页面发送答复后两任务并跑)。被挡时答复**不丢**:claimQuestionAnswer 已把记录持久化
  // 进历史,这里再落一条执行型待发送消息进托盘(带执行器路由与发送者身份),页面由托盘
  // 表达「等前项结束」;轮到时让位交接/补投扫描把它作为首轮输入送进 asker 会话,恰好一次。
  // team 调度台常驻、不进队列,保持原路直送。
  //
  // **不是任务执行的答复不占位**,两类:
  // · 审查者提问(asker.role=reviewer)与未收尾的就地验证轮(verifyRound 非空)——旁路回合;
  // · 终态任务上的提问 —— 执行回合里提的问会让任务落 paused,终态上挂着的问题出自续聊回合:
  //   它以提问结束时 settle-status.ts 续聊那一支刻意让任务保持原终态、不改 paused(改了就会
  //   重新占住队列位置),答复就是又一个续聊回合。
  // 占位先把 done 改成 queued,orchestrator 就只能把 followUpFrom 写成 null:这一轮成了任务
  // 的执行回合,停止会把原任务结算成 canceled、没交卷会结算成 failed(第 9 轮审查:队列中已完成
  // 任务答复审查提问后 stop,任务从 done 变 canceled);同队有人在跑时则认领失败、答复暂存成
  // 执行型,要等整条队列跑完(2026-11-13 现场)。不在队列的终态任务认领直接放行,从没出过事。
  const terminal = task.status === "done" || task.status === "failed" || task.status === "canceled";
  const sideways = terminal || (origin.kind !== "ordinary" && (asker?.role === "reviewer" || task.verifyRound !== null));
  if (task.mode === "single" && !sideways) {
    const claim = await claimQueueSeat(taskId);
    if (!claim.ok) {
      await enqueueMessage({ taskId, text: answerText, ...attachments, ...route, ownerUserId: acting, execution: true, answerId: record.id });
      return c.json({ answered: true, resumed: false, queued: true, blockedBy: claim.blockers, record });
    }
    const seat = claim.seat;
    let stashed = false;
    void continueTask(taskId, answerText, { ...attachments, ...route, actingUserId: acting, answerIds })
      .then(async (started) => {
        if (started) return;
        // 回合被别的执行抢占:原话退回托盘,仍按执行型等队列位置,不按终态续聊放行。
        await enqueueMessage({ taskId, text: answerText, ...attachments, ...route, ownerUserId: acting, execution: true, answerId: record.id });
        stashed = true;
      })
      .catch((err) => console.error(`[ash] 答复续跑 ${taskId} 异常:`, err))
      .finally(async () => {
        if (seat) await seat.release().catch((err) => console.error(`[ash] 答复续跑 ${taskId} 释放执行位失败:`, err));
        // 占着回合的多半是**还在收尾**的提问那一轮(状态已落 paused、锁还没放):它放锁时会扫到这一行。
        // 先放执行位再扫:扫描要重新认领它(同 task-reply.ts)。
        if (stashed) flushPendingWhenTurnIdle(taskId);
      });
    return c.json({ answered: true, resumed: true, record });
  }
  void continueTask(taskId, answerText, { ...attachments, ...route, actingUserId: acting, answerIds }).then(async (started) => {
    if (started) return;
    // 退回托盘的这一条同样不是执行型:轮到它时仍是续聊,不等队列。
    await enqueueMessage({ taskId, text: answerText, ...attachments, ...route, ownerUserId: acting, answerId: record.id });
    flushPendingWhenTurnIdle(taskId);
  });
  return c.json({ answered: true, resumed: true, record });
}

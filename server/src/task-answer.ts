import { eq } from "drizzle-orm";
import type { QuestionAnswerInput } from "@ash/shared/questions";
import type { Context } from "hono";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { freeReviewResumeOptions } from "./free-workflow.js";
import { handoffBlockReason } from "./handoff-guard.js";
import { continueTask } from "./orchestrator.js";
import { enqueueMessage } from "./pending-messages.js";
import { claimQueueSeat } from "./queue-seat.js";
import { askingAgentFor } from "./task-question.js";
import { actorOf, ownerIdOf } from "./auth/context.js";
import { claimQuestionAnswer, prepareQuestionRecord } from "./task-question-record.js";

export type TaskAnswerBody = QuestionAnswerInput & { answer?: string };

/** 普通答复路由和远程接力代理共用的提问 CAS + 续会话实现。 */
export async function answerTask(c: Context, taskId: string, body?: TaskAnswerBody): Promise<Response> {
  const b = body ?? await c.req.json<TaskAnswerBody>().catch(() => ({} as TaskAnswerBody));
  if (b.answer !== undefined && typeof b.answer !== "string") return c.json({ error: "answer 必须是文本" }, 400);
  const answer = (b.answer ?? "").trim();
  if (!answer && b.answers === undefined) return c.json({ error: "answer 不能为空" }, 400);
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
  if (!(await claimQuestionAnswer(task, record))) {
    return c.json({ error: "问题已更新或已被答复，本次未投递，请刷新后查看" }, 409);
  }
  bus.publish({ type: "task.question", taskId, updatedAt: record.answeredAt, question: null, questionOptions: null, questionItems: null, answeredQuestion: record });

  const asker = task.mode === "single" ? await askingAgentFor(taskId) : null;
  const reviewRoute = asker?.role === "reviewer" ? await freeReviewResumeOptions(taskId) : null;
  const route = reviewRoute ?? (asker && asker.agent !== task.agentType
    ? { agent: asker.agent, executorId: asker.executorId, model: null, reasoningEffort: null }
    : {});
  const answerText = record.reply;
  // 答复也是真人回合:共享项目里给别人的任务答疑,烧的是**我**的 key(§八)。
  const acting = ownerIdOf(actorOf(c));
  // 排在后面的提问任务,答复续跑**是任务的执行回合**(selectNextInQueue 对 paused+question
  // 停队等它,它占着队列位置),必须过共用的队列认领(queue-seat.ts)——此前这里直接
  // continueTask,B 自身空闲就续跑成功,同队前项还在跑也拦不住(第 8 轮审查拦验收 2:
  // 页面发送答复后两任务并跑)。被挡时答复**不丢**:claimQuestionAnswer 已把记录持久化
  // 进历史,这里再落一条执行型待发送消息进托盘(带执行器路由与发送者身份),页面由托盘
  // 表达「等前项结束」;轮到时让位交接/补投扫描把它作为首轮输入送进 asker 会话,恰好一次。
  // team 调度台常驻、不进队列,保持原路直送。
  if (task.mode === "single") {
    const claim = await claimQueueSeat(taskId);
    if (!claim.ok) {
      await enqueueMessage({ taskId, text: answerText, ...route, ownerUserId: acting, execution: true });
      return c.json({ answered: true, resumed: false, queued: true, blockedBy: claim.blockers, record });
    }
    const seat = claim.seat;
    void continueTask(taskId, answerText, { ...route, actingUserId: acting })
      .then(async (started) => {
        if (started) return;
        // 回合被别的执行抢占:原话退回托盘,仍按执行型等队列位置,不按终态续聊放行。
        await enqueueMessage({ taskId, text: answerText, ...route, ownerUserId: acting, execution: true });
      })
      .catch((err) => console.error(`[ash] 答复续跑 ${taskId} 异常:`, err))
      .finally(() => { if (seat) void seat.release(); });
    return c.json({ answered: true, resumed: true, record });
  }
  void continueTask(taskId, answerText, { ...route, actingUserId: acting }).then(async (started) => {
    if (started) return;
    await enqueueMessage({ taskId, text: answerText, ...route, ownerUserId: acting });
  });
  return c.json({ answered: true, resumed: true, record });
}

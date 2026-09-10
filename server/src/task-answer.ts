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
  void continueTask(taskId, answerText, { ...route, actingUserId: acting }).then(async (started) => {
    if (started) return;
    await enqueueMessage({ taskId, text: answerText, ...route, ownerUserId: acting });
  });
  return c.json({ answered: true, resumed: true, record });
}

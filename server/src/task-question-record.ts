import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { formatQuestionAnswers, questionItems, questionKey } from "@ash/shared/questions";
import type { QuestionAnswerInput, QuestionRecord, QuestionSource } from "@ash/shared/questions";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import type { TaskRow } from "./task-store.js";
import { now } from "./util.js";
import type { ConclusionTransaction } from "./regression-conclusion-commit.js";
import { questionOccurrenceOf } from "./task-wait-ownership.js";
import { announceDispatchSignalsTo, markDispatchQuestionAnswered } from "./dispatch-signals.js";
import { activeDispatchPlan, parseDispatchPlan } from "@ash/shared/dispatch-plan";

/** 派活单被发回来改时，答复最前面那一句（智能体据此知道一条都没建）。 */
export const DISPATCH_PLAN_RETURNED = "（派活单没有派出，一条任务都没建。用户的意见如下，按它改完可以再摆一次。）";

export function prepareQuestionRecord(task: TaskRow, answer: string, input: QuestionAnswerInput): QuestionRecord {
  const source: QuestionSource = {
    question: task.question,
    questionOptions: task.questionOptions ? JSON.parse(task.questionOptions) : null,
    questionItems: task.questionItems ? JSON.parse(task.questionItems) : null,
  };
  if (input.questionKey !== undefined && input.questionKey !== questionKey(source)) {
    throw new Error("问题已更新，请查看最新问题后重新答复");
  }
  // 题面相同也可能是又问了一次：带着发问那一次身份来的（飞书卡片），只答那一次。之后到写入之间
  // 任务再变，claimQuestionAnswer 按整行条件写，照样落空。
  if (input.questionOccurrence !== undefined && input.questionOccurrence !== questionOccurrenceOf(task)) {
    throw new Error("这道题已经答过或又问了一次，请查看最新问题后重新答复");
  }
  const answers = input.answers;
  if (answers !== undefined && (!Array.isArray(answers)
    || answers.length !== questionItems(source).length
    || answers.some((value) => typeof value !== "string")
    || !answers.some((value) => value.trim()))) {
    throw new TypeError("请至少回答一项，并保留每项答案的位置");
  }
  const text = answers ? formatQuestionAnswers(answers) : answer.trim();
  if (!text) throw new TypeError("answer 不能为空");
  // 对着一张派活单回的话（网页上的「发回去改」、手机或飞书里直接回一句）：一条任务都没建，先跟智能体说清。
  const plan = activeDispatchPlan({ question: task.question, dispatchPlan: parseDispatchPlan(task.dispatchPlan) });
  return {
    ...source, id: nanoid(12), answeredAt: now(), answer: text,
    ...(answers ? { answers: answers.map((value) => value.trim()) } : {}),
    reply: `【答复】\n${plan ? `${DISPATCH_PLAN_RETURNED}\n` : ""}${text}`,
  };
}

/**
 * 整行条件写认领这一问。派出的任务的那一行提问记录（「答过了」、在派它的那条里答的那条答复，
 * dispatch-signals.ts）跟认领同一个事务：条件写命中才证明答的就是那一问。`via` 是答复者在哪条任务的
 * 页面里答的。
 */
export async function claimQuestionAnswer(task: TaskRow, record: QuestionRecord,
  onClaim?: (transaction: ConclusionTransaction) => Promise<void>, via?: string): Promise<boolean> {
  const claim = await db.transaction((transaction) => claimQuestionAnswerWithin(transaction, task, record, onClaim, via),
    { behavior: "immediate" });
  claim?.announce();
  return !!claim;
}

/** 认领到了：事务提交之后调 `announce` 通知派它的那条任务去重读。 */
export type QuestionClaim = { announce: () => void };

/**
 * 同上，但落在调用方的事务里：派活单「派出去」要让认领和建任务同一笔提交（dispatch-plan-launch.ts）。
 * 没认领到返回 null；认领到了，等外层事务提交之后再调返回值的 `announce`。
 */
export async function claimQuestionAnswerWithin(transaction: ConclusionTransaction, task: TaskRow, record: QuestionRecord,
  onClaim?: (transaction: ConclusionTransaction) => Promise<void>, via?: string): Promise<QuestionClaim | null> {
  const history: QuestionRecord[] = task.questionHistory ? JSON.parse(task.questionHistory) : [];
  const claimed = await transaction.update(tasks).set({
    question: null, questionOptions: null, questionItems: null, dispatchPlan: null,
    questionHistory: JSON.stringify([...history, record]), updatedAt: record.answeredAt,
  }).where(and(
    eq(tasks.id, task.id),
    eq(tasks.question, task.question!),
    task.questionOptions === null ? isNull(tasks.questionOptions) : eq(tasks.questionOptions, task.questionOptions),
    task.questionItems === null ? isNull(tasks.questionItems) : eq(tasks.questionItems, task.questionItems),
    task.questionHistory === null ? isNull(tasks.questionHistory) : eq(tasks.questionHistory, task.questionHistory),
    task.waitOwnership === null ? isNull(tasks.waitOwnership) : eq(tasks.waitOwnership, task.waitOwnership),
    task.mode === "team" ? undefined : eq(tasks.status, task.status),
  )).returning({ id: tasks.id });
  if (!claimed.length) return null;
  const announce = await markDispatchQuestionAnswered(transaction, task, record, via);
  await onClaim?.(transaction);
  return { announce: () => announceDispatchSignalsTo(announce) };
}

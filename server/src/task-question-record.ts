import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { formatQuestionAnswers, questionItems, questionKey } from "@navi/shared/questions";
import type { QuestionAnswerInput, QuestionRecord, QuestionSource } from "@navi/shared/questions";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import type { TaskRow } from "./task-store.js";
import { now } from "./util.js";
import type { ConclusionTransaction } from "./regression-conclusion-commit.js";
import { questionOccurrenceOf } from "./task-wait-ownership.js";
import type { StoredSuggestion } from "@navi/shared/dispatch-suggestion";
import { readSuggestions, sameColumns, serializedSuggestions, waitingBatchOf } from "./dispatch-suggestion.js";

/** 等着的那一批派活被发回来改时，答复最前面那一句（智能体据此知道一条都没建）。 */
export const DISPATCH_PLAN_RETURNED = "（这一批派活没有派出，一条任务都没建，已经从回复框顶上撤下。用户的意见如下，按它改完可以再摆一次。）";

/**
 * 那一批不再等了（用户回了一句话、或者发来别的消息顶掉了那一问）时，先跟智能体说清它们落到了哪：一件都没派是
 * `DISPATCH_PLAN_RETURNED`；用户已经从里面派出了几件，就写明建好了哪几条（别再建）、去掉了哪几条、剩下哪几条没派。
 * 建好的那几条只记在这一批上，这一批随即拿掉，这里不说就再也没人告诉它。没有等着的那一批给 null。
 */
export function waitingBatchReturned(task: TaskRow, after: string): string | null {
  const batch = waitingBatchOf(readSuggestions(task));
  if (!batch.length) return null;
  const created = batch.flatMap((item) => (item.settled?.task ? [item.settled.task] : []));
  if (!created.length) return DISPATCH_PLAN_RETURNED;
  const dropped = batch.filter((item) => item.settled && !item.settled.task).map((item) => `「${item.title}」`);
  const left = batch.filter((item) => !item.settled).map((item) => `「${item.title}」`);
  return [
    `（这一批派活里用户已经派出了 ${created.length} 个任务，挂在本任务名下、已交给调度，不要再建：`,
    ...created.map((task, index) => `${index + 1}. ${task.id}「${task.title}」`),
    ...(dropped.length ? [`用户去掉了：${dropped.join("、")}（没有建）`] : []),
    `剩下的${left.join("")}没有派出，已经从回复框顶上撤下。${after}）`,
  ].join("\n");
}

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
  // 对着等着的那一批派活回的话（「发回去改」、手机或飞书里直接回一句）：先跟智能体说清哪些建了、哪些没建。
  const plan = waitingBatchReturned(task, "用户的意见如下，按它改完剩下的可以再摆一次。");
  return {
    ...source, id: nanoid(12), answeredAt: now(), answer: text,
    ...(answers ? { answers: answers.map((value) => value.trim()) } : {}),
    reply: `【答复】\n${plan ? `${plan}\n` : ""}${text}`,
  };
}

/** 整行条件写认领这一问：条件写命中才证明答的就是那一问。 */
export async function claimQuestionAnswer(task: TaskRow, record: QuestionRecord,
  onClaim?: (transaction: ConclusionTransaction) => Promise<void>): Promise<boolean> {
  return db.transaction((transaction) => claimQuestionAnswerWithin(transaction, task, record, onClaim), { behavior: "immediate" });
}

/**
 * 同上，但落在调用方的事务里：等着的那一批派活处理完时，认领和建任务同一笔提交（dispatch-suggestion-resolve.ts）。
 *
 * 那一问绑着的那一批派活跟着这一问一起了结（同一条更新）：答复 = 发回去改，那一批从框顶撤下；处理完的那一路
 * 自己算好这一列的新值交进来（`suggestionsAfter`）。没有等着的那一批时这一列不碰。
 */
export async function claimQuestionAnswerWithin(transaction: ConclusionTransaction, task: TaskRow, record: QuestionRecord,
  onClaim?: (transaction: ConclusionTransaction) => Promise<void>, suggestionsAfter?: StoredSuggestion[]): Promise<boolean> {
  const history: QuestionRecord[] = task.questionHistory ? JSON.parse(task.questionHistory) : [];
  const current = readSuggestions(task);
  const after = suggestionsAfter ?? current.filter((item) => item.wait === "none");
  const touch = suggestionsAfter !== undefined || after.length !== current.length || task.dispatchPlan !== null;
  const claimed = await transaction.update(tasks).set({
    question: null, questionOptions: null, questionItems: null,
    ...(touch ? { dispatchSuggestions: serializedSuggestions(after), dispatchPlan: null } : {}),
    questionHistory: JSON.stringify([...history, record]), updatedAt: record.answeredAt,
  }).where(and(
    touch ? sameColumns(task) : undefined,
    eq(tasks.id, task.id),
    eq(tasks.question, task.question!),
    task.questionOptions === null ? isNull(tasks.questionOptions) : eq(tasks.questionOptions, task.questionOptions),
    task.questionItems === null ? isNull(tasks.questionItems) : eq(tasks.questionItems, task.questionItems),
    task.questionHistory === null ? isNull(tasks.questionHistory) : eq(tasks.questionHistory, task.questionHistory),
    task.waitOwnership === null ? isNull(tasks.waitOwnership) : eq(tasks.waitOwnership, task.waitOwnership),
    task.mode === "team" ? undefined : eq(tasks.status, task.status),
  )).returning({ id: tasks.id });
  if (!claimed.length) return false;
  await onClaim?.(transaction);
  return true;
}

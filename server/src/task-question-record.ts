import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { formatQuestionAnswers, questionItems, questionKey } from "@ash/shared/questions";
import type { QuestionAnswerInput, QuestionRecord, QuestionSource } from "@ash/shared/questions";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import type { TaskRow } from "./task-store.js";
import { now } from "./util.js";

export function prepareQuestionRecord(task: TaskRow, answer: string, input: QuestionAnswerInput): QuestionRecord {
  const source: QuestionSource = {
    question: task.question,
    questionOptions: task.questionOptions ? JSON.parse(task.questionOptions) : null,
    questionItems: task.questionItems ? JSON.parse(task.questionItems) : null,
  };
  if (input.questionKey !== undefined && input.questionKey !== questionKey(source)) {
    throw new Error("问题已更新，请查看最新问题后重新答复");
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
  return {
    ...source, id: nanoid(12), answeredAt: now(), answer: text,
    ...(answers ? { answers: answers.map((value) => value.trim()) } : {}),
    reply: `【答复】\n${text}`,
  };
}

export async function claimQuestionAnswer(task: TaskRow, record: QuestionRecord): Promise<boolean> {
  const history: QuestionRecord[] = task.questionHistory ? JSON.parse(task.questionHistory) : [];
  const claimed = await db.update(tasks).set({
    question: null, questionOptions: null, questionItems: null,
    questionHistory: JSON.stringify([...history, record]), updatedAt: record.answeredAt,
  }).where(and(
    eq(tasks.id, task.id),
    eq(tasks.question, task.question!),
    task.questionOptions === null ? isNull(tasks.questionOptions) : eq(tasks.questionOptions, task.questionOptions),
    task.questionItems === null ? isNull(tasks.questionItems) : eq(tasks.questionItems, task.questionItems),
    task.questionHistory === null ? isNull(tasks.questionHistory) : eq(tasks.questionHistory, task.questionHistory),
    task.mode === "team" ? undefined : eq(tasks.status, task.status),
  )).returning({ id: tasks.id });
  return claimed.length > 0;
}

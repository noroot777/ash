// 派出的任务来问 / 失败的那一刻（表与触发器见 db/schema-dispatch-signals.ts）：读、补原因、记「在这里答的」。
//
// 这些只给**派它的那条任务的页面**看：不进它的会话正文、不进它的上下文、不叫醒它、不改它的状态。
// 答复本身照旧走提问的那条任务自己的 /answer（task-answer.ts），送到的是提问的那条任务。
// 写入都在各自那一笔改动的事务里（答复：task-question-record.ts；失败原因：status.ts）。
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { DispatchSignal } from "@ash/shared";
import type { QuestionRecord } from "@ash/shared/questions";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { dispatchSignals } from "./db/schema-dispatch-signals.js";
import type { ConclusionTransaction as Transaction } from "./regression-conclusion-commit.js";

const parse = <T>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

type SignalRow = typeof dispatchSignals.$inferSelect;

function toSignal(row: SignalRow): DispatchSignal {
  return {
    seq: row.seq,
    taskId: row.taskId,
    kind: row.kind === "failed" ? "failed" : "question",
    at: row.occurredAt,
    ...(row.kind === "question" ? {
      question: row.question,
      questionOptions: parse<string[]>(row.questionOptions),
      questionItems: parse<DispatchSignal["questionItems"]>(row.questionItems),
      answered: !!row.answeredAt,
      answer: parse<QuestionRecord>(row.answer),
    } : { reason: row.reason }),
  };
}

/** 一条任务名下记下的那几刻，按发生先后。「答过没有」读那一行自己记下的答复时刻。 */
export async function listDispatchSignals(dispatcherId: string): Promise<DispatchSignal[]> {
  const rows = await db.select().from(dispatchSignals)
    .where(eq(dispatchSignals.dispatcherId, dispatcherId))
    .orderBy(asc(dispatchSignals.seq));
  return rows.map(toSignal);
}

/** 告诉开着派它的那条任务的页面：去重读一次。事件挂在派它的那条任务上，看得见那条任务的人才收得到。 */
export function announceDispatchSignalsTo(dispatcherId: string | null | undefined): void {
  if (dispatcherId) bus.publish({ type: "task.dispatchSignals", taskId: dispatcherId });
}

export async function announceDispatchSignals(taskId: string): Promise<void> {
  const row = (await db.select({ dispatchedBy: tasks.dispatchedBy }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  announceDispatchSignalsTo(row?.dispatchedBy);
}

const REASON_MAX = 600;

/**
 * 这一次失败的原因，写进触发器**在同一个事务里刚插入**的那一行（status.ts 落 failed 那一笔调它）。
 * 那一行的时刻就是这一笔写下的 updated_at（触发器取 NEW.updated_at），按它认，不按「最新一行」猜：
 * 续聊回到原来的失败、本来就是失败时触发器不记，这里也就什么都不写。
 */
export async function writeDispatchFailureReason(transaction: Transaction, taskId: string, occurredAt: string,
  reason: string | null | undefined): Promise<void> {
  const text = (reason ?? "").replace(/\s+/g, " ").trim().slice(0, REASON_MAX);
  if (!text) return;
  const row = (await transaction.select({ seq: dispatchSignals.seq }).from(dispatchSignals).where(and(
    eq(dispatchSignals.taskId, taskId), eq(dispatchSignals.kind, "failed"),
    eq(dispatchSignals.occurredAt, occurredAt), isNull(dispatchSignals.reason),
  )).orderBy(desc(dispatchSignals.seq)).limit(1)).at(0);
  if (row) await transaction.update(dispatchSignals).set({ reason: text }).where(eq(dispatchSignals.seq, row.seq));
}

/**
 * 这一问答复了：在 claimQuestionAnswer **那一笔整行条件写的同一个事务里**调。条件写命中就说明
 * 任务此刻挂着的正是答复者看到的那一问，而那一问一出现触发器就记了一行 —— 所以这条任务最近那一行
 * 提问就是它，并发改题、又问一次都插不进来。在派它的那条任务里答的（via 是它）再记下这条答复，
 * 那边的会话里留下「你」那颗气泡。升级之前就在问、没有那一行的，在派它的那条里答时按答复时刻补一行。
 * 返回该叫哪条任务的页面重读（事务提交之后再发）。
 */
export async function markDispatchQuestionAnswered(transaction: Transaction,
  task: { id: string; dispatchedBy: string | null; question: string | null; questionOptions: string | null; questionItems: string | null },
  record: QuestionRecord, via: string | undefined): Promise<string | null> {
  if (!task.dispatchedBy) return null;
  const fromDispatcher = !!via && via === task.dispatchedBy;
  const open = (await transaction.select({ seq: dispatchSignals.seq, answeredAt: dispatchSignals.answeredAt }).from(dispatchSignals)
    .where(and(eq(dispatchSignals.taskId, task.id), eq(dispatchSignals.kind, "question")))
    .orderBy(desc(dispatchSignals.seq)).limit(1)).at(0);
  if (open && !open.answeredAt) {
    await transaction.update(dispatchSignals).set({
      answeredAt: record.answeredAt, ...(fromDispatcher ? { answer: JSON.stringify(record) } : {}),
    }).where(eq(dispatchSignals.seq, open.seq));
  } else if (fromDispatcher) {
    await transaction.insert(dispatchSignals).values({
      dispatcherId: task.dispatchedBy, taskId: task.id, kind: "question", occurredAt: record.answeredAt,
      question: task.question, questionOptions: task.questionOptions, questionItems: task.questionItems,
      answeredAt: record.answeredAt, answer: JSON.stringify(record),
    });
  } else return null;
  return task.dispatchedBy;
}

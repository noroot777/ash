// 派出的任务来问 / 失败的那一刻（表与触发器见 db/schema-dispatch-signals.ts）：读、补原因、记「在这里答的」。
//
// 这些只给**派它的那条任务的页面**看：不进它的会话正文、不进它的上下文、不叫醒它、不改它的状态。
// 答复本身照旧走提问的那条任务自己的 /answer（task-answer.ts），送到的是提问的那条任务。
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { DispatchSignal } from "@ash/shared";
import type { QuestionRecord } from "@ash/shared/questions";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { dispatchSignals } from "./db/schema-dispatch-signals.js";

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
      answer: parse<QuestionRecord>(row.answer),
    } : { reason: row.reason }),
  };
}

/**
 * 一条任务名下记下的那几刻，按发生先后。每一问带上「后来答过没有」：在别处答的那边不记，所以按
 * 派出的那条任务自己的问答历史认 —— 提问之后、它下一次提问之前有一条答复，就是答过了。
 */
export async function listDispatchSignals(dispatcherId: string): Promise<DispatchSignal[]> {
  const rows = await db.select().from(dispatchSignals)
    .where(eq(dispatchSignals.dispatcherId, dispatcherId))
    .orderBy(asc(dispatchSignals.seq));
  const asked = [...new Set(rows.filter((row) => row.kind === "question").map((row) => row.taskId))];
  const histories = new Map((asked.length
    ? await db.select({ id: tasks.id, history: tasks.questionHistory }).from(tasks).where(inArray(tasks.id, asked))
    : []).map((row) => [row.id, (parse<QuestionRecord[]>(row.history) ?? []).map((record) => record.answeredAt)] as const));
  return rows.map((row, index) => {
    const signal = toSignal(row);
    if (signal.kind !== "question") return signal;
    const next = rows.slice(index + 1).find((later) => later.taskId === row.taskId && later.kind === "question")?.occurredAt;
    const answered = !!signal.answer || (histories.get(row.taskId) ?? [])
      .some((at) => at >= row.occurredAt && (!next || at < next));
    return { ...signal, answered };
  });
}

/** 告诉开着派它的那条任务的页面：去重读一次。 */
export async function announceDispatchSignals(taskId: string): Promise<void> {
  const row = (await db.select({ dispatchedBy: tasks.dispatchedBy }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (row?.dispatchedBy) bus.publish({ type: "task.dispatchSignals", dispatcherId: row.dispatchedBy });
}

const REASON_MAX = 600;

/**
 * 结算之后补上这一次失败的原因（触发器只知道「落成了 failed」，不知道为什么）。只补最近那一行、
 * 而且只补还空着的：原因是那一刻的事，后来的结算不改它。
 */
export async function noteDispatchFailureReason(taskId: string, reason: string | null | undefined): Promise<void> {
  const text = (reason ?? "").replace(/\s+/g, " ").trim().slice(0, REASON_MAX);
  const latest = (await db.select({ seq: dispatchSignals.seq, reason: dispatchSignals.reason }).from(dispatchSignals)
    .where(and(eq(dispatchSignals.taskId, taskId), eq(dispatchSignals.kind, "failed")))
    .orderBy(desc(dispatchSignals.seq)).limit(1)).at(0);
  if (!latest) return;
  if (text && !latest.reason) await db.update(dispatchSignals).set({ reason: text }).where(eq(dispatchSignals.seq, latest.seq));
  await announceDispatchSignals(taskId);
}

/**
 * 这一题是在派它的那条任务里答的：记在那一次提问上，那边的会话里留下「你」那颗气泡和一句小灰字。
 * 升级之前就在问的那一题没有那一行（触发器还没装），就按答复的时刻补一行。
 */
export async function noteAnsweredFromDispatcher(
  task: { id: string; dispatchedBy: string | null; question: string | null; questionOptions: string | null; questionItems: string | null },
  record: QuestionRecord,
): Promise<void> {
  if (!task.dispatchedBy) return;
  const open = (await db.select({ seq: dispatchSignals.seq, answer: dispatchSignals.answer }).from(dispatchSignals)
    .where(and(eq(dispatchSignals.taskId, task.id), eq(dispatchSignals.kind, "question")))
    .orderBy(desc(dispatchSignals.seq)).limit(1)).at(0);
  if (open && !open.answer) {
    await db.update(dispatchSignals).set({ answer: JSON.stringify(record) }).where(eq(dispatchSignals.seq, open.seq));
  } else {
    await db.insert(dispatchSignals).values({
      dispatcherId: task.dispatchedBy, taskId: task.id, kind: "question", occurredAt: record.answeredAt,
      question: task.question, questionOptions: task.questionOptions, questionItems: task.questionItems,
      answer: JSON.stringify(record),
    });
  }
  bus.publish({ type: "task.dispatchSignals", dispatcherId: task.dispatchedBy });
}

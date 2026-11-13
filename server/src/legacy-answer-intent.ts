// 旧版 /answer 落下的执行型答复里,认出那些**其实是续聊**的,把身份写回那一行(开机调一次)。
//
// 来历:续聊回合以提问结束时任务保持原终态(settle-status.ts 续聊那一支),它的答复是又一个续聊
// 回合;旧版 /answer 却一律去认领队列占位,同队有人在跑就把答复暂存成 execution=1 —— 于是它要等
// 整条队列跑完(2026-11-13 现场)。新版 /answer 不再落这种行(task-answer.ts),库里已有的由这里还原。
//
// 身份只认一次、写进行里:此后扫描、托盘、推卡都只读这一行的 `execution`,不再各自按任务此刻的
// 状态或时间去推。判据是「这道题是在哪种回合里问的」,两条证据任一成立即为续聊:
//
// ① 提问那一轮结算时落进会话的说明(question-settle-notes.ts)。取答复排下之前**最近的那一句**
//   提问说明:是「续聊回合以提问结束」且问的正是这道题,就是续聊。这是提问那一轮自己的持久记录,
//   之后又聊了几轮、开机时正有一轮续聊在跑,都改不了它。
// ② 排下这条答复时任务已经是终态:`createdAt` **严格晚于** `endedAt`。只在任务此刻仍是终态时
//   可用,而且之后每一轮续聊都会重写 `endedAt` —— 所以它只是会话记录读不到时的补充。同一毫秒
//   不算:执行回合里问的题,答复排下后起跑失败落 failed,`endedAt` 至多与排下时刻相同,那一行要
//   继续守队列与分组暂停(pending-verdict.ts `deliveryVerdict` 执行型那一支)。
//
// 两条都不成立就原样留着执行型:错放的代价是同队并跑、穿透分组暂停,错留的代价只是多等一会儿。
import { readFile } from "node:fs/promises";
import { and, eq, isNotNull } from "drizzle-orm";
import type { QuestionRecord } from "@ash/shared/questions";
import { db } from "./db/index.js";
import { scheduledMessages, sessions, tasks } from "./db/schema.js";
import { FOLLOW_UP_QUESTION_HEAD, PAUSED_QUESTION_HEAD } from "./question-settle-notes.js";
import { readableRunPath, sessionTranscriptPath, TURN_SENTINEL } from "./transcript.js";

type QuestionNote = { at: string; followUp: boolean; text: string };

async function questionNotes(taskId: string): Promise<QuestionNote[]> {
  const rows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.taskId, taskId));
  const notes: QuestionNote[] = [];
  for (const { id } of rows) {
    const content = await readFile(readableRunPath(sessionTranscriptPath(taskId, id)), "utf8").catch(() => "");
    for (const line of content.split("\n")) {
      if (!line.startsWith(TURN_SENTINEL)) continue;
      let turn: { t?: string; text?: unknown; at?: unknown };
      try { turn = JSON.parse(line.slice(TURN_SENTINEL.length)); } catch { continue; }
      if (turn.t !== "system" || typeof turn.text !== "string" || typeof turn.at !== "string") continue;
      const followUp = turn.text.startsWith(FOLLOW_UP_QUESTION_HEAD);
      if (followUp || turn.text.startsWith(PAUSED_QUESTION_HEAD)) notes.push({ at: turn.at, followUp, text: turn.text });
    }
  }
  return notes.sort((a, b) => a.at.localeCompare(b.at));
}

/** 判据 ①:答复排下之前最近的那一句提问说明,是不是续聊回合问的这道题。 */
export function askedInFollowUp(notes: readonly QuestionNote[], createdAt: string, question: string | null): boolean {
  const last = notes.filter((note) => note.at <= createdAt).at(-1);
  return !!last?.followUp && (question === null || last.text.includes(`「${question}」`));
}

export async function restoreFollowUpAnswers(): Promise<number> {
  const rows = await db.select().from(scheduledMessages).where(and(
    eq(scheduledMessages.status, "pending"), eq(scheduledMessages.execution, true), isNotNull(scheduledMessages.answerId),
  ));
  let restored = 0;
  for (const m of rows) {
    const t = (await db.select().from(tasks).where(eq(tasks.id, m.taskId))).at(0);
    if (!t || t.mode !== "single") continue;
    const terminal = t.status === "done" || t.status === "failed" || t.status === "canceled";
    const answered = (JSON.parse(t.questionHistory ?? "[]") as QuestionRecord[]).find((record) => record.id === m.answerId);
    const followUp = (terminal && !!t.endedAt && m.createdAt > t.endedAt)
      || askedInFollowUp(await questionNotes(t.id), m.createdAt, answered?.question || null);
    if (!followUp) continue;
    const updated = await db.update(scheduledMessages).set({ execution: false }).where(and(
      eq(scheduledMessages.id, m.id), eq(scheduledMessages.status, "pending"), eq(scheduledMessages.execution, true),
    )).returning({ id: scheduledMessages.id });
    restored += updated.length;
  }
  if (restored) console.log(`[ash] ${restored} 条终态任务上的提问答复还原成续聊`);
  return restored;
}

// 旧版 /answer 落下的执行型答复里,认出那些**其实是续聊**的,把身份写回那一行(开机调一次)。
//
// 来历:续聊回合以提问结束时任务保持原终态(settle-status.ts 续聊那一支),它的答复是又一个续聊
// 回合;旧版 /answer 却一律去认领队列占位,同队有人在跑就把答复暂存成 execution=1 —— 于是它要等
// 整条队列跑完(2026-11-13 现场)。新版 /answer 不再落这种行(task-answer.ts),库里已有的由这里还原。
//
// 身份只认一次、写进行里:此后扫描、托盘、推卡都只读这一行的 `execution`,不再各自按任务此刻的
// 状态或时间去推。判据是「这道题是在哪种回合里问的」,两条证据任一成立即为续聊:
//
// ① 提问那一轮结算时落进会话的说明(question-settle-notes.ts)。这是提问那一轮自己的持久记录,
//   之后又聊了几轮、开机时正有一轮续聊在跑,都改不了它。但「读得到的最近一句」不等于「这条答复
//   所属的那一句」:较新的会话文件丢了、坏了,剩下的就是更早一次、可能同题面的续聊提问。所以说明
//   要先**绑到回合上**:回合区间(session_turns,库里每一回合开跑即落行)里,排下答复之前开跑的
//   最后一回合,就是问这道题的那一回合 —— 它得已经收口,它那份会话里收口时刻那一句说明得正是
//   「续聊回合以提问结束」、题面正是 questionHistory 里这条答复对应的那道题。哪一步拿不准(那一
//   回合没收口、会话读不到、有坏行、没有说明、答复对不上记录)都不算证据。
// ② 排下这条答复时任务已经是终态:`createdAt` **严格晚于** `endedAt`。终态才盖 `endedAt`、开跑就
//   清掉(status.ts),所以排下时还没到终态的,`endedAt` 只会落在排下之后。之后每一轮续聊都会重写
//   `endedAt`,它只能证明「是」、不能证明「不是」。同一毫秒不算:执行回合里问的题,答复排下后起跑
//   失败落 failed,`endedAt` 至多与排下时刻相同,那一行要继续守队列与分组暂停(pending-verdict.ts
//   `deliveryVerdict` 执行型那一支)。
//
// 两条都不成立就原样留着执行型:错放的代价是同队并跑、穿透分组暂停,错留的代价只是多等一会儿。
import { readFile } from "node:fs/promises";
import { and, desc, eq, isNotNull, lte } from "drizzle-orm";
import type { QuestionRecord } from "@ash/shared/questions";
import { db } from "./db/index.js";
import { scheduledMessages, sessionTurns, tasks } from "./db/schema.js";
import { FOLLOW_UP_QUESTION_HEAD, PAUSED_QUESTION_HEAD } from "./question-settle-notes.js";
import { readableRunPath, sessionTranscriptPath, TURN_SENTINEL } from "./transcript.js";

type QuestionNote = { at: string; followUp: boolean; text: string };

/** 一份会话里的提问结算说明;读不到或有解析不了的回合行 → null(拿不准,不是「没有」)。 */
export async function questionNotesIn(taskId: string, sessionId: string): Promise<QuestionNote[] | null> {
  let content: string;
  try { content = await readFile(readableRunPath(sessionTranscriptPath(taskId, sessionId)), "utf8"); } catch { return null; }
  const notes: QuestionNote[] = [];
  for (const line of content.split("\n")) {
    if (!line.startsWith(TURN_SENTINEL)) continue;
    let turn: { t?: unknown; text?: unknown; at?: unknown };
    try { turn = JSON.parse(line.slice(TURN_SENTINEL.length)); } catch { return null; }
    if (turn.t !== "system" || typeof turn.text !== "string") continue;
    const followUp = turn.text.startsWith(FOLLOW_UP_QUESTION_HEAD);
    if (!followUp && !turn.text.startsWith(PAUSED_QUESTION_HEAD)) continue;
    if (typeof turn.at !== "string") return null;
    notes.push({ at: turn.at, followUp, text: turn.text });
  }
  return notes;
}

/** 那一回合收口时刻的说明,是不是「续聊回合以提问结束」问的正是这道题(题面整段比对,不是包含)。 */
export function settledAsFollowUpQuestion(notes: readonly QuestionNote[], endedAt: string, question: string): boolean {
  const own = notes.filter((note) => note.at === endedAt);
  return own.length === 1 && own[0]!.followUp
    && own[0]!.text.startsWith(`${FOLLOW_UP_QUESTION_HEAD}「${question}」(任务状态仍为「`);
}

/** 判据 ①:答复排下之前开跑的最后一回合,是不是以续聊提问这道题收口的。 */
async function askedInFollowUp(taskId: string, createdAt: string, question: string): Promise<boolean> {
  const last = (await db.select().from(sessionTurns)
    .where(and(eq(sessionTurns.taskId, taskId), lte(sessionTurns.startedAt, createdAt)))
    .orderBy(desc(sessionTurns.startedAt)).limit(2));
  const turn = last[0];
  // 两回合同一刻开跑分不出先后;没收口、收口在排下之后,都说明问这道题的不是它。
  if (!turn?.endedAt || turn.endedAt > createdAt || last[1]?.startedAt === turn.startedAt) return false;
  const notes = await questionNotesIn(taskId, turn.sessionId);
  return !!notes && settledAsFollowUpQuestion(notes, turn.endedAt, question);
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
    // 对不上这条答复的提问记录,判据 ① 就没有题面可核,只剩 ②。
    const asked = (JSON.parse(t.questionHistory ?? "[]") as QuestionRecord[]).find((record) => record.id === m.answerId)?.question;
    const followUp = (terminal && !!t.endedAt && m.createdAt > t.endedAt)
      || (!!asked && await askedInFollowUp(t.id, m.createdAt, asked));
    if (!followUp) continue;
    const updated = await db.update(scheduledMessages).set({ execution: false }).where(and(
      eq(scheduledMessages.id, m.id), eq(scheduledMessages.status, "pending"), eq(scheduledMessages.execution, true),
    )).returning({ id: scheduledMessages.id });
    restored += updated.length;
  }
  if (restored) console.log(`[ash] ${restored} 条终态任务上的提问答复还原成续聊`);
  return restored;
}

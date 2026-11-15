// 「几方交替说几段」的底子：审查意见辩论（free-review-debate.ts）和讨论（discussion.ts）共用这一份。
//
// 一场 = 若干段**交替的旁路回合**，落在 free_review_debates / free_review_debate_turns（按 kind 分开）：
//   开一段 → 那一方的回合跑起来 → 它用 `debate_reply` 交卷（正文 + 一句写给用户的摘要）
//   → 回合结算时由这一场自己决定「换人说 / 收尾 / 中止」。
//
// 三条硬规矩，两种都适用，改这块时别绕过去：
// ① **只说话，不改代码**。每一段都是 sideTurn（任务终态、验收阶段原样不动），提示词里明说不许碰
//    工作区——一边说一边改，下一段的人看到的就是另一版代码了。
// ② **发言只认交卷，不认输出文本**。输出里混着思考、工具调用和寒暄，猜不出哪段是正式发言；交卷还
//    回答了「这一段到底说没说话」——回合崩在半路时两者天差地别。
// ③ **推进只在结算里做**。交卷那一刻回合还占着单飞锁，此时去起下一段只会被静默挡回（runs.ts
//    continueWhenIdle 的由来）。所以交卷只落库，结算（`settleSegment`）才决定下一步。
//
// 这里只放两种都一样的那几步（读、开段、交卷落库、结算的三岔路、中止、对账）；谁在第几段说话、
// 提示词怎么写、说完了怎么收尾，各归各的文件。
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { freeReviewDebateTurns, freeReviewDebates, tasks } from "../db/schema.js";
import { isTurnClaimed } from "../runs.js";
import { id, now } from "../util.js";

export type TalkRow = typeof freeReviewDebates.$inferSelect;
export type TalkTurnRow = typeof freeReviewDebateTurns.$inferSelect;
export type TalkKind = "review" | "discussion";

/** 一段发言的长度上限；够写满一页逐条对质。 */
export const MAX_SEGMENT_STATEMENT_LEN = 20_000;

/** 这个任务身上正在进行的那一场（这一种）。`statuses` 默认只认还在说的。 */
export async function activeTalkOf(
  taskId: string,
  kind: TalkKind,
  statuses: readonly string[] = ["running"],
): Promise<TalkRow | null> {
  return (await db.select().from(freeReviewDebates).where(and(
    eq(freeReviewDebates.taskId, taskId),
    eq(freeReviewDebates.kind, kind),
    inArray(freeReviewDebates.status, [...statuses]),
  ))).at(0) ?? null;
}

export async function talkTurnsOf(talkId: string): Promise<TalkTurnRow[]> {
  return db.select().from(freeReviewDebateTurns)
    .where(eq(freeReviewDebateTurns.debateId, talkId))
    .orderBy(asc(freeReviewDebateTurns.seq));
}

/** 这一场此刻该说的那一段（`currentSeq`）。 */
export async function speakingTurnOf(talk: TalkRow): Promise<TalkTurnRow | null> {
  return (await db.select().from(freeReviewDebateTurns).where(and(
    eq(freeReviewDebateTurns.debateId, talk.id),
    eq(freeReviewDebateTurns.seq, talk.currentSeq),
  ))).at(0) ?? null;
}

/** 排上第 seq 段（轮到 side 说），并把这一场的指针挪过去。 */
export async function openSegment(talk: TalkRow, seq: number, side: string): Promise<TalkTurnRow> {
  const at = now();
  const turn: typeof freeReviewDebateTurns.$inferInsert = {
    id: id(), debateId: talk.id, seq, side, statement: null, status: "speaking", startedAt: at, endedAt: null,
  };
  await db.insert(freeReviewDebateTurns).values(turn);
  if (talk.currentSeq !== seq) {
    await db.update(freeReviewDebates).set({ currentSeq: seq, updatedAt: at })
      .where(eq(freeReviewDebates.id, talk.id));
  }
  return { summary: null, agreed: null, ...turn } as TalkTurnRow;
}

/** 交卷的正文：去掉首尾空白，空的不收（报错说清该写进哪一格）。 */
export function statementOf(raw: unknown): string {
  const statement = typeof raw === "string" ? raw.trim() : "";
  if (!statement) throw new Error("发言不能为空：把你这一段的意见写进 statement");
  return statement.slice(0, MAX_SEGMENT_STATEMENT_LEN);
}

/**
 * 交卷落库：只在这一段还是「正在说」时写（并发交两次、回合结束后补交，都只认第一次）。
 * 返回 false = 这一段已经交过了。
 */
export async function commitSegment(
  turn: TalkTurnRow,
  input: { summary: string; statement: string; agreed?: boolean | null },
): Promise<boolean> {
  const written = await db.update(freeReviewDebateTurns)
    .set({
      summary: input.summary,
      statement: input.statement,
      ...(input.agreed === undefined ? {} : { agreed: input.agreed }),
      status: "done",
      endedAt: now(),
    })
    .where(and(eq(freeReviewDebateTurns.id, turn.id), eq(freeReviewDebateTurns.status, "speaking")))
    .returning({ id: freeReviewDebateTurns.id });
  return written.length > 0;
}

/** 中止这一场：正在说的那段记成没说完，这一场记成断了。`patch` 是各自要一起写下的东西（断在哪的那句话）。 */
export async function failTalk(
  talk: TalkRow,
  turn: TalkTurnRow | null,
  patch: Partial<typeof freeReviewDebates.$inferInsert> = {},
): Promise<void> {
  const at = now();
  if (turn && turn.status === "speaking") {
    await db.update(freeReviewDebateTurns).set({ status: "error", endedAt: at })
      .where(eq(freeReviewDebateTurns.id, turn.id));
  }
  await db.update(freeReviewDebates).set({ ...patch, status: "failed", updatedAt: at, finishedAt: at })
    .where(eq(freeReviewDebates.id, talk.id));
}

/**
 * 一段回合结束时落在哪条岔路上：
 * - `missing`：找不到正在说的那一段（指针坏了）；
 * - `stopped`：回合没干净收尾（崩了 / 被按停）——即便发言已经落库，「按了停止」的意思也不是「接着让
 *   下一位说」；
 * - `silent`：回合结束了却没交卷；
 * - `said`：好好说完了，由各自决定下一段 / 收尾。
 */
export type SegmentEnding =
  | { kind: "missing" }
  | { kind: "stopped" | "silent" | "said"; turn: TalkTurnRow };

export async function segmentEnding(talk: TalkRow, turnOk: boolean): Promise<SegmentEnding> {
  const turn = await speakingTurnOf(talk);
  if (!turn) return { kind: "missing" };
  if (!turnOk) return { kind: "stopped", turn };
  if (turn.status !== "done" || !turn.statement) return { kind: "silent", turn };
  return { kind: "said", turn };
}

/**
 * 启动对账要问的那一句：这一场还有没有回合在替它跑。`running`（还有 synthesizing）是持久状态，而推进
 * 它的投递链只活在内存里——进程死在两段之间，这一场会永远挂着，后面的操作被一路 409 挡住。
 *
 * 判据同审查对账：回合还活着（任务在跑 / turn 被占 / 在等答复）就不碰，让它自己收尾。返回 null =
 * 任务都没了，这一场连同各段一起删掉。
 */
export async function talkOrphaned(talk: TalkRow): Promise<boolean | null> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, talk.taskId))).at(0);
  if (!task) {
    await db.delete(freeReviewDebateTurns).where(eq(freeReviewDebateTurns.debateId, talk.id));
    await db.delete(freeReviewDebates).where(eq(freeReviewDebates.id, talk.id));
    return null;
  }
  if (task.status === "running" || task.status === "queued" || isTurnClaimed(task.id)) return false;
  if (task.question || task.resumePrompt) return false;
  return true;
}

/** 这一种里所有还挂着的（启动对账用）。 */
export async function hangingTalks(kind: TalkKind, statuses: readonly string[]): Promise<TalkRow[]> {
  return db.select().from(freeReviewDebates).where(and(
    eq(freeReviewDebates.kind, kind),
    inArray(freeReviewDebates.status, [...statuses]),
  ));
}

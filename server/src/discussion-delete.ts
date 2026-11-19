// 删掉一整场讨论（会话里你发起时写的那一句 + 那颗讨论气泡 + 合稿），并保证之后的回合里没有哪个 agent 读得到它。
//
// 一场讨论散在四处，删除要四处都清：
//  ① 讨论记录本身：题目、各段发言（free_review_debates / _turns 里 kind=discussion 那一行和它的各段）。
//  ② 各会话的 .md 与 trace：每一段、合稿都是这条任务上的一个旁路回合，提示词和回复落在说话那一方自己的会话里；
//     开始 / 轮到谁 / 结束那几句旁注带着讨论身份。就地换成墓碑，做法与删一条消息相同（conversation-redact.ts）。
//  ③ 讨论自己的目录（runs/<任务>/discussions/<讨论>/：发起时截下的背景副本、各段之前的发言记录）；之后开的讨论
//     截下的背景副本里也有这一场，跟着抹（discussion-background.ts `syncBackgroundCopies`）。
//  ④ 各方 CLI 自己的会话文件里都记着这一场：给这条任务每一条持有 CLI 会话的会话行挂上「下一轮重建上下文」。
//
// 哪些段归这一场：讨论期间这条任务的回合全归它（discussion.ts 文件头），所以起止之间起跑的回合就是它的各段与合稿。
// 旁注只认写明了是这一场的那几句（开始 / 轮到谁 / 结束 / 中止，合稿没写完的提醒）：哨兵起停、预约审查这类别的
// 事的旁注会借着正在写的那条会话落盘、带上讨论回合的身份，时刻也落在起止之间，但它们不是讨论的。
//
// 顺序同删消息：先挂重建标记，再抹盘上的（先副本、再 trace、最后正文），讨论记录最后删。哪一步断了，界面上那一场
// 都还在，删除入口还在，重试按同样的判据再来一遍（已经抹掉的段不会再算一次）。
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { parseSessionSpans, segmentFingerprint, type ConvSeg } from "@navi/shared/session-output";
import { and, eq, isNotNull } from "drizzle-orm";
import { bus } from "./bus.js";
import { RedactRefusal, redactTraceWhere, redactTranscript } from "./conversation-redact.js";
import { db } from "./db/index.js";
import { freeReviewDebates, freeReviewDebateTurns, sessions, tasks } from "./db/schema.js";
import { backgroundCopiesOf, dirOf, syncBackgroundCopies } from "./discussion-background.js";
import { replaceFileAtomically, withRunFileLock } from "./run-file-lock.js";
import { claimNonTurn, isRunning } from "./runs.js";
import { sessionTracePath, sessionTranscriptPath } from "./transcript.js";
import { now } from "./util.js";

type Span = { from: number; to: number };

const within = (at: string | null | undefined, span: Span): boolean => {
  const time = at ? Date.parse(at) : Number.NaN;
  return time >= span.from && time <= span.to;
};

/** 纯函数：正文里这一段归不归这一场讨论。已经删掉的不算。 */
export function segmentOfDiscussion(seg: ConvSeg, discussionId: string, span: Span): boolean {
  if (seg.deleted) return false;
  if (seg.kind === "system" && seg.aside) {
    return (seg.notice?.kind === "discussion" || seg.notice?.kind === "alert") && seg.notice.discussionId === discussionId;
  }
  return within(seg.turnStartedAt, span);
}

export async function deleteDiscussion(taskId: string, discussionId: string): Promise<{ deleted: true }> {
  const talk = (await db.select().from(freeReviewDebates).where(and(
    eq(freeReviewDebates.id, discussionId), eq(freeReviewDebates.taskId, taskId), eq(freeReviewDebates.kind, "discussion"),
  ))).at(0);
  if (!talk) throw new RedactRefusal("这场讨论不存在，可能已经删掉了", 404);
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) throw new RedactRefusal("任务不存在", 404);
  if (talk.status === "running" || talk.status === "synthesizing") throw new RedactRefusal("讨论还在进行，说完再删", 409);
  const busy = "智能体正在运行，请先停止再删除讨论";
  if (task.status === "running" || task.status === "queued" || isRunning(taskId)) throw new RedactRefusal(busy, 409);
  const release = claimNonTurn(taskId, "discussion-delete");
  if (!release) throw new RedactRefusal(busy, 409);
  const touched: string[] = [];
  try {
    const span = { from: Date.parse(talk.startedAt), to: Date.parse(talk.finishedAt ?? talk.updatedAt) };
    const rows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.taskId, taskId));
    const copies = new Map<string, string[]>();
    for (const row of rows) copies.set(row.id, await backgroundCopiesOf(taskId, row.id, discussionId));
    // ④ 先挂上：反过来的话，抹完正文、这一笔没写成，下一轮就照旧接回那条还记得整场讨论的 CLI 会话。
    await db.update(sessions).set({ contextRebuildAt: now() })
      .where(and(eq(sessions.taskId, taskId), isNotNull(sessions.cliSessionId)));
    for (const row of rows) {
      const mdPath = sessionTranscriptPath(taskId, row.id);
      const tracePath = sessionTracePath(taskId, row.id);
      const changed = await withRunFileLock([mdPath, tracePath], () => {
        const raw = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : null;
        const traceRaw = existsSync(tracePath) ? readFileSync(tracePath, "utf8") : null;
        const targets = raw === null ? [] : parseSessionSpans(raw).flatMap((item, index) =>
          segmentOfDiscussion(item.seg, discussionId, span) ? [{ index, fingerprint: segmentFingerprint(item.seg) }] : []);
        const text = raw !== null && targets.length ? redactTranscript(raw, targets).text : raw;
        const traceNext = traceRaw === null ? null
          : redactTraceWhere(traceRaw, (entry) => within(entry.turnStartedAt ?? entry.at, span));
        if (text !== null && text !== raw) syncBackgroundCopies(copies.get(row.id) ?? [], text);
        if (traceNext !== null && traceNext !== traceRaw) replaceFileAtomically(tracePath, traceNext);
        if (text !== null && text !== raw) replaceFileAtomically(mdPath, text);
        return text !== raw || traceNext !== traceRaw;
      }).catch((error) => {
        if (error instanceof RedactRefusal) throw error;
        console.warn(`[navi] 删除讨论写盘失败 task=${taskId} session=${row.id}:`, error);
        throw new RedactRefusal(`删除没有完成，讨论还在，可以重试（${error instanceof Error ? error.message : String(error)}）`, 500);
      });
      if (changed) touched.push(row.id);
    }
    await rm(dirOf(taskId, discussionId), { recursive: true, force: true });
    await db.delete(freeReviewDebateTurns).where(eq(freeReviewDebateTurns.debateId, discussionId));
    await db.delete(freeReviewDebates).where(eq(freeReviewDebates.id, discussionId));
  } finally {
    release();
    for (const sessionId of touched) bus.publish({ type: "conversation.redacted", taskId, sessionId });
  }
  bus.publish({ type: "task.review", taskId });
  return { deleted: true };
}

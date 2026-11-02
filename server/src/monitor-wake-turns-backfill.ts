// 哨兵唤醒轮数的历史回填:`session_turns.monitor_wake` 和 `sessions.usage_monitor_wake_turns`。
//
// 这两列是后加的:加之前开过的回合在库里一律是 0,于是老任务的「N 轮,其中哨兵唤醒 M 轮」
// 只会说 M=0。事实其实早就落过盘,而且两样都能按**回合身份**对上:
//  · 哪几轮是唤醒 —— 每次唤醒都在会话转录里留了一条带 `monitorWake` 的用户回合
//    (`conversation-turn.ts`),它的时刻就是这一轮的身份(单飞回合开头按 `turnStart` 写它);
//  · 哪几轮报过账 —— trace 里每条 usage 事件都带着它所属回合的 `turnStartedAt`,跟实时入账
//    (`usage.ts` 按回合身份判唤醒)是同一个键。
// 所以 M 只数「是唤醒、且 trace 里确有用量」的那几笔,跟 N 是同一批回合。对不上的不猜:回合行
// 没了、时刻不是同一个,宁可少记。
//
// **幂等靠回合行上那一位**:只处理 `monitor_wake` 还是 0 的唤醒回合,置 1 和加计数同一个事务。
// 实时入账的唤醒回合开回合时就是 1,不会被这里再加一遍;重跑也只补还没补过的。
//
// **完成标记只在每份证据都有了终局时才写**:文件确实不存在 = 没有证据,算处理完;其余读错
// (权限、I/O、路径类型)只说明这次没读到,那条会话留到下次启动再试。
import { readFile } from "node:fs/promises";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db/index.js";
import { appSettings, sessions, sessionTurns } from "./db/schema.js";
import { parseSessionTrace, readableRunPath, sessionTracePath, sessionTranscriptPath, TURN_SENTINEL } from "./transcript.js";

const BACKFILL_KEY = "internal.monitor-wake-turns-backfill-v2";

/** 一份转录里所有哨兵唤醒回合的时刻。判据跟写端 `isMonitorWakeTurn` 落转录的条件同一份。 */
export function monitorWakeTurnStarts(transcript: string): string[] {
  const starts: string[] = [];
  for (const line of transcript.split("\n")) {
    if (!line.startsWith(TURN_SENTINEL) || !line.includes("\"monitorWake\"")) continue;
    try {
      const turn = JSON.parse(line.slice(TURN_SENTINEL.length)) as { t?: string; by?: string; monitorWake?: unknown; at?: unknown };
      if (turn.t === "user" && turn.by === "system" && turn.monitorWake && typeof turn.at === "string") starts.push(turn.at);
    } catch {
      /* 半截的行(写到一半崩了)不算 */
    }
  }
  return starts;
}

/** 读一份 run 产物:`missing` = 确实不存在(终局),`unreadable` = 这次没读到(下次再试)。 */
async function readEvidence(path: string): Promise<string | "missing" | "unreadable"> {
  try {
    return await readFile(readableRunPath(path), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
}

export async function backfillMonitorWakeTurns(): Promise<{
  alreadyApplied: boolean;
  sessions: number;
  turns: number;
  /** 这次没读到、留给下次启动的会话数。非 0 时不写完成标记。 */
  retry: number;
}> {
  const marker = await db.select({ value: appSettings.value }).from(appSettings)
    .where(eq(appSettings.key, BACKFILL_KEY)).get();
  if (marker) return { alreadyApplied: true, sessions: 0, turns: 0, retry: 0 };

  const owners = await db.selectDistinct({ sessionId: sessionTurns.sessionId, taskId: sessionTurns.taskId })
    .from(sessionTurns);
  let sessionsTouched = 0;
  let turns = 0;
  let retry = 0;
  for (const { sessionId, taskId } of owners) {
    const transcript = await readEvidence(sessionTranscriptPath(taskId, sessionId));
    if (transcript === "unreadable") { retry += 1; continue; }
    if (transcript === "missing") continue;
    const starts = monitorWakeTurnStarts(transcript);
    if (!starts.length) continue;
    // trace 不存在 = 这条会话没有任何用量证据:唤醒照记,计数加 0。读不动就整条留到下次。
    const trace = await readEvidence(sessionTracePath(taskId, sessionId));
    if (trace === "unreadable") { retry += 1; continue; }
    const usageByTurn = new Map<string, number>();
    if (trace !== "missing") {
      for (const entry of parseSessionTrace(trace)) {
        if (entry.event.kind === "usage") usageByTurn.set(entry.turnStartedAt, (usageByTurn.get(entry.turnStartedAt) ?? 0) + 1);
      }
    }
    const booked = await db.transaction(async (tx) => {
      const fresh = (await tx.select({ startedAt: sessionTurns.startedAt }).from(sessionTurns).where(and(
        eq(sessionTurns.sessionId, sessionId),
        eq(sessionTurns.monitorWake, false),
        inArray(sessionTurns.startedAt, starts),
      ))).map((row) => row.startedAt);
      if (!fresh.length) return null;
      await tx.update(sessionTurns).set({ monitorWake: true }).where(and(
        eq(sessionTurns.sessionId, sessionId),
        inArray(sessionTurns.startedAt, fresh),
      ));
      const count = fresh.reduce((sum, startedAt) => sum + (usageByTurn.get(startedAt) ?? 0), 0);
      if (count > 0) {
        await tx.update(sessions)
          .set({ usageMonitorWakeTurns: sql`COALESCE(${sessions.usageMonitorWakeTurns}, 0) + ${count}` })
          .where(eq(sessions.id, sessionId));
      }
      return count;
    });
    if (booked === null) continue;
    sessionsTouched += 1;
    turns += booked;
  }
  if (retry === 0) {
    await db.insert(appSettings).values({
      key: BACKFILL_KEY,
      value: JSON.stringify({ backfilledAt: new Date().toISOString(), sessions: sessionsTouched, turns }),
    }).onConflictDoNothing();
  }
  return { alreadyApplied: false, sessions: sessionsTouched, turns, retry };
}

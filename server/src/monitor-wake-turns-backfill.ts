// `session_turns.monitor_wake` 的一次性历史回填。
//
// 这一位是后加的:加之前开过的回合在库里一律是 0,于是老任务的「N 轮,其中哨兵唤醒 M 轮」
// 只会说 M=0。事实其实早就落过盘 —— 每次唤醒都在会话转录里留了一条带 `monitorWake` 的用户
// 回合(`conversation-turn.ts`),而那一条的时刻就是这一轮的身份(单飞回合开头按 `turnStart`
// 写它)。所以这里只按身份精确对上,对不上的不猜:回合行没了、或者时刻不是同一个,宁可少记。
//
// 判据跟写端同一份(`isMonitorWakeTurn` 落转录的条件),只升不降,重跑也是同一个结果;
// 做完记一个标记,之后启动不再扫。
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db, dbClient } from "./db/index.js";
import { appSettings, sessionTurns } from "./db/schema.js";
import { readableRunPath, sessionTranscriptPath, TURN_SENTINEL } from "./transcript.js";

const BACKFILL_KEY = "internal.monitor-wake-turns-backfill-v1";

/** 一份转录里所有哨兵唤醒回合的时刻。 */
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

export async function backfillMonitorWakeTurns(): Promise<{ alreadyApplied: boolean; sessions: number; turns: number }> {
  const marker = await db.select({ value: appSettings.value }).from(appSettings)
    .where(eq(appSettings.key, BACKFILL_KEY)).get();
  if (marker) return { alreadyApplied: true, sessions: 0, turns: 0 };

  const owners = await db.selectDistinct({ sessionId: sessionTurns.sessionId, taskId: sessionTurns.taskId })
    .from(sessionTurns);
  let sessionsTouched = 0;
  let turns = 0;
  for (const { sessionId, taskId } of owners) {
    let transcript: string;
    try {
      transcript = await readFile(readableRunPath(sessionTranscriptPath(taskId, sessionId)), "utf8");
    } catch {
      continue; // 转录没了就没有证据可回填
    }
    const starts = monitorWakeTurnStarts(transcript);
    if (!starts.length) continue;
    const updated = await dbClient.execute({
      sql: `UPDATE session_turns SET monitor_wake = 1
              WHERE session_id = :sid AND monitor_wake = 0
                AND started_at IN (SELECT value FROM json_each(:starts))`,
      args: { sid: sessionId, starts: JSON.stringify(starts) },
    });
    if (updated.rowsAffected > 0) {
      sessionsTouched += 1;
      turns += updated.rowsAffected;
    }
  }
  await db.insert(appSettings).values({
    key: BACKFILL_KEY,
    value: JSON.stringify({ backfilledAt: new Date().toISOString(), sessions: sessionsTouched, turns }),
  }).onConflictDoNothing();
  return { alreadyApplied: false, sessions: sessionsTouched, turns };
}

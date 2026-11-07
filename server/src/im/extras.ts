// 卡片上那几句要现读的事实：失败卡的出错提示、闸口卡的两份结论。只读、读不到就不写，
// 不让一次读盘失败挡住卡片本身。
import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { sessions } from "../db/schema-sessions.js";
import { shownAtGate } from "../duet/gate-version.js";
import { turnOutcome } from "../session-turns.js";
import { failedTurnNotices } from "../session-waiting.js";
import { readRecentTraceEntries } from "../transcript.js";
import type { CardExtras } from "./cards.js";
import type { TaskView } from "./attention.js";

async function failureNotice(taskId: string): Promise<string | null> {
  const session = (await db.select({ id: sessions.id, turnStartedAt: sessions.turnStartedAt }).from(sessions)
    .where(eq(sessions.taskId, taskId)).orderBy(desc(sessions.startedAt)).limit(1)).at(0);
  if (!session) return null;
  const outcome = await turnOutcome(session.id, session.turnStartedAt);
  const notices = failedTurnNotices(await readRecentTraceEntries(taskId, session.id), { turnStartedAt: session.turnStartedAt, outcome });
  return notices.at(-1)?.text ?? null;
}

/**
 * 闸口卡上的正文必须是**这张卡的版本号**那一扇门的:「放行」认的是号,正文从别的门借来就成了
 * 「看着旧方案、放行新方案」。找不到这一扇的返回 null,卡上不给「放行」(cards.ts)。
 */
async function gateConclusions(taskId: string, version: number): Promise<CardExtras["conclusions"]> {
  const shown = await shownAtGate(taskId, version);
  return shown && { a: shown.conclusionA, b: shown.conclusionB, consensus: shown.consensus };
}

export async function extrasFor(view: TaskView): Promise<CardExtras> {
  try {
    if (view.turn?.kind === "failed") return { failureNotice: await failureNotice(view.task.id) };
    if (view.turn?.kind === "duet_gate") return { conclusions: await gateConclusions(view.task.id, view.turn.version) };
  } catch (error) {
    // 文件不在 = 那一回合没留下 trace：没什么可补的，不算出错。
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[ash] 飞书卡片补充信息读取失败（${view.task.id}）:`, (error as Error).message);
      return { unread: true };
    }
  }
  return {};
}

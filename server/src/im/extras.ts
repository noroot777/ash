// 卡片上那几句要现读的事实：失败卡的出错提示、闸口卡的两份结论。只读、读不到就不写，
// 不让一次读盘失败挡住卡片本身。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { sessions } from "../db/schema-sessions.js";
import { RUNS_DIR } from "../paths.js";
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

async function gateConclusions(taskId: string): Promise<CardExtras["conclusions"]> {
  const raw = await readFile(join(RUNS_DIR, taskId, "transcript.jsonl"), "utf8");
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('.gate"')) continue;
    let row: { type?: string; open?: boolean; consensus?: boolean; conclusionA?: string | null; conclusionB?: string | null };
    try { row = JSON.parse(line); } catch { continue; }
    if ((row.type !== "duet.gate" && row.type !== "debate.gate") || row.open !== true) continue;
    return { a: row.conclusionA ?? null, b: row.conclusionB ?? null, consensus: !!row.consensus };
  }
  return null;
}

export async function extrasFor(view: TaskView): Promise<CardExtras> {
  try {
    if (view.turn?.kind === "failed") return { failureNotice: await failureNotice(view.task.id) };
    if (view.turn?.kind === "duet_gate") return { conclusions: await gateConclusions(view.task.id) };
  } catch (error) {
    // 文件不在 = 那一回合没留下 trace / 讨论还没写过 transcript：没什么可补的，不算出错。
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[ash] 飞书卡片补充信息读取失败（${view.task.id}）:`, (error as Error).message);
      return { unread: true };
    }
  }
  return {};
}

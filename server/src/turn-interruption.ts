// 一个回合**怎么断的**：给页面的那一份（shared 的 `TurnInterruption`）。
//
// 审查回合早有这件事（review-no-verdict.ts 的 `interruptionOf`，把退出码、执行故障原文、看门狗
// 判决、codex 的诊断文件归成一句人话），普通回合（续聊、自由工作流的自动修复）崩了却只剩一个
// 退出码 —— 页面上那句「这一轮异常结束」点开是「执行异常结束 · exit 1」，看不出出了什么错
// （用户 2026-11-13）。这里把同一套判法用到每一个异常结束的回合上：single-run 收口时判一次，
// 跟回合结局一起落进 `session_turns.interruption`（刷新以后从会话行带出），同时跟着结尾的
// `done` 事件播出去（直播那一路），两路是同一份。
//
// 没有诊断文件的执行器（claude 等）按 `interruptionOf` 已有的退路走：回合里报的执行故障、退出码。
import type { TurnInterruption } from "@ash/shared";
import { dbClient } from "./db/index.js";
import { interruptionOf, readTurnDiagnostics, type TurnFailure } from "./review-no-verdict.js";

/** 这一回合怎么断的。只在它**自己**异常结束时调（没被停、没被引导、结局是 failed）。 */
export function turnInterruptionOf(taskId: string, sessId: string, turnStart: string, failure: TurnFailure): TurnInterruption {
  const { reason, detail } = interruptionOf(failure, readTurnDiagnostics(taskId, sessId, turnStart));
  return { reason, detail };
}

/** 库里那一格怎么读：形状不对的一律当没有（老记录、手改过的行）。 */
function readInterruption(value: unknown): TurnInterruption | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<TurnInterruption>;
    return typeof parsed?.reason === "string" && parsed.reason && typeof parsed.detail === "string"
      ? { reason: parsed.reason, detail: parsed.detail }
      : null;
  } catch {
    return null;
  }
}

/** 一个任务名下每个断过的回合：会话 id → (回合起点 → 怎么断的)。键与 `Session.turnOutcomes` 同一套。 */
export async function turnInterruptionsForTask(taskId: string): Promise<Map<string, Record<string, TurnInterruption>>> {
  const read = await dbClient.execute({
    sql: "SELECT session_id, started_at, interruption FROM session_turns WHERE task_id = :tid AND interruption IS NOT NULL",
    args: { tid: taskId },
  });
  const bySession = new Map<string, Record<string, TurnInterruption>>();
  for (const row of read.rows) {
    const interruption = readInterruption(row.interruption);
    if (!interruption) continue;
    const sid = String(row.session_id);
    bySession.set(sid, { ...bySession.get(sid), [String(row.started_at)]: interruption });
  }
  return bySession;
}

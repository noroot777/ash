// 一个回合**怎么断的**：给页面的那一份（shared 的 `TurnInterruption`）。
//
// 审查回合早有这件事（review-no-verdict.ts 的 `interruptionOf`，把退出码、执行故障原文、看门狗
// 判决、codex 的诊断文件归成一句人话），普通回合（续聊、自由工作流的自动修复）崩了却只剩一个
// 退出码 —— 页面上那句「这一轮异常结束」点开是「执行异常结束 · exit 1」，看不出出了什么错
// （用户 2026-11-13）。这里把同一套判法用到每一个异常结束的回合上：single-run 收口时判一次，
// 跟回合结局一起落进 `session_turns.interruption`（刷新以后从会话行带出，读端是 session-turns.ts 的
// `turnFactsForTask`），同时跟着结尾的
// `done` 事件播出去（直播那一路），两路是同一份。
//
// 没有诊断文件的执行器（claude 等）按 `interruptionOf` 已有的退路走：回合里报的执行故障、退出码。
import type { TurnInterruption } from "@ash/shared";
import { interruptionOf, readTurnDiagnostics, type TurnFailure } from "./review-no-verdict.js";

/**
 * 这一回合怎么断的。只在它**自己**异常结束时调（没被停、没被引导、结局是 failed）。
 *
 * **绝不抛**：调用方正在收这一回合（落回合区间、结算任务状态都排在后面），一份说明判不出来
 * 不该把结算打断。判不出来就是没有，页面照老样子只说「这一轮异常结束」。
 */
export function turnInterruptionOf(taskId: string, sessId: string, turnStart: string, failure: TurnFailure): TurnInterruption | null {
  try {
    const { reason, detail } = interruptionOf(failure, readTurnDiagnostics(taskId, sessId, turnStart));
    return { reason, detail };
  } catch (error) {
    console.error(`[ash] turnInterruptionOf(${taskId}) failed:`, error);
    return null;
  }
}

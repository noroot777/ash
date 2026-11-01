// 「上一回合**算不算异常结束**」—— 重试入口两端共用的那一份判据。
//
// 为什么非得共一份:这个判断有两个维护点(服务端 `task-retry-turn.ts` 的 retryTurnRejection、
// 前端 `web/src/task-detail/turnRetry.ts` 的 turnRetryTarget),而它们必须说同一套话 ——
// 前端松了,按钮点下去永远 409;前端紧了,崩掉的回合一个入口都没有(那颗按钮本来就是为了补
// 这个洞才存在的)。两边各写一份 if 就是在等下一次漂开:审查 F2 要修的那一条恰恰是**同一句
// 判据在两端各错一次**(都只看退出码)。
//
// 三个信号的优先级,从高到低:
//
//   ① `stoppedAs` —— **真人按下的停止**。多数 CLI 吃 SIGTERM 后按 signal 写非零退出码,
//      光看退出码跟崩溃一模一样;停止这件事只有服务端记得下来。它不是异常结束,重投等于把
//      用户刚亲手停下的那句话再跑一遍。
//   ② `turnOutcome` —— 这一轮**自己**的权威结局(`session_turns.outcome`,服务端收口时写的)。
//      它知道的事退出码答不了:回合级停滞看门狗终止掉的那一轮,ash 判它失败、区间记 failed,
//      而被我们杀掉的进程多半以 **exit 0** 收流(claude 走信号退出时是 `code ?? 0`)。照退出码
//      判,页面明写「本次续聊因上游连不上被自动终止」的同时却一个重跑入口都没有(审查 F2,
//      已实测服务端 409、页面无按钮)。
//      **只认 failed**:续聊的闲聊回合本来就不调 complete_task,它的区间是 completed —— 跟着
//      放松就等于每次闲聊后都挂一颗「重试」。
//   ③ 退出码 —— 只在**不知道**权威结局时兜底(存量行、回合还开着、收口那一下没写成)。
import type { TurnOutcome } from "./session.ts";

export function turnEndedAbnormally(turn: {
  exitStatus: number | null;
  turnOutcome?: TurnOutcome | null;
  stoppedAs?: string | null;
}): boolean {
  if (turn.stoppedAs) return false;
  if (turn.turnOutcome) return turn.turnOutcome === "failed";
  return turn.exitStatus != null && turn.exitStatus !== 0;
}

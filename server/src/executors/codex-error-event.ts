// Codex App Server 的 `error` 通知该变成哪一种 AgentEvent —— **一处判据,主线程与子智能体
// 线程共用**。
//
// 起因(2026-10-30,任务 W54czudPJ9Q9 的修复回合):同一个字段 `willRetry` 在两条路上被当成
// 两件事,而两条路都错在不同方向上 ——
//   · 主线程(`codex-app-server.ts`)把 `willRetry:true` **整条丢掉**。中转主机整体离线那次,
//     这一支连报了 216 条「Reconnecting... waiting for network」、历时 4 小时 45 分,ash 侧
//     一个事件都没有:界面全程 running、零报错,只能人工翻 jsonl 才看得出来。
//   · 子智能体线程(`native-agent-activity.ts`)压根不看 `willRetry`,一律抬成**裸 error**。
//     同一场重连风暴在那条路上是反方向的毛病:几百条红色「执行异常」,而且每一条都会把这
//     一轮判成有执行故障(`sawExecutionError`),明明它只是在重试。
//
// 所以两条路合到这一份:**重试中 = `level:"notice"`**(回合仍然正常进行中,跟成败正交,见
// `../session-notice.ts` 顶部),**重试完了还是错 = 裸 error**。前者由回合级停滞看门狗
// (`../turn-stall.ts`)负责「等到该动手了没有」,这里只负责如实说出来。
import type { AgentEvent } from "@ash/shared";
import { codexTurnError } from "./model-failure.js";

export interface CodexErrorNotification {
  willRetry?: unknown;
  error?: { message?: unknown } | null;
}

export interface CodexErrorEvent {
  event: Extract<AgentEvent, { kind: "error" }>;
  /**
   * 进不进 `structuredErrors`(收尾诊断里那一篮「这一轮报过哪些错」)。
   *
   * 重试中的那些**不进**:它们不是这一轮的失败原因,混进去只会让收尾诊断把一次成功的回合
   * 描述成报了两百次错。真要查重连历史,trace 里逐条都在。
   */
  counted: boolean;
}

/** `null` = 这条通知没有可读的错误文本,什么都不该发。 */
export function codexErrorEvent(p: CodexErrorNotification): CodexErrorEvent | null {
  const message = p.error?.message;
  if (typeof message !== "string" || !message) return null;
  // 不限流:重连间隔由上游定,实测那 220 条最密也隔 27 秒、中位数 80 秒(不存在刷屏),而
  // 压条数会让「已重试 N 次」这个数字失真 —— 它正是看门狗的判据。连环刷起来由看门狗熔断。
  if (p.willRetry) {
    return { event: { kind: "error", message, level: "notice", affectsTurn: false }, counted: false };
  }
  // 重试完了还是错：这就是这一轮对模型那次请求的结局，认得出类型就挂上（model-failure.ts）。
  return { event: codexTurnError(message), counted: true };
}

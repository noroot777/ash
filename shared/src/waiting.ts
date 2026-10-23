// 「这一轮此刻还在等上游吗」——**解除条件**的共同判据。
//
// 为什么要共一份:这一位有三个维护点(服务端 `session-waiting.ts`、讨论那条链的
// `duetState.ts`、普通任务的分段归约),各自内联一张事件表的话,新增一种事件时只会改到一处,
// 而三处答案不一致,用户看到的就是同一次重试在三个表面上一个说还在等、一个说早就好了
// (2026-10-21 第 3 轮审查 F2 要治的正是这种分叉)。
//
// 普通任务那一路拿到的是已经归一成展示行的 `ExecutionEvent`(其中只有 `notice` 一种代表
// 等待),所以它只需要一行判断,口径跟这里天然一致。
import type { AgentEvent } from "./events.ts";

/** 收到这些事件 = 上游接着往下走了。 */
const RESUMES: ReadonlySet<AgentEvent["kind"]> = new Set<AgentEvent["kind"]>([
  "text", "thinking", "tool", "attachment", "usage", "turnEnd", "done",
]);

/**
 * 这条事件一到,在等的那几条过程提示就该解除。
 *
 * `level:"notice"` 的 error 是**提示本身**(上游在重试),它只会把等待置上;其余 error 是真
 * 故障 —— 这一轮同样不再「在等」了,它另有去处(红色诊断块 / 失败结局)。
 * `session` / `context` / `system` 不算:换 thread id、上下文水位、会话旁注都不是上游在回话。
 */
export function resumesWaiting(event: AgentEvent): boolean {
  if (event.kind === "error") return event.level !== "notice";
  return RESUMES.has(event.kind);
}

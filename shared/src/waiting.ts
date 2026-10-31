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
import type { NativeWorkEvent } from "./native-work.ts";

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

/** 子智能体**干完了**(或没干成):这一位本身就证明上游在工作。 */
const SETTLED: ReadonlySet<string> = new Set(["completed", "failed", "stopped"]);

/**
 * 这条事件里**有没有上游新产出** —— 比 `resumesWaiting` 更严的一问,给回合级停滞看门狗
 * (`server/src/turn-stall.ts`)用:它要判的不是「还显不显示在等」,而是「上游到底有没有回话」。
 *
 * 两者分家的理由是**包装**:原生子智能体的那套事件一律包成 `kind:"tool"`(见
 * `native-work.ts` 的 `event()`),照 `resumesWaiting` 判就等于「子线程有任何动静都算进展」,
 * 连一条「仍在运行」的心跳都能把停滞解除。所以包装一律穿透到底,认里面那条:
 *
 *   · `activity` —— 子线程的正文/思考/工具/附件算产出;里面那条 `error` 不算(它正是停滞本身)。
 *   · `call` / `result` —— 真实的工具调用与结果。
 *   · `agent` —— **只有身份或状态、没有新工作的通知不算**:生产点标了 `heartbeat` 的那些,
 *     以及只带 model/effort/title(status 还是 unknown)的身份通知。带新正文、带完成结果、
 *     或者报出终态的才算。
 *
 * 裸事件(没有包装)沿用 `resumesWaiting`:那一层的 `session`/`context`/`system` 同样不算
 * 上游回话(审查第 2 轮 F1)。
 */
export function producesWork(event: AgentEvent): boolean {
  // 包装只挂在 `kind:"tool"` 这一个变体上(见 events.ts)。
  const work: NativeWorkEvent | undefined = event.kind === "tool" ? event.nativeWork : undefined;
  if (!work) return resumesWaiting(event);
  if (work.type === "activity") {
    const inner = work.event;
    return inner.kind === "text" || inner.kind === "thinking" || inner.kind === "tool" || inner.kind === "attachment";
  }
  if (work.type === "call" || work.type === "result") return true;
  if (work.heartbeat) return false;
  return !!work.result || !!work.message || SETTLED.has(work.status);
}

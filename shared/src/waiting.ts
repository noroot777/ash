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

/**
 * 这条事件里**有没有上游新产出** —— 比 `resumesWaiting` 更严的一问,给回合级停滞看门狗
 * (`server/src/turn-stall.ts`)用:它要判的不是「还显不显示在等」,而是「上游到底有没有回话」。
 *
 * 两者分家的理由是**包装**:原生子智能体的那套事件一律包成 `kind:"tool"`(见
 * `native-work.ts` 的 `event()`),照 `resumesWaiting` 判就等于「子线程有任何动静都算进展」,
 * 连一条「仍在运行」的心跳都能解除停滞(审查 F1,已实测 3655 条心跳 / 369 秒,警告与熔断
 * 双双为 0)。所以包装一律穿透到底,按**那一类包装本职装什么**认:
 *
 *   · `activity` —— 子线程**自己产出**的正文/思考/工具/附件,算;里面那条 `error` 不算
 *     (它正是停滞本身)。
 *   · `call` / `result` —— 真实的工具调用与结果,算。
 *   · `agent` —— **一律不算**。这一类压根不是产出的载体,它是**状态投影**:驱动侧栏/抽屉
 *     那张子智能体卡片的身份、档位与进度。同一份判断早就写在 `isVisibleExecutionEvent` 里
 *     (只有顶层 `call` 算执行过程里的一步,`agent` 连主执行过程都不进)。
 *
 *     **真产出不会因此被漏掉**:生产那一侧对同一条原始通知是**成对 push** 的 —— claude 走
 *     `NativeWorkTrace.claudeMessage`(先 `childActivity.message(ev)` 收 activity,再 push
 *     这张卡片),codex 走 `codex-app-server.ts` 的子线程分支(先
 *     `childEvents.notification(...)`,再 `codexChildWork(...)`)。子线程真说了话,activity
 *     那一条自己就算产出了。
 *
 *     反过来,只有卡片、没有 activity 的那几种(claude 的 task_started/task_progress 心跳、
 *     `nativeAgentProfile` 的档位通知、codex 的 turn/started、子智能体完成通知)**本来就不是
 *     「这一轮的上游回话了」** —— 主线程仍然一个字都没拿到。
 *
 * 为什么不是「看 message/result 非空」那种结构判据:到了包装这一层,一条心跳和一条子线程
 * 真说了话长得一模一样(都是 `status:"running"` + `message`,真实 claude 心跳的 message 装
 * 的是 `last_tool_name`)。靠结构猜就得逐个生产点打补丁,新增一个就又漏一个;按本职认只需
 * 这一句,9 个生产点全都盖得住。
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
  return work.type === "call" || work.type === "result";
}

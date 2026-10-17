import type { AgentEvent } from "@ash/shared";
import { bus } from "../bus.js";
import { now } from "../util.js";
import { appendSessionTrace, writeTurn, writeRunError } from "../transcript.js";
import type { SessionTraceEvent } from "../transcript.js";
import { noteAgentEventUpload } from "../uploads.js";
import type { Lead } from "./session-types.js";

// 一台调度台**对外说话的三个出口**：实时 SSE（`publish`）、执行过程面板（`traceLead`）、
// 以及会话正文 `.md`（`writeTurn` / `writeRunError`）。
//
// 从 `session-consumer.ts` 拆出来的原因：那份加到 703 行、过了单文件上限（根 CLAUDE.md）,
// 而这几个函数自成一件事——它们只认 `lead` 自己的那块牌子,不碰消费循环的任何状态
// （leads、待送队列、轮换状态都不在这里）。消费那边原样再导出 `recordSystemTurn` /
// `reportLeadFailure`,`session.ts` 的调用点照旧。
//
// **一条共同的规矩：摘牌之后一个字都不许再说。**那条 sessionId 现在归接管的那台调度台,
// 用户正看着它说话；旧进程晚到的事件插进去,看起来就是新会话出了事（见 retireLead）。

export function publish(lead: Lead, event: AgentEvent): void {
  // 摘牌后一个字都不再广播:这条 sessionId 现在归接管的那台,用户正看着它说话,
  // 收到旧进程的「执行异常结束/意外退出」只会当成新会话出了事(见 retireLead)。
  if (lead.retired) return;
  bus.publish({
    type: "agent.event",
    taskId: lead.taskId,
    sessionId: lead.sessId,
    role: "lead",
    agentType: lead.agentType,
    model: lead.model,
    reasoningEffort: lead.reasoningEffort,
    event,
  });
}

// 执行过程面板那条流。跟 publish / lead.out 同一块牌子:摘牌之后这条 sessId 的 trace
// 归接管的那台,旧进程晚到的事件不许再插进去(见 retireLead)。
export function traceLead(lead: Lead, turnStart: string, event: SessionTraceEvent, at?: string): void {
  if (lead.retired) return;
  // agent 产出的图归这个任务(uploads.ts)。单飞那条链的同一处在 single-run.ts 的
  // persistTrace —— 两条链各走各的 trace 写入,改一处记得看另一处。
  noteAgentEventUpload(lead.taskId, event);
  appendSessionTrace(lead.taskId, lead.sessId, turnStart, event, at);
}

// 收尾链上的持久化失败:如实落到三处(.md / trace / SSE),然后**咽回去**。
//
// 常驻调度台跟一次性任务不一样 —— 它的每一次写库都跑在 consume 那条 for-await 里面。
// 抛出去掀掉的不是一个回合,是整台调度台:closeLead 再也不会跑,于是 leads 里留着一台
// 没人消费事件的**假在线**调度台(后续消息照送进去,一个字都不落盘也不广播),任务永远
// 停在 running,攒下的轮换旁注烂在内存里 —— 只能靠重启恢复(2026-08-25 第 2 轮审查)。
// 一次写库失败该丢的只是那一行状态,不是这台调度台。
export function reportLeadFailure(lead: Lead, message: string, at = now()): void {
  writeRunError(lead.out, message);
  traceLead(lead, lead.turnStart ?? at, { kind: "error", message }, at);
  publish(lead, { kind: "error", message });
}

// 入站消息(执行者汇报/提问、系统提示)记成 system turn:实时走 system 事件、
// 刷新走 .md 的哨兵行,两边长得一样。
export function recordSystemTurn(lead: Lead, text: string, at = now()): void {
  writeTurn(lead.out, { t: "system", agent: lead.agentType, text }, at);
  publish(lead, { kind: "system", text, at });
}

// 会话轮换旁注:实时立刻播(用户正看着),落盘等 writeTurnEnd 之后由 flushSessionNotices
// 补 —— 理由见 Lead.notices。摘牌之后一句都不再说:那条会话现在归接管的那台,这台既不
// 该广播,攒下的也没有能落盘的地方(见 retireLead)。
export function noteSessionNotice(lead: Lead, text: string, at = now(), level?: "notice"): void {
  if (lead.retired) return;
  lead.notices.push({ text, at, level });
  publish(lead, { kind: "system", text, at, ...(level ? { level } : {}) });
}

export function flushSessionNotices(lead: Lead): void {
  const notices = lead.notices;
  lead.notices = [];
  for (const notice of notices) {
    writeTurn(lead.out, { t: "system", agent: lead.agentType, text: notice.text, level: notice.level }, notice.at);
  }
}

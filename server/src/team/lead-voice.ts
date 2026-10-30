import type { AgentEvent } from "@ash/shared";
import { bus } from "../bus.js";
import { now } from "../util.js";
import { appendSessionTrace, writeTurn, writeRunError } from "../transcript.js";
import type { SessionTraceEvent } from "../transcript.js";
import { noteAgentEventUpload } from "../uploads.js";
import type { Lead } from "./session-types.js";
import type { StallActions } from "../turn-stall.js";
import { clearSessionStalled, markSessionStalled } from "../session-stall-flag.js";

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

/**
 * 回合级停滞看门狗的**这一路的那几件动作**(判据与各档阈值在 ../turn-stall.ts,三条消费链共用)。
 *
 * 挂在这儿而不是消费循环里,因为它正好就是上面那三个出口的组合 —— SSE + 执行过程 + `.md`。
 *
 * 调度台跟单飞有两处本质不同:
 *
 * ① 它是**常驻**的,一个进程吃很多回合。所以熔断先只终止**卡住的这一轮**(`interrupt`),不收
 *    整台 —— 回合收口后这台落回待命,用户插话和执行者汇报照常能把下一轮投进去。
 *
 * ② 正因为是请求式终止,**它可能根本不生效**:`ResidentHandle.interrupt()` 只是往 stdin 写一行
 *    请求,没有 ACK、不等回合结束、也没有强杀退路(`executors/claude.ts`)。所以这一路必须实现
 *    `escalate` —— 看门狗给足宽限期后回收整台。回收前先 `releasePending`:排着的入站消息有 seq
 *    的留在 `team_inbound` 等下一台认领、只有内存副本的交给进程内最后一档,一条都不跟着这台
 *    一起没(见 team/pending-inbox.ts)。进程一没,事件流结束 → `closeLead` 走正常的失败收尾,
 *    「CLI 会话还在、再说一句话就接回」那条路照旧(第 1 轮审查第 4 条)。
 *
 * **本轮区间的结局不再是无条件 `completed`**:熔断前看门狗已经把「这一轮失败」钉在回合身份上
 * (../turn-stall-verdict.ts),`endTurn` 与 `closeLead` 各自读它。从前那一版只在时间线上红着说一句
 * 「已按失败结算」,而区间记 `completed`、任务落 `done` —— 看门狗说过的话一句都没兑现
 * (第 1 轮审查第 2 条,已实测)。
 */
export function leadStallActions(
  lead: Lead,
  trace: (event: SessionTraceEvent) => void,
  releasePending: (lead: Lead) => void,
): StallActions {
  // 熔断与兜底都走同一个出口组合:红色诊断进执行过程 + `.md` + SSE。
  const diagnose = (text: string): void => {
    const event: AgentEvent = { kind: "error", message: text };
    trace(event);
    writeRunError(lead.out, text);
    publish(lead, event);
  };
  return {
    taskId: lead.taskId,
    warn: (text, facts) => {
      const event: AgentEvent = { kind: "error", message: text, level: "notice", affectsTurn: false };
      trace(event);
      publish(lead, event);
      // 摘过牌的台连这一笔都不写:这条 sessionId 现在归接管的那台,旧进程的倒计时把标记写上去
      // 就是在用户正看着的新会话上凭空亮一个红环(第 1 轮审查第 5 条)。原先这道闸靠库里那次
      // 回合 CAS,而回合身份挡不住「投入≠执行中」那一类(第 3 轮审查 F2),所以挪回所有权层 ——
      // trace / publish 本来就按同一块牌子办(见本文件顶部)。
      // **撤那一笔不加这道闸**:`retireLead` 先置 `retired` 再 `clearTurnStall`,加了就永远撤不掉;
      // 而撤是按停滞自己那一刻比对的,只碰得到自己置上的那一个(见 session-stall-flag.ts)。
      if (!lead.retired) markSessionStalled(lead.taskId, lead.sessId, facts.since);
    },
    trip: (text) => {
      diagnose(text);
      lead.handle.interrupt();
    },
    escalate: (text) => {
      diagnose(text);
      releasePending(lead);
      lead.handle.kill();
    },
    resolve: (facts) => clearSessionStalled(lead.taskId, lead.sessId, facts.since),
  };
}

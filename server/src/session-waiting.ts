// 窄出口(`GET /sessions/:id/notices`)的模型。它要回答的只有一句话:**这条会话此刻有没有
// 卡在一条过程提示上**(上游在重试、还在等回话)。读不动整份 trace 的消费者靠它活着 ——
// 手机端每几秒拉一次,而 trace 连工具的完整输入输出一起落盘,最大的一份 8 MB。
//
// 这里是**两种投影**,刻意不合成一个:
//
// ① 此刻还在等(`sessionWaiting`)—— 只在内存里,由事件消费链顺序维护。为什么不能从落盘
//    产物反推:正文先写 `.md`,要到下一条非正文事件才冲进 trace(single-run 与 team 的
//    pendingTraceText 都是这个缓冲),于是照 trace 判就会在整段恢复回答期间一直说「正在
//    重试」,而用户手机上明明已经在读那段回答了(第 3 轮审查 F2)。事件到达那一刻这件事
//    是确定的:提示来了就是在等,下一条有效输出来了就不是了。代价说在明处 —— ash 重启后
//    内存里这份没了,在飞的那一轮回空;等待是转瞬状态,宁可不显示也不该靠猜。
//
// ② 失败现场(`failedTurnNotices`)—— 从 trace 回放,因为它要活过刷新和重启。判据是
//    「**这一轮**有没有明确的失败结局」,**不是「进程退没退」**(见函数自己的注释)。
import type { AgentEvent, SessionNotice } from "@ash/shared";
import { resumesWaiting } from "@ash/shared/waiting";
import { isExecutionNotice } from "./session-notice.js";
import type { TurnOutcome } from "./session-turns.js";
import type { SessionTraceEntry } from "./transcript.js";
import { now } from "./util.js";

// 一条会话上最多留这么多条(只留最近的)。上游连环重试能刷出几十条,而这个出口要答的是
// 「现在卡住了没有」,不是完整流水 —— 完整流水在 trace 自己那份里。
const NOTICE_LIMIT = 50;

/**
 * 等待状态的**持有者**:此刻在维护它的那一个消费者实例本身(单飞的进程 handle、调度台的
 * lead、duet 的 handle)。只比身份,不读内容。
 *
 * 为什么必须带上它:**一条会话行会被换台复用** —— team 的 attachLead 把旧进程摘牌、新进程
 * 接着写同一行同一个 `.md`,而旧进程的事件流还在往外吐。它迟到的一条正文、一次收尾,都会把
 * 新进程刚置上的等待状态删掉,手机上那句「正在重试」凭空消失(第 4 轮审查 F2,已实测)。落盘
 * 产物早有 `retireLead` 那道所有权闸,内存这一份当时在闸外面。
 *
 * 规矩只有一条:**只有持有者改得动、撤得掉**。新提示算重新认领(换台之后由新消费者接手这条
 * 会话的等待状态),其余一律要求身份相符。
 */
export type WaitingOwner = object;

type Waiting = { owner: WaitingOwner; turnStartedAt: string; notices: SessionNotice[] };
const waiting = new Map<string, Waiting>();

/**
 * 事件消费链上的每一条 agent 事件都过这里:过程提示置上,随后任何有效输出置回。
 *
 * `turnStartedAt` 给 null = 这一刻还没有回合身份(自发回合的第一条事件之前):提示照旧不记
 * —— 它在执行过程里也没有落点,记下来只会挂在一个与它无关的回合名下。
 */
export function trackSessionWaiting(
  sessionId: string,
  owner: WaitingOwner,
  turnStartedAt: string | null,
  event: AgentEvent,
): void {
  const held = waiting.get(sessionId);
  if (event.kind === "error" && isExecutionNotice(event)) {
    if (!turnStartedAt) return;
    // 同一个持有者的同一轮才接着往后攒;换台或换轮都从这一条重新起(认领见 WaitingOwner)。
    const kept = held && held.owner === owner && held.turnStartedAt === turnStartedAt ? held.notices : [];
    waiting.set(sessionId, {
      owner,
      turnStartedAt,
      notices: [...kept, { at: now(), turnStartedAt, text: event.message }].slice(-NOTICE_LIMIT),
    });
    return;
  }
  if (!held || held.owner !== owner) return; // 不是持有者:迟到的旧台输出无权解除别人的等待
  // 解除条件共用 shared 那一份(真故障也算解除:这一轮不再「在等」了,它另有去处)。
  if (resumesWaiting(event)) waiting.delete(sessionId);
}

/**
 * 这条会话收尾/换台了:**自己持有的**那份等待状态跟着作废(回合收口由 turnEnd 事件自己带到)。
 *
 * 身份不符就是空转 —— 被接管的旧台收尾时会走到这里,那一刻这条会话的等待状态已经归新台了。
 */
export function clearSessionWaiting(sessionId: string, owner: WaitingOwner): void {
  if (waiting.get(sessionId)?.owner === owner) waiting.delete(sessionId);
}

/**
 * 这条会话此刻还在等的那几条提示。`turnStartedAt` 传会话行上的当前回合:不一致就当没有
 * —— 上一轮崩在半路(没有 turnEnd、没有 done)时内存里那份会留着,它不该成为新回合的状态。
 */
export function sessionWaiting(sessionId: string, turnStartedAt?: string | null): SessionNotice[] {
  const held = waiting.get(sessionId);
  if (!held) return [];
  if (turnStartedAt && held.turnStartedAt !== turnStartedAt) return [];
  return held.notices;
}

/**
 * 这一轮的结局够不够格回放失败现场 —— **只有「明确失败」算**。
 *
 * `null`/`undefined` = 不知道(存量行、回合还开着、收口那一下没写成):一律不回放。宁可少说
 * 一句,也不能把一轮没失败的回合挂上失败现场 —— 那正是用户那句「不是最终导致整个会话失败就
 * 没必要显示在会话结尾处」。
 *
 * 判据只有这一份:窄出口拿它决定要不要读盘(`task-session-routes.ts`),下面的回放本体再问一次
 * 同一个函数。
 */
export const replaysFailureScene = (outcome: TurnOutcome | null | undefined): boolean => outcome === "failed";

/**
 * 这一轮**真的收在失败上**时,它的过程提示 —— 失败现场。
 *
 * 用户的原话是「如果不是最终导致整个会话失败、本条命令执行成功了,就没必要显示在会话结尾
 * 处」,所以反过来:真失败时这几句话就是现场,必须照给,而且要活过刷新,因此只能从 trace 读。
 *
 * 判据是**这一个回合自己的结局**(`session_turns.outcome`,收口那一刻由结算处落下),
 * **不是进程最后一次怎么没的**。为什么必须是回合而不是进程:常驻调度台一个进程跑很多回合,
 * 每一轮健康 `endTurn` 收口、进程继续待命,后来空闲时才以非零码退出 —— 拿退出码当证明,
 * 那台答完待命的调度台就会在手机上重新挂出上一轮(明明已经成功答完那一轮)的「正在重试」
 * (第 3 轮审查 F1 只补了 `exitStatus === null` 这一档、第 4 轮补了受控停止,第 5 轮审查 F3
 * 实测仍能复现:健康 `turnEnd` 之后让待命进程 `done(exitStatus:1)`,这个出口从 0 条变 1 条)。
 * 反方向同样靠它才对:`exit 0` 却中途报过执行故障的那一轮(单飞的判据是「非零退出**或**
 * sawExecutionError」),从前一条现场都给不出。
 *
 * 进程自身怎么没的仍然单列在会话行上(`exit_status` / `stopped_as`,重试门禁读它),两件事不混。
 */
export function failedTurnNotices(
  entries: SessionTraceEntry[],
  settled: { turnStartedAt?: string | null; outcome: TurnOutcome | null },
): SessionNotice[] {
  const turn = settled.turnStartedAt;
  if (!turn) return [];
  if (!replaysFailureScene(settled.outcome)) return [];
  const out: SessionNotice[] = [];
  for (const entry of entries) {
    if (entry.turnStartedAt !== turn) continue;
    const event = entry.event;
    if (event.kind !== "error" || !isExecutionNotice(event)) continue;
    out.push({ at: entry.at, turnStartedAt: entry.turnStartedAt, text: event.message });
  }
  return out.slice(-NOTICE_LIMIT);
}
